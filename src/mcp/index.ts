import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DocumentsService } from '../services/DocumentsService.js';
import { registerProcessBillsTool } from './tools/process-bills.tool.js';

const docsService = new DocumentsService();

const server = new McpServer({
  name: 'ai-assistant-server',
  version: '1.0.0'
});

registerProcessBillsTool(server, docsService);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AI MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
