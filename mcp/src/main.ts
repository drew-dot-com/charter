#!/usr/bin/env node
import { run, VERSION } from './server.js';

const arg = process.argv[2];
if (arg === '--version' || arg === '-v') {
  console.log(VERSION);
} else if (arg === '--help' || arg === '-h') {
  console.log(`charter-mcp ${VERSION}: an MCP server (stdio) that rents Charter machines and pays for them in USDC on Base.

  claude mcp add charter -- npx -y charter-mcp

Environment, all optional:
  CHARTER_MAX_USDC_PER_HOUR   the most one interval may cost (default 0.01)
  CHARTER_MAX_USDC_PER_DAY    the most one UTC day may cost (default 0.25)
  CHARTER_MCP_KEY_FILE        the wallet key file (default ~/.charter/mcp.key, made on first run)
  CHARTER_MCP_NO_NEW_KEY      set to never make a key: with no key file the paid tools stay off
  CHARTER_MCP_SPEND_FILE      where the day's spend is kept (default ~/.charter/mcp-spend.json)
  CHARTER_BASE_RPC            Base RPC for the balance read
  CHARTER_DOOR_URL            the door (default https://charter.mainnet.toonprotocol.dev)

Docs: https://charter.mainnet.toonprotocol.dev/agents`);
} else {
  run(process.env).catch((e) => {
    process.stderr.write(`charter-mcp: ${String((e as Error)?.message ?? e)}\n`);
    process.exit(1);
  });
}
