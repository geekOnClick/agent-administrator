import fs from 'fs';
import JSZip from 'jszip';
import { getBillsLedgerGraph, closeFalkorDb } from './falkordb-connection.js';
import { embed, embedOne } from './embeddings.js';
import { BillCategory, BILL_CATEGORY_LABELS } from '../../llm/prompts.js';
import {
  parseAmount,
  parseMonthLabel,
  extractLastTable,
  extractRows,
  extractCells,
  extractCellTexts
} from '../docx/table-xml-utils.js';
import type { TableReadStats } from '../../observability/types.js';

/**
 * Порядок столбцов (после столбца с месяцем) в таблице учёта коммунальных
 * платежей файла "Администрирование_2_0.docx":
 * месяц | теплоэнергия | электроэнергия | содержание помещения | водоканал | вывоз мусора
 */
export const COLUMN_CATEGORY_ORDER: BillCategory[] = ['heat', 'electricity', 'maintenance', 'water', 'garbage'];

export interface BillsLedgerRow {
  /** наименование месяца, например "Август 2026" */
  month: string;
  amounts: Partial<Record<BillCategory, number>>;
}

export interface ReadLedgerRowsResult {
  rows: BillsLedgerRow[];
  stats: TableReadStats;
}

/**
 * Сервис актуализации векторной базы знаний (FalkorDB) данными из таблицы
 * учёта коммунальных платежей и поиска по ней по смыслу.
 */
export class BillsLedgerVectorService {
  /** Считывает все строки последней таблицы .docx (кроме заголовка) в структурированный вид.
   * Возвращает строки и статистику парсинга для оценки качества (метрика SM-7). */
  async readLedgerRows(docPath: string): Promise<ReadLedgerRowsResult> {
    if (!fs.existsSync(docPath)) {
      throw new Error(`Файл таблицы учёта не найден: ${docPath}`);
    }

    const buffer = fs.readFileSync(docPath);
    const zip = await JSZip.loadAsync(buffer);
    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) {
      throw new Error('В .docx-файле не найден word/document.xml.');
    }

    const documentXml = await documentXmlFile.async('string');
    const { table } = extractLastTable(documentXml);
    const rows = extractRows(table);

    const dataRows = rows.slice(1); // первая строка — заголовок с названиями категорий
    const ledgerRows: BillsLedgerRow[] = [];

    const stats: TableReadStats = {
      totalRows: dataRows.length,
      skippedInvalidMonth: 0,
      skippedInvalidAmount: 0,
      emptyAmountRows: 0,
      parsedRows: 0
    };

    for (const rowXml of dataRows) {
      const cells = extractCells(rowXml);
      if (cells.length < COLUMN_CATEGORY_ORDER.length + 1) {
        stats.skippedInvalidMonth += 1;
        continue;
      }

      const monthTexts = extractCellTexts(cells[0]);
      const month = (monthTexts[0] || '').trim();

      // Проверяем, что месяц распознаётся в ожидаемом формате (напр., "Август 2026").
      if (!month || !parseMonthLabel(month)) {
        console.warn(
          `[TableRead] Пропущена строка с нераспознанным месяцем: "${month || '(\u043fусто)'}" — файл: ${docPath}`
        );
        stats.skippedInvalidMonth += 1;
        continue;
      }

      const amounts: Partial<Record<BillCategory, number>> = {};
      let invalidAmountCount = 0;

      for (let i = 0; i < COLUMN_CATEGORY_ORDER.length; i++) {
        const category = COLUMN_CATEGORY_ORDER[i];
        const texts = extractCellTexts(cells[i + 1]);
        const raw = texts.join('').trim();
        if (!raw) continue; // пустая ячейка — нормально, не считается ошибкой
        const amount = parseAmount(raw);
        if (amount === null || !Number.isFinite(amount)) {
          console.warn(
            `[TableRead] Невалидная сумма в ячейке ${category} месяца "${month}": "${raw}" — ячейка пропущена.`
          );
          invalidAmountCount += 1;
          continue;
        }
        amounts[category] = amount;
      }

      if (invalidAmountCount > 0) {
        stats.skippedInvalidAmount += invalidAmountCount;
      }

      const hasAnyAmount = Object.keys(amounts).length > 0;
      if (!hasAnyAmount) {
        stats.emptyAmountRows += 1;
      }

      ledgerRows.push({ month, amounts });
      stats.parsedRows += 1;
    }

