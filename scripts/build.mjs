// Web build: web/ -> www/ with the app's modules bundled into one file (and '@capacitor/core' resolved from
// node_modules instead of the browser preview's stand-in).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = path.join(root, 'web');
const out = path.join(root, 'www');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'js'), { recursive: true });
for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
  if (entry.name === 'js') continue;
  fs.cpSync(path.join(src, entry.name), path.join(out, entry.name), { recursive: true });
}

await build({
  entryPoints: [path.join(src, 'js', 'app.js')],
  bundle: true,
  format: 'esm',
  target: ['chrome100'],
  outfile: path.join(out, 'js', 'app.js'),
  legalComments: 'none',
  logLevel: 'info',
});

const indexFile = path.join(out, 'index.html');
const html = fs.readFileSync(indexFile, 'utf8')
  .replace(/<!-- Browser preview only[^]*?-->\s*/, '')
  .replace(/<script type="importmap">[^]*?<\/script>\s*/, '');
fs.writeFileSync(indexFile, html);
console.log('www/ ready');
