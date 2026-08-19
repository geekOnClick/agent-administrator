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

  mcp: {
    // MCP-инструменты (organize_bills, check_bill_receipts) выполняют обращения к
    // локальной/удалённой модели по каждой папке со счетами и могут занимать больше
    // стандартного таймаута SDK (60 сек), поэтому лимиты для callTool увеличены.
    toolCallTimeoutMsec: 10 * 60 * 1000, // 10 минут на попытку
    toolCallMaxTotalTimeoutMsec: 30 * 60 * 1000 // 30 минут суммарно с учётом progress
  }
} as const;

export type McpCallOptions = {
  timeout: number;
  resetTimeoutOnProgress: boolean;
  maxTotalTimeout: number;
};

/** Опции вызова MCP-инструментов с увеличенными таймаутами (см. config.mcp). */
export function mcpCallOptions(): McpCallOptions {
  return {
    timeout: config.mcp.toolCallTimeoutMsec,
    resetTimeoutOnProgress: true,
    maxTotalTimeout: config.mcp.toolCallMaxTotalTimeoutMsec
  };
}
