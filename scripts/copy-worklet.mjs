// Copies the AudioWorklet processor from the *installed* spessasynth_lib into public/
// so the worklet always matches the library version in node_modules (SPEC 5.3).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const libDir = resolve(root, 'node_modules/spessasynth_lib');
const src = resolve(libDir, 'dist/spessasynth_processor.min.js');
const dest = resolve(root, 'public/spessasynth_processor.min.js');

if (!existsSync(src)) {
  console.warn('[copy-worklet] spessasynth_lib is not installed yet; skipping.');
  process.exit(0);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
const version = JSON.parse(readFileSync(resolve(libDir, 'package.json'), 'utf8')).version;
console.log(`[copy-worklet] copied spessasynth_processor.min.js from spessasynth_lib@${version}`);
