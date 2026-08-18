import fs from 'fs';
import JSZip from 'jszip';
import { getBillsLedgerGraph, closeFalkorDb } from './falkordb-connection.js';
import { embed, embedOne } from './embeddings.js';
import {
  extractLastTable,
  extractRows,
  extractCells,
  extractCellTexts,
  formatShortDateHuman
} from '../docx/table-xml-utils.js';

export type MeterType = 'electricity' | 'water';

export const METER_TYPE_LABELS: Record<MeterType, string> = {
  electricity: 'электроэнергия',
  water: 'водоканал'
};

export interface MeterRow {
  /** тип счётчика: электроэнергия или водоканал */
  meterType: MeterType;
  /** дата показания в исходном виде из таблицы, например "19.07.26" */
  date: string;
  /** показание счётчика (строка цифр, как в таблице, могут быть ведущие нули) */
  value: string;
}

/**
 * Сервис актуализации векторной базы знаний (FalkorDB) данными из таблиц
 * показаний счётчиков ("электроэнергия.docx", "водоканал.docx") и семантического
 * поиска по нит. Аналогичен BillsLedgerVectorService, но использует отдельный тип узла (:MeterRow),
 * чтобы не пересекаться с данными таблицы коммунальных платежей.
 */
export class MetersVectorService {
  /** Считывает все строки последней таблицы .docx (кроме заголовка) в структурированный вид. */
  async readMeterRows(docPath: string, meterType: MeterType): Promise<MeterRow[]> {
    if (!fs.existsSync(docPath)) {
      throw new Error(`Файл таблицы показаний счётчика не найден: ${docPath}`);
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

    const dataRows = rows.slice(1); // первая строка — заголовок "Дата | Показания"
    const meterRows: MeterRow[] = [];

    for (const rowXml of dataRows) {
      const cells = extractCells(rowXml);
      if (cells.length < 2) continue;

      const date = (extractCellTexts(cells[0]).join('') || '').trim();
      const value = (extractCellTexts(cells[1]).join('') || '').trim();
      if (!date || !value) continue;

      meterRows.push({ meterType, date, value });
    }

    return meterRows;
  }

  /** Формирует текстовое представление строки таблицы для векторизации. */
  private rowToText(row: MeterRow): string {
    const label = METER_TYPE_LABELS[row.meterType] || row.meterType;
    const humanDate = formatShortDateHuman(row.date);
    return `Счётчик: ${label}. Дата показания: ${row.date} (${humanDate}). Показание: ${row.value}.`;
  }

  /**
   * Перестраивает векторный индекс показаний счётчиков полностью на основе актуального
   * содержимого двух docx-таблиц (электроэнергия + водоканал).
   */
  async syncMetersToVectorStore(electricityDocPath: string, waterDocPath: string): Promise<{ rowsIndexed: number }> {
    const [electricityRows, waterRows] = await Promise.all([
      this.readMeterRows(electricityDocPath, 'electricity'),
      this.readMeterRows(waterDocPath, 'water')
    ]);
    const rows = [...electricityRows, ...waterRows];
    if (rows.length === 0) {
      return { rowsIndexed: 0 };
    }

    const graph = await getBillsLedgerGraph();

    await graph.query('MATCH (n:MeterRow) DETACH DELETE n');
    try {
      await graph.query('DROP VECTOR INDEX FOR (m:MeterRow) ON (m.embedding)');
    } catch {
      // индекса ещё не было — ок
    }

    const texts = rows.map((r) => this.rowToText(r));
    const vectors = await embed(texts);
    const dim = vectors[0].length;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      await graph.query(
        `CREATE (m:MeterRow {
          meterType: $meterType,
          date: $date,
          value: $value,
          text: $text,
          embedding: vecf32($vec)
        })`,
        {
          params: {
            meterType: row.meterType,
            date: row.date,
            value: row.value,
            text: texts[i],
            vec: vectors[i]
          }
        }
      );
    }

    await graph.query(
      `CREATE VECTOR INDEX FOR (m:MeterRow) ON (m.embedding) OPTIONS {dimension:${dim}, similarityFunction:'cosine', M:16, efConstruction:200}`
    );

    return { rowsIndexed: rows.length };
  }

  /** Векторный поиск по таблицам показаний счётчиков по произвольному пользовательскому запросу. */
  async search(query: string, k = 5): Promise<Array<MeterRow & { similarity: number }>> {
    const graph = await getBillsLedgerGraph();
    const vec = await embedOne(query);

    const res = await graph.roQuery(
      `CALL db.idx.vector.queryNodes('MeterRow', 'embedding', $k, vecf32($vec))
       YIELD node, score
       RETURN node.meterType AS meterType, node.date AS date, node.value AS value, score
       ORDER BY score ASC`,
      { params: { k, vec } }
    );

    const rows = (res.data ?? []) as unknown as Array<{
      meterType: MeterType;
      date: string;
      value: string;
      score: number;
    }>;

    return rows.map((r) => ({
      meterType: r.meterType,
      date: r.date,
      value: r.value,
      similarity: 1 - r.score
    }));
  }

  /** Формирует текстовый контекст из результатов поиска для передачи в модель при ответе на вопрос. */
  formatSearchContext(rows: Array<MeterRow & { similarity: number }>): string {
    if (rows.length === 0) {
      return 'В таблицах показаний счётчиков не найдено подходящих строк.';
    }
    return rows.map((r) => this.rowToText(r)).join('\n');
  }

  async close(): Promise<void> {
    await closeFalkorDb();
  }
}

export const metersVectorService = new MetersVectorService();
