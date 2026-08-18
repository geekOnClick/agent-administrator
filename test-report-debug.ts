import 'dotenv/config';
import { billsLedgerVectorService } from './src/services/vector/BillsLedgerVectorService.js';
import { billsPeriodReportService, parsePeriodArg } from './src/services/BillsPeriodReportService.js';

async function main() {
  const t0 = Date.now();
  const rows = await billsLedgerVectorService.getAllRows();
  console.log('getAllRows took ms:', Date.now() - t0);
  console.log('rows from DB:', JSON.stringify(rows, null, 2));

  const period = parsePeriodArg('06/26-07/27');
  console.log('parsed period:', period);

  const filtered = rows.filter(() => true);
  console.log('total rows returned by getAllRows:', filtered.length);

  await billsLedgerVectorService.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
