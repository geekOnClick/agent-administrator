import { FalkorDB, type Graph } from 'falkordb';

/**
 * Единое подключение к FalkorDB для всего процесса. Используется как
 * векторное хранилище (индекс по узлам :BillRow) для актуализации данных
 * из таблицы учёта коммунальных платежей ("Администрирование_2_0.docx").
 */
let dbInstance: FalkorDB | undefined;

function getFalkorConfig() {
  return {
    host: process.env.FALKORDB_HOST || '127.0.0.1',
    port: Number(process.env.FALKORDB_PORT || 6379),
    graph: process.env.FALKORDB_GRAPH || 'bills_ledger'
  };
}

export async function connectFalkorDb(): Promise<FalkorDB> {
  if (!dbInstance) {
    const { host, port } = getFalkorConfig();
    dbInstance = await FalkorDB.connect({ socket: { host, port } });
  }
  return dbInstance;
}

export async function getBillsLedgerGraph(): Promise<Graph> {
  const conn = await connectFalkorDb();
  const { graph } = getFalkorConfig();
  return conn.selectGraph(graph);
}

export async function closeFalkorDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = undefined;
  }
}