    return { rows: ledgerRows, stats };
  }

  /** Формирует текстовое представление строки таблицы для векторизации (чтобы поиск по смыслу работал как с категориями, так и с суммами/месяцами). */
  private rowToText(row: BillsLedgerRow): string {
    const parts = [`Месяц: ${row.month}.`];
    for (const category of COLUMN_CATEGORY_ORDER) {
      const amount = row.amounts[category];
      const label = BILL_CATEGORY_LABELS[category] || category;
      parts.push(`${label}: ${typeof amount === 'number' ? `${amount.toFixed(2)} руб.` : 'нет данных'}.`);
    }
    return parts.join(' ');
  }

  /**
   * Перестраивает векторный индекс полностью на основе актуального содержимого docx-таблицы.
   * Вызывается после каждого успешного дозаполнения таблицы (DocxBillsTableService),
   * чтобы база знаний всегда содержала актуальные данные.
   */
  async syncLedgerToVectorStore(docPath: string): Promise<{ rowsIndexed: number; stats: TableReadStats }> {
    const { rows, stats } = await this.readLedgerRows(docPath);
    if (rows.length === 0) {
      return { rowsIndexed: 0, stats };
    }

    const graph = await getBillsLedgerGraph();

    await graph.query('MATCH (n:BillRow) DETACH DELETE n');
    try {
      await graph.query('DROP VECTOR INDEX FOR (b:BillRow) ON (b.embedding)');
    } catch {
      // индекса ещё не было — ок
    }

    const texts = rows.map((r) => this.rowToText(r));
    const vectors = await embed(texts);
    const dim = vectors[0].length;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      await graph.query(
        `CREATE (b:BillRow {
          month: $month,
          heat: $heat,
          electricity: $electricity,
          maintenance: $maintenance,
          water: $water,
          garbage: $garbage,
          text: $text,
          embedding: vecf32($vec)
        })`,
        {
          params: {
            month: row.month,
            heat: row.amounts.heat ?? null,
            electricity: row.amounts.electricity ?? null,
            maintenance: row.amounts.maintenance ?? null,
            water: row.amounts.water ?? null,
            garbage: row.amounts.garbage ?? null,
            text: texts[i],
            vec: vectors[i]
          }
        }
      );
    }

    await graph.query(
      `CREATE VECTOR INDEX FOR (b:BillRow) ON (b.embedding) OPTIONS {dimension:${dim}, similarityFunction:'cosine', M:16, efConstruction:200}`
    );

    return { rowsIndexed: rows.length, stats };
  }

  /**
   * Возвращает все строки таблицы учёта, хранящиеся в векторной базе (FalkorDB),
   * без ограничения top-k и без семантического ранжирования. Используется там,
   * где нужны точные данные (например, отчёт за период), а не смысловой поиск.
   */
  async getAllRows(): Promise<BillsLedgerRow[]> {
    const graph = await getBillsLedgerGraph();

    const res = await graph.roQuery(
      `MATCH (n:BillRow)
       RETURN n.month AS month, n.heat AS heat, n.electricity AS electricity,
              n.maintenance AS maintenance, n.water AS water, n.garbage AS garbage`
    );

    const rows = (res.data ?? []) as unknown as Array<{
      month: string;
      heat: number | null;
      electricity: number | null;
      maintenance: number | null;
      water: number | null;
      garbage: number | null;
    }>;

    return rows.map((r) => ({
      month: r.month,
      amounts: {
        heat: r.heat ?? undefined,
        electricity: r.electricity ?? undefined,
        maintenance: r.maintenance ?? undefined,
        water: r.water ?? undefined,
        garbage: r.garbage ?? undefined
      }
    }));
  }

  /** Векторный поиск по таблице учёта по произвольному пользовательскому запросу. */
  async search(query: string, k = 5): Promise<Array<BillsLedgerRow & { similarity: number }>> {
    const graph = await getBillsLedgerGraph();
    const vec = await embedOne(query);

    const res = await graph.roQuery(
      `CALL db.idx.vector.queryNodes('BillRow', 'embedding', $k, vecf32($vec))
       YIELD node, score
       RETURN node.month AS month, node.heat AS heat, node.electricity AS electricity,
              node.maintenance AS maintenance, node.water AS water, node.garbage AS garbage,
              score
       ORDER BY score ASC`,
      { params: { k, vec } }
    );

    const rows = (res.data ?? []) as unknown as Array<{
      month: string;
      heat: number | null;
      electricity: number | null;
      maintenance: number | null;
      water: number | null;
      garbage: number | null;
      score: number;
    }>;

    return rows.map((r) => ({
      month: r.month,
      amounts: {
        heat: r.heat ?? undefined,
        electricity: r.electricity ?? undefined,
        maintenance: r.maintenance ?? undefined,
        water: r.water ?? undefined,
        garbage: r.garbage ?? undefined
      },
      similarity: 1 - r.score
    }));
  }

  /** Формирует текстовый контекст из результатов поиска для передачи в модель при ответе на вопрос. */
  formatSearchContext(rows: Array<BillsLedgerRow & { similarity: number }>): string {
    if (rows.length === 0) {
      return 'В таблице учёта не найдено подходящих строк.';
    }
    return rows.map((r) => this.rowToText(r)).join('\n');
  }

  async close(): Promise<void> {
    await closeFalkorDb();
  }
}

export const billsLedgerVectorService = new BillsLedgerVectorService();
