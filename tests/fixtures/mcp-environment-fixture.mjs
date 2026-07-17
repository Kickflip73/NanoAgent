import { writeFileSync } from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';

writeFileSync(process.argv[2], JSON.stringify({
  injected: process.env.INJECTED_MCP_TOKEN,
  ambient: process.env.MCP_TASK_SECRET,
}));

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mimi-mcp-environment-fixture', version: '1.0.0' },
      }
    : request.method === 'tools/list'
      ? { tools: [] }
      : {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
