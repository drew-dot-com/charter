#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { cli, USAGE } from './cli.js';
import { build, optionsFromEnv, run, VERSION, type Actions } from './server.js';

const argv = process.argv.slice(2);
const arg = argv[0];
const die = (e: unknown): never => {
  process.stderr.write(`charter-mcp: ${String((e as Error)?.message ?? e)}\n`);
  process.exit(1);
};

if (arg === '--version' || arg === '-v') {
  console.log(VERSION);
} else if (arg === '--help' || arg === '-h' || arg === 'help') {
  console.log(`charter-mcp ${VERSION}: rent a Charter machine and pay for it in USDC on Base, as an MCP server or from the shell.\n\n${USAGE}`);
} else if (arg === undefined) {
  // No command: the MCP server, as an MCP client starts it.
  run(process.env).catch(die);
} else {
  let actions: Actions | undefined;
  cli(argv, {
    actions: () => (actions ??= build(optionsFromEnv(process.env), (line) => void process.stderr.write(`charter-mcp: ${line}\n`)).actions),
    readFile: (path) => readFileSync(path, 'utf8'),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
  }).then((r) => {
    console.log(r.out);
    process.exitCode = r.code;
  }, die);
}
