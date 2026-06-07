import 'dotenv/config';
import { selectEntrypoint } from './entrypoint/selector.js';

selectEntrypoint().then((entrypoint) => {
  entrypoint.run();
});

// СИСТЕМНЫЙ ПРОМПТ
const SYSTEM_PROMPT = `
Ты — полезный ИИ-ассистент, работающий по циклу ReAct.
Твоя задача — отвечать на вопросы, используя доступные инструменты.

Доступные инструменты:
1. get_latest_file_info[путь_к_папке]: Принимает путь к папке и возвращает инфо о последнем измененном файле.

Формат твоего ответа ДОЛЖЕН СТРОГО следовать шаблону:
Thought: [твои рассуждения о следующем шаге]
Action: название_инструмента[аргумент]
(После Action ты должен остановиться и подождать Observation)

Когда у тебя есть финальный ответ:
Final Answer: [твой итоговый ответ пользователю]

Пример цикла:
Thought: Мне нужно проверить файлы в папке 'test'.
Action: get_latest_file_info[test]
Observation: Файл: log.txt, Изменен: Mon May 25 10:00:00 2026
Final Answer: Последним изменился файл log.txt (25 мая).
`