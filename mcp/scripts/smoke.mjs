// Drives the built server over real stdio against the live door, as an MCP client would.
//   node scripts/smoke.mjs            free tools, then one paid call from whatever wallet the key file holds
//   node scripts/smoke.mjs --free     free tools only
// With an empty wallet the paid call is expected to be refused for balance: that proves the policy
// accepted the door's offer and a payment was signed, and nothing is spent. With a funded wallet it
// spends one interval (0.012 USDC on the live host) and prints the script's output.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'main.js');
const transport = new StdioClientTransport({ command: process.execPath, args: [main], env: process.env, stderr: 'inherit' });
const client = new Client({ name: 'charter-mcp-smoke', version: '0' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  console.log(`\n== ${name}${r.isError ? ' (error)' : ''}\n${r.content[0].text}`);
  return r;
};

console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
await call('charter_offers');
await call('charter_wallet');
if (!process.argv.includes('--free')) await call('charter_run_python', { script: 'import numpy as np\nprint(int(np.arange(10).sum()))' });
await client.close();
