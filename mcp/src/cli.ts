/**
 * The command line: the same seven actions as the MCP tools, one command each, for an agent that
 * drives a shell instead of speaking MCP. Every answer is one JSON document on stdout; a failure is
 * `{"error": "..."}` and exit code 1. The money rules are the server's own (core.ts).
 */
import type { Actions } from './server.js';

export const USAGE = `usage:
  charter-mcp                                   run as an MCP server over stdio
  charter-mcp offers                            free: the machines on sale and the price
  charter-mcp wallet                            free: the wallet to fund, its balance, the caps
  charter-mcp run-python <file | -> [--wait N]  PAID, one interval: run a Python script, print its output
  charter-mcp fetch <url> [url ...] [--wait N]  PAID, one interval: load up to five pages, print their text
  charter-mcp rent-home <keys.pub> [--image charter-home | charter-hermes]
                                                PAID, one interval: open a Linux home with these SSH public keys
  charter-mcp lease <leaseId>                   free: state, paid time left, SSH address, finished output
  charter-mcp extend <leaseId> <hours>          PAID, one interval each: pay the next 1 to 24 intervals

One interval is an hour at 0.007 USDC on the live host. --wait is 10 to 240 seconds (default 40); a job
still running then prints its leaseId, and \`lease\` collects the output for free.
Environment: CHARTER_MAX_USDC_PER_HOUR (0.01), CHARTER_MAX_USDC_PER_DAY (0.25), CHARTER_MCP_KEY_FILE,
CHARTER_MCP_NO_NEW_KEY, CHARTER_MCP_SPEND_FILE, CHARTER_BASE_RPC, CHARTER_DOOR_URL.
Docs: https://charter.mainnet.toonprotocol.dev/agents`;

export interface CliIo {
  /** The actions, made only when a command needs them (so `--help` touches no key file). */
  actions(): Actions;
  readFile(path: string): string;
  readStdin(): Promise<string>;
}

export interface CliResult {
  code: number;
  /** What goes to stdout. */
  out: string;
}

class UsageError extends Error {}

/** Splits `--name value` flags from the rest. Only the flags named in `known` are accepted. */
function parse(args: string[], known: string[]): { rest: string[]; flags: Record<string, string> } {
  const rest: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const value = args[i + 1];
      if (!known.includes(name) || value === undefined) throw new UsageError(`unknown or incomplete option ${a}`);
      flags[name] = value;
      i++;
    } else {
      rest.push(a);
    }
  }
  return { rest, flags };
}

function waitOf(flags: Record<string, string>): number | undefined {
  if (flags.wait === undefined) return undefined;
  if (!/^\d{1,3}$/.test(flags.wait)) throw new UsageError('--wait takes a whole number of seconds, 10 to 240');
  return Number(flags.wait);
}

export async function cli(argv: string[], io: CliIo): Promise<CliResult> {
  const [cmd, ...args] = argv;
  const ok = (o: unknown): CliResult => ({ code: 0, out: JSON.stringify(o, null, 2) });
  try {
    switch (cmd) {
      case 'offers':
        parse(args, []);
        return ok(await io.actions().offers());
      case 'wallet':
        parse(args, []);
        return ok(await io.actions().wallet());
      case 'run-python': {
        const { rest, flags } = parse(args, ['wait']);
        // A lone "-" is stdin, not an option.
        if (rest.length !== 1) throw new UsageError('run-python takes one script file, or - for stdin');
        const wait = waitOf(flags);
        const script = rest[0] === '-' ? await io.readStdin() : io.readFile(rest[0]!);
        return ok(await io.actions().runPython(script, wait));
      }
      case 'fetch': {
        const { rest, flags } = parse(args, ['wait']);
        if (rest.length < 1) throw new UsageError('fetch takes one to five URLs');
        return ok(await io.actions().fetchPages(rest, waitOf(flags)));
      }
      case 'rent-home': {
        const { rest, flags } = parse(args, ['image']);
        if (rest.length !== 1) throw new UsageError('rent-home takes one file of SSH public keys, one a line');
        const keys = io
          .readFile(rest[0]!)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
        return ok(await io.actions().rentHome(keys, flags.image));
      }
      case 'lease': {
        const { rest } = parse(args, []);
        if (rest.length !== 1) throw new UsageError('lease takes one leaseId');
        return ok(await io.actions().lease(rest[0]!));
      }
      case 'extend': {
        const { rest } = parse(args, []);
        if (rest.length !== 2 || !/^\d{1,2}$/.test(rest[1]!)) throw new UsageError('extend takes a leaseId and a number of intervals, 1 to 24');
        return ok(await io.actions().extend(rest[0]!, Number(rest[1])));
      }
      default:
        throw new UsageError(cmd === undefined ? 'no command' : `unknown command ${cmd}`);
    }
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    return { code: e instanceof UsageError ? 2 : 1, out: JSON.stringify({ error: e instanceof UsageError ? `${message}. Run charter-mcp --help.` : message }, null, 2) };
  }
}
