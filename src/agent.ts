import ollama from 'ollama';
import * as readline from 'readline';
import process from 'process';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MODEL = 'gemma4:e4b-8k';
let ollamaProcess: ChildProcess | null = null;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'Вы: ',
});

async function main() {
  console.log(`--- Запуск модели ${MODEL}... ---`);
  
  ollamaProcess = spawn('ollama', ['run', MODEL], {
    stdio: 'ignore'
  });

  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log(`--- Агент готов ---`);
  console.log('Команды:');
  console.log('  <текст> - обычный чат');
  console.log('  process <путь> - обработать файл (например: process task.txt)');
  console.log('  exit - выход');

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();

    if (input.toLowerCase() === 'exit') {
      cleanup();
    }

    if (!input) {
      rl.prompt();
      return;
    }

    rl.pause();

    if (input.startsWith('process ')) {
      const filePath = input.replace('process ', '').trim();
      await handleFileProcessing(filePath);
    } else {
      await handleChat(input);
    }

    rl.resume();
    rl.prompt();
  }).on('close', () => {
    cleanup();
  });
}

async function handleChat(input: string) {
  try {
    process.stdout.write('Олли: думает...');
    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: 'user', content: input }],
      stream: true,
    });

    process.stdout.write('\b\b\b\b\b\b\b\b\b'); 
    process.stdout.write('\x1b[K'); 

    for await (const part of response) {
      process.stdout.write(part.message.content);
    }
    process.stdout.write('\n');
  } catch (error) {
    console.error('\nОшибка:', error instanceof Error ? error.message : error);
  }
}

async function handleFileProcessing(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`Ошибка: Файл ${filePath} не найден.`);
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    console.log(`Чтение файла ${filePath}...`);
    process.stdout.write('Олли обрабатывает документ...');

    const prompt = `В документе ниже содержится текст или пример. Пожалуйста, дополни его ответом или решением. Верни ТОЛЬКО итоговый текст, который должен быть в файле.
    
Содержимое файла:
${content}`;

    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
    });

    const result = response.message.content;
    const newFilePath = path.join(
      path.dirname(filePath),
      `result_${path.basename(filePath)}`
    );

    fs.writeFileSync(newFilePath, result);
    
    process.stdout.write('\r\x1b[K'); // Очистка строки "Олли обрабатывает..."
    console.log(`Готово! Результат сохранен в: ${newFilePath}`);

  } catch (error) {
    console.error('\nОшибка при обработке файла:', error instanceof Error ? error.message : error);
  }
}

function cleanup() {
  console.log('\nЗавершение работы и выгрузка модели...');
  if (ollamaProcess) {
    ollamaProcess.kill();
    ollamaProcess = null;
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

main();
