/**
 * Детерминированный классификатор квитанции/чека об оплате по извлечённому тексту.
 *
 * Зачем: RouterAI для этой задачи регулярно ошибается (особенно при недоступности API
 * — fallback на слабую локальную Ollama), а платежные квитанции Сбербанка/банков
 * детерминированно определяются по платёжным маркерам.
 *
 * Логика (надёжная, не требует LLM для текстовых документов):
 *   - текст + есть платёжный маркер (Чек по операции, СУИП, Код авторизации,
 *     Безналичная оплата, Платёжное поручение, Платёжный счёт ••, Сумма платежа)
 *     → isReceipt: true (это подтверждение оплаты);
 *   - текст + НЕТ платёжного маркера → isReceipt: false (это счёт/УПД/акт/реестр/
 *     справка/предоплата — не подтверждение оплаты; игнорируется);
 *   - нет текста (скан/фото) → если имя файла содержит «квитанция/чек/payment»
 *     → isReceipt: true (доверяем имени); иначе source: 'ambiguous' → LLM (RouterAI/OCR).
 *
 * Имя файла «квитанция/чек/payment/receipt/оплата» — только подсказка для бесконтекстного
 * (скан) случая; для текстовых документов решение принимает содержимое.
 */

export interface ReceiptClassification {
  isReceipt: boolean;
  issue: string | null;
  /** deterministic — решили по маркерам/имени; ambiguous — передаём LLM. */
  source: 'deterministic' | 'ambiguous';
}

const RECEIPT_MARKERS = [
  'чек по операции', // Сбербанк Онлайн
  'суип', // Идентификатор платежа (СУИП) — только в платёжных квитанциях
  'код авторизации',
  'код авторизаци', // вариант окончания
  'безналичная оплата',
  'мобильное приложение сбербанк',
  'платёжный счёт', // «Способ оплаты: Платёжный счёт •• 3336»
  'платежный счет',
  'сумма платежа',
  'сумма списания',
  'платёжное поручение',
  'платежное поручение',
  'квитанция об оплате'
];

const RECEIPT_FILENAME_HINTS = ['квитанци', 'чек', 'payment', 'receipt', 'оплата'];

export function isReceiptFilename(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return RECEIPT_FILENAME_HINTS.some((h) => lower.includes(h));
}

export function classifyReceiptByText(
  text: string,
  fileName?: string
): ReceiptClassification {
  if (!text || !text.trim()) {
    // Пустой текст — возможно скан. Имя «квитанция/чек» → доверяем; иначе LLM.
    if (fileName && isReceiptFilename(fileName)) {
      return { isReceipt: true, issue: null, source: 'deterministic' };
    }
    return { isReceipt: false, issue: 'не извлечён текст (возможно скан) — требуется анализ модели', source: 'ambiguous' };
  }

  const lower = text.toLowerCase();
  const hasReceiptMarker = RECEIPT_MARKERS.some((m) => lower.includes(m));

  if (hasReceiptMarker) {
    return { isReceipt: true, issue: null, source: 'deterministic' };
  }

  // Текст есть, но платёжных маркеров нет → это не подтверждение оплаты
  // (счёт/УПД/акт/реестр/справка/предоплата) → игнорируется.
  return {
    isReceipt: false,
    issue: 'документ не содержит признаков платёжной квитанции/чека (это счёт/УПД/акт/реестр/справка)',
    source: 'deterministic'
  };
}