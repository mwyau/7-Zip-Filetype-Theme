import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, sha256, verifyAsset } from './core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(root, 'config/7zip.lock.json');
const lock = readJson(lockPath);
const cache = path.resolve(process.env.SEVENZIP_CACHE || path.join(root, '.cache/upstream'));
const output = path.resolve(process.env.SEVENZIP_EXTRACTED || path.join(root, '.build/upstream'));

async function download(asset, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const headers = { 'User-Agent': '7-Zip-Filetype-Theme-build' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(asset.url, { headers, redirect: 'follow' });
  if (response.status === 403 || response.status === 429) throw new Error(`Download rate limited (${response.status}); set GITHUB_TOKEN or retry later`);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${asset.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyAsset(bytes, asset, asset.filename);
  fs.writeFileSync(destination, bytes);
  return bytes;
}

function extract(extractor, installer, destination) {
  const proc = spawnSync(extractor, ['x', '-y', `-o${destination}`, installer], { encoding: 'utf8', windowsHide: true });
  if (proc.error || proc.status !== 0) throw new Error(`Official 7-Zip extraction failed: ${proc.error?.message || proc.stderr || proc.stdout}`);
}

if (process.platform !== 'win32') throw new Error('Official installer extraction uses the locked upstream 7zr.exe and must run on Windows; use the Windows CI build.');
fs.rmSync(cache, { recursive: true, force: true });
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(cache, { recursive: true });
const tool = path.join(cache, lock.extractor.filename);
await download(lock.extractor, tool);
for (const [arch, asset] of Object.entries(lock.assets)) {
  const installer = path.join(cache, asset.filename);
  await download(asset, installer);
  const target = path.join(output, arch);
  fs.mkdirSync(target, { recursive: true });
  extract(tool, installer, target);
  for (const name of asset.binaries) if (!fs.existsSync(path.join(target, name))) throw new Error(`${arch}: extracted ${asset.filename} is missing ${name}`);
  const actualHash = sha256(fs.readFileSync(installer));
  console.log(`${arch}: verified ${asset.filename} (${actualHash}), extracted ${asset.binaries.join(', ')}`);
}
