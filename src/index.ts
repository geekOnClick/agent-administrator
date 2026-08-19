import 'dotenv/config';
import { selectEntrypoint } from './entrypoint/selector.js';

async function main(): Promise<void> {
  try {
    const entrypoint = selectEntrypoint(process.argv.slice(2));
    await entrypoint.run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
