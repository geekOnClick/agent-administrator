import path from 'node:path';

/**
 * Маскирует настоящие имена файлов перед отправкой в LLM (RouterAI).
 *
 * Цель: не раскрывать внешнему API реальные имена файлов (ФИО, адреса,
 * названия организаций, которые могут присутствовать в именах документов).
 *
 * Использование:
 *   const masker = new DocumentMaskingService(filePaths);
 *   const maskedName = masker.getMaskedFilename(filePath);  // "doc_001.pdf"
 *   const original  = masker.getOriginalFilename('doc_001.pdf');  // восстановить
 *   const result    = masker.unmaskBillValidationResult(llmResult);
 */
export class DocumentMaskingService {
  /** Реальный путь → маскированное имя файла */
  private readonly pathToMask = new Map<string, string>();
  /** Маскированное имя → реальный basename */
  private readonly maskToOriginal = new Map<string, string>();

  constructor(filePaths: string[]) {
    filePaths.forEach((fp, idx) => {
      const ext = path.extname(fp).toLowerCase() || '.bin';
      const maskedName = `doc_${String(idx + 1).padStart(3, '0')}${ext}`;
      this.pathToMask.set(fp, maskedName);
      this.maskToOriginal.set(maskedName, path.basename(fp));
    });
  }

  /** Возвращает анонимное имя для файла по его полному пути. */
  getMaskedFilename(filePath: string): string {
    const masked = this.pathToMask.get(filePath);
    if (!masked) {
      // Файл не зарегистрирован — используем нейтральное имя
      const ext = path.extname(filePath).toLowerCase() || '.bin';
      return `doc_unknown${ext}`;
    }
    return masked;
  }

  /** Возвращает оригинальное имя файла по маскированному, или само маскированное, если не найдено. */
  getOriginalFilename(maskedName: string): string {
    return this.maskToOriginal.get(maskedName) ?? maskedName;
  }

  /**
   * Заменяет маскированные имена файлов в деталях BillValidationResult обратно
   * на настоящие имена. Метод чистый — не мутирует переданный объект.
   */
  unmaskBillValidationResult<T extends { details: Array<{ file: string } & Record<string, unknown>> }>(
    result: T
  ): T {
    return {
      ...result,
      details: result.details.map((d) => ({
        ...d,
        file: this.getOriginalFilename(d.file)
      }))
    };
  }

  /** Все пары маскированное → оригинальное имя (для отладочных логов). */
  getMaskMap(): ReadonlyMap<string, string> {
    return this.maskToOriginal;
  }
}
