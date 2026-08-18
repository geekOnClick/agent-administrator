import 'dotenv/config';
import { ChatProcessor } from './src/llm/chat-processor.js';

async function main() {
  const cp: any = Object.create((ChatProcessor as any).prototype);
  cp.ledgerVectorService = (await import('./src/services/vector/BillsLedgerVectorService.js')).billsLedgerVectorService;
  const t0 = Date.now();
  const result = await cp.generatePeriodReport('06/26-07/27');
  console.log('took ms:', Date.now() - t0);
  console.log(result);
  await cp.ledgerVectorService.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
