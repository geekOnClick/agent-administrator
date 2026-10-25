// Конфигурация агента: все значения читаются из переменных окружения (.env),
// для каждой задано значение по умолчанию.

export const config = {
  routerAI: {
    // Основная облачная модель RouterAI (все LLM-задачи: документы, чат ask/askMeters).
    model: process.env.AIROUTER_MODEL || 'google/gemini-3-flash',
    // Резервная модель RouterAI: на неё переключается роутер при недоступности
    // (сеть/5xx/таймаут) основной модели. Auth/токен-ошибки (401/402) не fallback-ятся.
    additionalModel: process.env.AIROUTER_MODEL_ADDITIONAL || '',
    // Модель эмбеддингов для векторной базы FalkorDB (режимы ask/askMeters/meters).
    embedModel: process.env.ROUTERAI_EMBED_MODEL || 'qwen/qwen3-embedding-4b',
    // Таймаут одного запроса к RouterAI (мс). При превышении — проброс ошибки наверх.
    // 0 = таймаут отключён. По умолчанию 180 секунд (документные запросы с OCR тяжелее).
    requestTimeoutMs: Number(process.env.ROUTERAI_REQUEST_TIMEOUT_MS ?? '180000')
  },

  bills: {
    // Максимальное число попыток валидации (bills + retry) за один цикл.
    // При достижении лимита цикл прерывается с ошибкой вместо ожидания следующего retry.
    // Переопределяется через BILLS_MAX_VALIDATION_ATTEMPTS в .env.
    maxValidationAttempts: Number(process.env.BILLS_MAX_VALIDATION_ATTEMPTS ?? '5'),
    // Папка, в которую сохраняются отчёты режима "report".
    reportOutputDir:
      process.env.BILLS_REPORT_OUTPUT_DIR || '/home/geekonclick/Рабочий стол/Администрирование',
    // Путь к файлу таблицы учёта коммунальных платежей ("Администрирование_2_0.docx"),
    // в который агент дозаписывает строку с суммами текущего месяца после успешной валидации.
    ledgerDocxPath:
      process.env.BILLS_LEDGER_DOCX_PATH ||
      '/home/geekonclick/Рабочий стол/Администрирование/Администрирование_2_0.docx'
  },

  meters: {
    // Пути к файлам таблиц показаний счётчиков (режимы meters / askMeters).
    electricityDocxPath:
      process.env.METERS_ELECTRICITY_DOCX_PATH ||
      '/home/geekonclick/Рабочий стол/Администрирование/Показания счетчика/электроэнергия.docx',
    waterDocxPath:
      process.env.METERS_WATER_DOCX_PATH ||
      '/home/geekonclick/Рабочий стол/Администрирование/Показания счетчика/водоканал.docx'
  },

  evals: {
    // Тарифы RouterAI (руб. за 1M токенов → приводим к руб. за 1 токен) для метрики стоимости.
    // Берутся из .env; 0 = стоимость не учитывается.
    routerAIInputRubPerToken: Number(process.env.ROUTERAI_INPUT_RUB_PER_1M || 0) / 1_000_000,
    routerAIOutputRubPerToken: Number(process.env.ROUTERAI_OUTPUT_RUB_PER_1M || 0) / 1_000_000,
    // Верхняя граница токенов ответа модели — защита от бесконтрольной генерации.
    maxResponseTokens: Number(process.env.ROUTERAI_MAX_RESPONSE_TOKENS || 2048)
  },

  telegram: {
    // Токен бота Telegram (BotFather).
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    // Список разрешённых chatId через запятую; пустой = бот открыт для всех.
    allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n !== 0)
  }
} as const;