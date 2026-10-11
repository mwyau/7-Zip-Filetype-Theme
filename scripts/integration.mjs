import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson } from './core.mjs';

if (process.platform !== 'win32') throw new Error('Windows archive integration tests require a Windows runner.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = readJson(path.join(root, 'config/7zip.lock.json'));
const manifest = readJson(path.join(root, 'config/themes.json'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), '7zip-theme-test-'));
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(bin, args, cwd) { const p = spawnSync(bin, args, { cwd, encoding: 'utf8', windowsHide: true }); if (p.error || p.status !== 0) throw new Error(`${path.basename(bin)} ${args.join(' ')} failed: ${p.error?.message || p.stderr}`); return p.stdout; }
try {
  for (const [arch, asset] of Object.entries(lock.assets)) {
    const upstream = path.join(root, '.build/upstream', arch), tool = path.join(upstream, '7z.exe');
    const theme = manifest.filetypes[0], patchedDll = path.join(root, '.build/packages', arch, theme.slug, '7z.dll');
    const binDir = path.join(temp, arch, 'bin'), sourceDir = path.join(temp, arch, 'source'), outDir = path.join(temp, arch, 'out');
    fs.mkdirSync(binDir, { recursive: true }); fs.mkdirSync(sourceDir, { recursive: true }); fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(tool, path.join(binDir, '7z.exe')); fs.copyFileSync(patchedDll, path.join(binDir, '7z.dll'));
    const sample = Buffer.from(`7-Zip theme integration ${arch}\n`); fs.writeFileSync(path.join(sourceDir, 'sample.txt'), sample);
    const archive = path.join(temp, arch, 'sample.7z');
    run(path.join(binDir, '7z.exe'), ['a', '-t7z', archive, 'sample.txt'], sourceDir);
    run(path.join(binDir, '7z.exe'), ['t', archive], sourceDir);
    const listing = run(path.join(binDir, '7z.exe'), ['l', '-slt', archive], sourceDir);
    if (!listing.includes('Path = sample.txt')) throw new Error(`${arch}: created archive listing missed sample.txt`);
    run(path.join(binDir, '7z.exe'), ['x', '-y', `-o${outDir}`, archive], sourceDir);
    if (digest(path.join(sourceDir, 'sample.txt')) !== digest(path.join(outDir, 'sample.txt'))) throw new Error(`${arch}: extracted content hash mismatch`);
    for (const packageTheme of [...manifest.filetypes, manifest.ribbon]) {
      const slug = packageTheme.slug, packageFile = path.join(root, 'dist', `${slug}-${arch}.7z`);
      if (!fs.existsSync(packageFile)) throw new Error(`Missing generated package ${slug}-${arch}.7z`);
      const content = run(tool, ['l', '-slt', packageFile], root);
      const expectedFile = slug === manifest.ribbon.slug ? '7zFM.exe' : '7z.dll';
      if (!content.includes(`Path = ${expectedFile}`) || !content.includes('Path = 7-Zip-License.txt')) throw new Error(`${slug}-${arch}: package contents incomplete`);
      run(tool, ['t', packageFile], root);
    }
    console.log(`${arch}: create/list/test/extract passed using themed 7z.dll; generated packages verified.`);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
