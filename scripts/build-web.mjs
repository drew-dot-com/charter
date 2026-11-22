// Bundles the storefront into web/dist: app.js and grants.js (esbuild); index.html, agents.html, grants.html, privacy.html, llms.txt, style.css, fonts/, openhuman/SKILL.md and well-known/x402list.txt (copied).
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'web', 'dist');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: { app: join(root, 'web', 'app.ts'), grants: join(root, 'web', 'grants.ts') },
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

for (const f of ['index.html', 'agents.html', 'grants.html', 'privacy.html', 'llms.txt', 'style.css', 'favicon.svg']) copyFileSync(join(root, 'web', f), join(out, f));
// The skill an OpenHuman agent in a home installs: served at /openhuman/SKILL.md.
mkdirSync(join(out, 'openhuman'), { recursive: true });
copyFileSync(join(root, 'web', 'openhuman', 'SKILL.md'), join(out, 'openhuman', 'SKILL.md'));
// Ownership proofs for directories that list Charter: served at /.well-known/x402list.txt.
mkdirSync(join(out, 'well-known'), { recursive: true });
copyFileSync(join(root, 'web', 'well-known', 'x402list.txt'), join(out, 'well-known', 'x402list.txt'));
mkdirSync(join(out, 'fonts'), { recursive: true });
for (const f of readdirSync(join(root, 'web', 'fonts'))) copyFileSync(join(root, 'web', 'fonts', f), join(out, 'fonts', f));
