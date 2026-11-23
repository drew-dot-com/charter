import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOSTS_FILE, HostRegistry } from './hosts.js';

/**
 * `charter-door hosts drop <hostId>`: drops a host in the data dir's registry for good. A running door picks it
 * up; its reaper then withdraws the host's channels once no lease ticks on it.
 */
export function hostsCommand(args: string[], env: NodeJS.ProcessEnv, now: () => number, out: (m: string) => void): number {
  const hostId = args[1]?.trim().toLowerCase();
  if (args.length !== 2 || args[0] !== 'drop' || !hostId || !/^[0-9a-f]{64}$/.test(hostId)) {
    out('usage: charter-door hosts drop <hostId (64 hex)>');
    return 2;
  }
  const dataDir = env.CHARTER_DATA_DIR?.trim();
  if (!dataDir) {
    out('CHARTER_DATA_DIR is required');
    return 2;
  }
  const file = join(dataDir, HOSTS_FILE);
  if (!existsSync(file)) {
    out(`no host registry at ${file}: nothing to drop (is CHARTER_DATA_DIR the door's data dir?)`);
    return 1;
  }
  // Read, never written here: the running door owns the file.
  const known = (JSON.parse(readFileSync(file, 'utf8')) as { hosts: Array<{ hostId: string }> }).hosts.some((h) => h.hostId === hostId);
  if (!known) {
    out(`no host ${hostId} in ${file}`);
    return 1;
  }
  HostRegistry.drop(file, hostId, now());
  out(`dropped ${hostId}`);
  return 0;
}
