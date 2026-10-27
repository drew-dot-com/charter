// Bundles the storefront into web/dist: app.js (esbuild), index.html, style.css and fonts/ (copied).
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'web', 'dist');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'web', 'app.ts')],
  outfile: join(out, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

for (const f of ['index.html', 'style.css']) copyFileSync(join(root, 'web', f), join(out, f));
mkdirSync(join(out, 'fonts'), { recursive: true });
for (const f of readdirSync(join(root, 'web', 'fonts'))) copyFileSync(join(root, 'web', 'fonts', f), join(out, 'fonts', f));
