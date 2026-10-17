import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DoorLedger, LEDGER_FILE } from './ledger.js';

/** `charter-door unblock <address>`: clears a payer's block in the data dir's ledger. A running door picks it up. */
export function unblockCommand(args: string[], env: NodeJS.ProcessEnv, now: () => number, out: (m: string) => void): number {
  const address = args[0]?.trim().toLowerCase();
  if (args.length !== 1 || !address || !/^0x[0-9a-f]{40}$/.test(address)) {
    out('usage: charter-door unblock <0x address>');
    return 2;
  }
  const dataDir = env.CHARTER_DATA_DIR?.trim();
  if (!dataDir) {
    out('CHARTER_DATA_DIR is required');
    return 2;
  }
  const file = join(dataDir, LEDGER_FILE);
  if (!existsSync(file)) {
    out(`no ledger at ${file}: nothing to unblock (is CHARTER_DATA_DIR the door's data dir?)`);
    return 1;
  }
  new DoorLedger(file).unblock(address, now());
  out(`unblocked ${address}`);
  return 0;
}
