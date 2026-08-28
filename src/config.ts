// Конфигурация агента: все значения читаются из переменных окружения (.env),
// для каждой задано значение по умолчанию.

export const config = {
  ollama: {
    host: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    // Локальная модель для задач EASY-режима (ask / askMeters).
    model: process.env.OLLAMA_MODEL || 'gemma4:e4b-8k',
    // Модель-классификатор роутера (EASY/HARD) для свободных запросов.
    routerModel: process.env.OLLAMA_ROUTER_MODEL || process.env.OLLAMA_MODEL || 'gemma4:e4b-8k'
  },

  bills: {
    // Максимальное число попыток валидации (bills + retry) за один цикл.
    // При достижении лимита цикл прерывается с ошибкой вместо ожидания следующего retry.
    // Переопределяется через BILLS_MAX_VALIDATION_ATTEMPTS в .env.
    maxValidationAttempts: Number(process.env.BILLS_MAX_VALIDATION_ATTEMPTS ?? '5'),
    // Папка, в которую сохраняются отчёты режима "report".
    reportOutputDir:
      process.env.BILLS_REPORT_OUTPUT_DIR || '/home/geekonclick/Рабочий стол/Администрирование2026',
    // Путь к файлу таблицы учёта коммунальных платежей ("Администрирование_2_0.docx"),
    // в который агент дозаписывает строку с суммами текущего месяца после успешной валидации.
    ledgerDocxPath:
      process.env.BILLS_LEDGER_DOCX_PATH ||
      '/home/geekonclick/Рабочий стол/Администрирование2026/Администрирование_2_0.docx'
  },

  meters: {
    // Пути к файлам таблиц показаний счётчиков (режимы meters / askMeters).
    electricityDocxPath:
      process.env.METERS_ELECTRICITY_DOCX_PATH ||
      '/home/geekonclick/Рабочий стол/Администрирование2026/Показания счетчика/электроэнергия.docx',
    waterDocxPath:
      process.env.METERS_WATER_DOCX_PATH ||
      '/home/geekonclick/Рабочий стол/Администрирование2026/Показания счетчика/водоканал.docx'
  },

  evals: {
    // Тарифы RouterAI (руб. за 1 токен) для метрики стоимости документных задач (HARD-режим).
    // Берутся из .env; 0 = стоимость не учитывается. Локальная Ollama не тарифицируется (условно 0).
    routerAIInputRubPerToken: Number(process.env.ROUTERAI_INPUT_RUB_PER_1M || 0) / 1_000_000,
    routerAIOutputRubPerToken: Number(process.env.ROUTERAI_OUTPUT_RUB_PER_1M || 0) / 1_000_000,
    // Верхняя граница токенов ответа локальной модели — базовая защита от бесконтрольной генерации.
    ollamaMaxResponseTokens: Number(process.env.OLLAMA_MAX_RESPONSE_TOKENS || 2048)
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
