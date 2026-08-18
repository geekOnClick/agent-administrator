import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DOWNLOAD_API_URL = 'https://cloud-api.yandex.net/v1/disk/public/resources/download';
const AUTHORIZATION_PREFIX = 'OAuth ';

interface DownloadLinkResponse {
  href: string;
  method: string;
  templated: boolean;
}

export class YandexDiskService {
  /**
   * Загружает документы с публичной папки Яндекс.Диска в папку docs проекта.
   * Перед загрузкой очищает папку docs от предыдущего содержимого.
   * Возвращает список путей перемещённых файлов.
   */
  async syncDocsToLocal(docsDir: string = path.resolve(process.cwd(), 'docs')): Promise<string[]> {
    const publicKey = this.getEnv('PUBLIC_URL_DOCS');
    const token = this.getEnv('YANDEX_OAUTH');

    console.log('☁️  Загрузка документов с Яндекс.Диска...');

    const downloadUrl = await this.getDownloadUrl(publicKey, token);
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yandex-disk-docs-'));

    try {
      const archivePath = path.join(tmpDir, 'docs.zip');
      await this.downloadArchive(downloadUrl, archivePath);

      const extractDir = path.join(tmpDir, 'extracted');
      await fs.promises.mkdir(extractDir, { recursive: true });
      await this.extractArchive(archivePath, extractDir);

      const files = await this.moveFilesToDocs(extractDir, docsDir);
      console.log(`✅ Загружено документов: ${files.length} → ${docsDir}`);

      return files;
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private getEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Переменная окружения ${name} не задана в .env`);
    }
    return value;
  }

  /**
   * Выполняет fetch с автоматическими повторами при сетевых ошибках.
   * Использует экспоненциальную задержку: 2s, 4s, 8s.
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries = 3,
    baseDelayMs = 2000
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fetch(url, options);
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          console.log(`  ⚠️  Сетевая ошибка (попытка ${attempt + 1}/${retries}), повтор через ${delay / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  /**
   * GET-запрос к API Яндекс.Диска для получения ссылки на скачивание ресурса.
   */
  private async getDownloadUrl(publicKey: string, token: string): Promise<string> {
    const url = `${DOWNLOAD_API_URL}?public_key=${encodeURIComponent(publicKey)}`;

    const response = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        Authorization: `${AUTHORIZATION_PREFIX}${token}`
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Ошибка API Яндекс.Диска (${response.status}): ${body}`
      );
    }

    const data = (await response.json()) as DownloadLinkResponse;
    if (!data.href) {
      throw new Error('API Яндекс.Диска не вернул ссылку для скачивания.');
    }

    return data.href;
  }

  /**
   * GET-запрос на скачивание ресурса в виде ZIP-архива.
   */
  private async downloadArchive(downloadUrl: string, archivePath: string): Promise<void> {
    const response = await this.fetchWithRetry(downloadUrl, { method: 'GET' });

    if (!response.ok || !response.body) {
      throw new Error(`Ошибка скачивания архива (${response.status}).`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(archivePath, buffer);
  }

  /**
   * Разархивирует ZIP-архив через системную утилиту unzip.
   */
  private async extractArchive(archivePath: string, targetDir: string): Promise<void> {
    try {
      await execFileAsync('unzip', ['-o', '-q', archivePath, '-d', targetDir]);
    } catch (error) {
      throw new Error(
        `Не удалось разархивировать архив: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  /**
   * Очищает папку docs и перемещает в неё все файлы из распакованного архива.
   */
  private async moveFilesToDocs(extractDir: string, docsDir: string): Promise<string[]> {
    const files: string[] = [];
    await this.collectFiles(extractDir, files);

    if (files.length === 0) {
      throw new Error('В скачанном архиве не найдено файлов.');
    }

    // Очищаем docs, оставляя саму папку
    await fs.promises.rm(docsDir, { recursive: true, force: true });
    await fs.promises.mkdir(docsDir, { recursive: true });

    const movedFiles: string[] = [];
    for (const filePath of files) {
      const fileName = path.basename(filePath);
      const targetPath = path.join(docsDir, fileName);
      await fs.promises.copyFile(filePath, targetPath);
      await fs.promises.rm(filePath);
      movedFiles.push(targetPath);
    }

    return movedFiles;
  }

  private async collectFiles(dir: string, result: string[]): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.collectFiles(fullPath, result);
      } else if (entry.isFile()) {
        result.push(fullPath);
      }
    }
  }
}
