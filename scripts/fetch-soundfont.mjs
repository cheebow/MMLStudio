// Downloads GeneralUser GS v2.0.3 and its license from the author's official GitHub
// repository (pinned commit) into public/. The app serves its own local copy and never
// hot-links the author's download files (SPEC 5.2).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = '684543d5e5efaef08d02be50dcda8d552478fa60'; // "update documentation to r6" (v2.0.3)
const BASE = `https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/${COMMIT}`;
const FILES = [
  { url: `${BASE}/GeneralUser-GS.sf2`, dest: 'public/soundfonts/GeneralUser-GS.sf2', sha256: '9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe' },
  { url: `${BASE}/documentation/LICENSE.txt`, dest: 'public/licenses/GeneralUser-GS-LICENSE.txt' },
  { url: `${BASE}/documentation/README.md`, dest: 'public/licenses/GeneralUser-GS-README.md' },
];

const force = process.argv.includes('--force');
for (const f of FILES) {
  const dest = resolve(root, f.dest);
  if (existsSync(dest) && !force) {
    if (f.sha256 && sha(readFileSync(dest)) !== f.sha256) {
      console.error(`[fetch-soundfont] ${f.dest} exists but SHA-256 does not match. Re-run with --force.`);
      process.exitCode = 1;
    } else {
      console.log(`[fetch-soundfont] ${f.dest} already present.`);
    }
    continue;
  }
  console.log(`[fetch-soundfont] downloading ${f.url}`);
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${f.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (f.sha256 && sha(buf) !== f.sha256) {
    throw new Error(`SHA-256 mismatch for ${f.url}: got ${sha(buf)}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log(`[fetch-soundfont] wrote ${f.dest} (${buf.length} bytes)`);
}

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
