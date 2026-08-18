import { billsLedgerVectorService } from './src/services/vector/BillsLedgerVectorService.js';

async function main() {
  const rows = await billsLedgerVectorService.readLedgerRows('/home/geekonclick/Рабочий стол/Администрирование2026/Администрирование_2_0.docx');
  console.log(JSON.stringify(rows, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
