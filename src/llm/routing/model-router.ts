import path from 'node:path';
import {
  RouterAIService,
  routerAIService,
  BillValidationResult,
  ReceiptVerifyModelResult,
  BillColumnsExtractResult
} from '../../services/RouterAIService.js';
import { BILL_CATEGORIES, BillCategory } from '../prompts.js';
import { documentTextService } from '../../services/document-text/DocumentTextService.js';
import { parseBillTotals } from '../../services/bill-totals/BillTotalsParser.js';
import { classifyBillCategory } from '../../services/bill-totals/BillCategoryClassifier.js';
import { classifyReceiptByText } from '../../services/receipts/ReceiptClassifier.js';

/**
 * Единый оркестратор LLM-вызовов агента (модельная оркестрация).
 *
 * Локальная Ollama из проекта удалена: все LLM-задачи выполняет облачная RouterAI
 * (основная модель AIROUTER_MODEL). При недоступности основной модели (сеть/5xx/таймаут)
 * RouterAIService автоматически переключается на резервную модель (AIROUTER_MODEL_ADDITIONAL).
 * Auth/токен-ошибки (401/402) не fallback-ятся — они пробрасываются наверх.
 *
 * Документные операции (валидация категорий, проверка квитанций, извлечение столбцов
 * счёта) сначала идут детерминированным путём (DocumentTextService + парсеры по тексту);
 * LLM используется только для сканов/фото и неоднозначных случаев.
 */
export class ModelRouter {
  constructor(private readonly routerAI: RouterAIService) {}

  /** Модельный чат для ask/askMeters (сессионный, с fallback на резервную модель). */
  async chat(sessionId: string, message: string): Promise<string> {
    return this.routerAI.chat(sessionId, message);
  }

  async setSessionSystemPrompt(sessionId: string, prompt: string): Promise<void> {
    return this.routerAI.setSessionSystemPrompt(sessionId, prompt);
  }

  async resetSession(sessionId: string): Promise<void> {
    return this.routerAI.resetSession(sessionId);
  }

  /**
   * Анализ документов и определение категорий счетов (шаг валидации ReAct-цикла bills).
   * Текстовые документы — детерминированно (парсер итогов + классификатор категории по тексту);
   * сканы/фото и неоднозначные — через RouterAI (с fallback на резервную модель).
   */
  async validateBillCategories(filePaths: string[]): Promise<BillValidationResult> {
    const details: BillValidationResult['details'] = [];
    const errors: string[] = [];
    const imageFiles: string[] = [];

    for (const fp of filePaths) {
      let doc;
      try {
        doc = await documentTextService.extract(fp);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Не удалось прочитать документ ${path.basename(fp)}: ${msg}`);
        continue;
      }
      if (doc.kind === 'text') {
        let category = classifyBillCategory(doc.text);
        if (!category) {
          // Детерминированный классификатор не сработал — fallback на модель по тексту.
          category = await this.routerAI.classifyBillCategoryByText(doc.text);
        }
        const totals = parseBillTotals(doc.text);
        details.push({
          file: path.basename(fp),
          category,
          hasAmount: totals.totalWithVat !== null,
          amount: totals.totalWithVat ?? null,
          issue: totals.issue
        });
      } else {
        // image / empty — передаём модели (OCR/визуальный анализ)
        imageFiles.push(fp);
      }
    }

    if (imageFiles.length > 0) {
      const batch = await this.routerAI.validateBillCategoriesByModel(imageFiles);
      details.push(...batch.details);
      errors.push(...batch.errors);
    }

    const covered = Array.from(
      new Set(details.filter((d) => d.category !== null).map((d) => d.category as BillCategory))
    );
    const missing = (BILL_CATEGORIES as readonly BillCategory[]).filter((c) => !covered.includes(c));
    return {
      valid: missing.length === 0 && details.length > 0,
      coveredCategories: covered,
      missingCategories: missing,
      errors,
      details
    };
  }

  /**
   * Классификация файла-кандидата: квитанция/чек об оплате или иной документ.
   * Текст — детерминированно (по платёжным маркерам); сканы/неоднозначные — RouterAI.
   */
  async verifyReceiptFile(filePath: string): Promise<ReceiptVerifyModelResult> {
    let doc;
    try {
      doc = await documentTextService.extract(filePath);
    } catch (err) {
      // Не удалось извлечь текст — отдаём модели как последний шанс (OCR скана).
      return this.routerAI.verifyReceiptFile(filePath);
    }

    if (doc.kind === 'text') {
      const cls = classifyReceiptByText(doc.text, path.basename(filePath));
      if (cls.source === 'deterministic') {
        return { isReceipt: cls.isReceipt, issue: cls.issue };
      }
      // ambiguous — отдаём LLM (модель видит документ целиком, в т.ч. скан).
    }

    // image / empty / ambiguous → RouterAI (с внутренним fallback на резервную модель).
    return this.routerAI.verifyReceiptFile(filePath);
  }

  /**
   * Извлечение табличных данных счёта (единица, количество, сумма, НДС и т.д.).
   * Текстовые документы — детерминированно (BillTotalsParser); сканы/фото — RouterAI.
   */
  async extractBillColumns(filePath: string): Promise<BillColumnsExtractResult> {
    let doc;
    try {
      doc = await documentTextService.extract(filePath);
    } catch (err) {
      return this.routerAI.extractBillColumns(filePath);
    }

    if (doc.kind === 'text') {
      const totals = parseBillTotals(doc.text);
      return {
        unit: totals.unit,
        quantity: totals.quantity,
        pricePerUnit: totals.pricePerUnit,
        amount: totals.subtotal,
        vatPercent: totals.vatPercent,
        vatAmount: totals.vatAmount,
        totalWithVat: totals.totalWithVat,
        error: totals.issue
      };
    }

    // image / empty — модель (OCR), с fallback на резервную.
    return this.routerAI.extractBillColumns(filePath);
  }

  getModelName(): string {
    return this.routerAI.getModelName();
  }

  getAdditionalModelName(): string {
    return this.routerAI.getAdditionalModelName();
  }

  hasAdditionalModel(): boolean {
    return this.routerAI.hasAdditionalModel();
  }
}

export const agentModelRouter = new ModelRouter(routerAIService);