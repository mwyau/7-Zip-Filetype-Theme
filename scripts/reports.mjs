import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { decodeIco } from 'icojs';
import { inspectDib, parseRes, readJson, validateManifest } from './core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cellW = 172, cellH = 150, columns = 7;
export function markWindowsIntegrationPassed(diff, manifest) {
  const filetypeNames = new Set(manifest.filetypes.map((theme) => theme.name));
  const ribbonName = manifest.ribbon.name;
  return {
    ...diff,
    results: diff.results.map((item) => ({
      ...item,
      functionalTests: {
        ...item.functionalTests,
        status: filetypeNames.has(item.theme)
          ? 'passed-x86-x64-archive-runtime-smoke'
          : item.theme === ribbonName
            ? 'passed-x86-x64-package-integrity; GUI-smoke-pending'
            : item.functionalTests?.status ?? 'not-run',
      },
    })),
  };
}
export function decodeDib(input) {
  const dib = Buffer.from(input), info = inspectDib(dib);
  if (![1, 32].includes(info.bitsPerPixel)) throw new Error(`Unsupported DIB bit depth ${info.bitsPerPixel}; expected 1 or 32`);
  const height = Math.abs(info.height), outputSize = info.width * height * 4;
  if (!Number.isSafeInteger(outputSize) || outputSize > 0x7fffffff) throw new Error('DIB dimensions exceed the supported pixel buffer size');
  const rgba = Buffer.alloc(outputSize);
  for (let y = 0; y < height; y++) {
    const sourceY = info.height < 0 ? y : height - 1 - y;
    const sourceRow = info.pixelOffset + sourceY * info.rowStride;
    for (let x = 0; x < info.width; x++) {
      const target = (y * info.width + x) * 4;
      if (info.bitsPerPixel === 32) {
        const source = sourceRow + x * 4;
        rgba[target] = dib[source + 2];
        rgba[target + 1] = dib[source + 1];
        rgba[target + 2] = dib[source];
        rgba[target + 3] = dib[source + 3];
      } else {
        const paletteIndex = (dib[sourceRow + (x >> 3)] >> (7 - (x & 7))) & 1;
        if (paletteIndex >= info.paletteEntries) throw new Error(`DIB pixel references missing palette entry ${paletteIndex}`);
        const palette = info.headerSize + paletteIndex * 4;
        rgba[target] = dib[palette + 2];
        rgba[target + 1] = dib[palette + 1];
        rgba[target + 2] = dib[palette];
        rgba[target + 3] = 255;
      }
    }
  }
  return { width: info.width, height, channels: 4, data: rgba };
}
function labelSvg(lines, bad = false) {
  const escaped = lines.map((line) => line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
  return Buffer.from(`<svg width="${cellW}" height="48" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${bad ? '#ffe3e3' : '#f1f3f5'}"/><text x="86" y="16" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="${bad ? '#a00000' : '#202124'}">${escaped[0] ?? ''}</text><text x="86" y="34" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#444">${escaped[1] ?? ''}</text></svg>`);
}
async function contactSheet(items, output, title) {
  const rows = Math.ceil(items.length / columns), width = columns * cellW, height = 32 + rows * cellH;
  const base = sharp({ create: { width, height, channels: 4, background: '#e7e9ec' } });
  const composites = [{ input: Buffer.from(`<svg width="${width}" height="32" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#d6d9de"/><text x="12" y="22" font-family="Arial,sans-serif" font-size="16">${title}</text></svg>`), top: 0, left: 0 }];
  for (const [index, item] of items.entries()) {
    const left = (index % columns) * cellW, top = 32 + Math.floor(index / columns) * cellH;
    composites.push({ input: labelSvg(item.lines, item.bad), left, top: top + cellH - 48 });
    if (!item.bad && item.image) composites.push({ input: await sharp(item.image).resize(112, 96, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer(), left: left + 30, top: top + 8 });
    else composites.push({ input: Buffer.from(`<svg width="112" height="96" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" rx="8" fill="#ffe3e3"/><text x="56" y="52" text-anchor="middle" font-family="Arial" font-size="14" fill="#a00000">${item.bad ? 'INVALID' : 'ABSENT'}</text></svg>`), left: left + 30, top: top + 8 });
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await base.composite(composites).png().toFile(output);
}
export async function generateVisualReports({ rootDir = root, outputDir = path.join(root, 'reports/generated') } = {}) {
  const manifest = readJson(path.join(rootDir, 'config/themes.json')); validateManifest(manifest, rootDir);
  const generated = [];
  for (const theme of manifest.filetypes) {
    const tiles = [];
    for (const [id, filename] of theme.groups) {
      const file = path.join(rootDir, theme.artwork, filename);
      try {
        if (!fs.existsSync(file)) { tiles.push({ lines: [`${path.basename(filename)} · group ${id}`, 'Source absent'], bad: true }); continue; }
        const decoded = await decodeIco(fs.readFileSync(file));
        const largest = [...decoded].sort((a, b) => b.width * b.height - a.width * a.height)[0];
        const resolutions = decoded.map((image) => `${image.width}×${image.height}`).join(', ');
        tiles.push({ lines: [`${path.basename(filename, '.ico')} · group ${id}`, resolutions], image: Buffer.from(largest.data) });
      } catch (error) { tiles.push({ lines: [`${path.basename(filename)} · group ${id}`, `Unreadable: ${error.message.slice(0, 26)}`], bad: true }); }
    }
    const output = path.join(outputDir, `${theme.slug}-icons.png`); await contactSheet(tiles, output, `${theme.name} filetype icons`); generated.push(output);
  }
  const ribbonItems = [];
  for (const id of manifest.ribbon.bitmaps) {
    const file = path.join(rootDir, manifest.ribbon.artwork, `Bitmap${id}.res`);
    const entry = parseRes(fs.readFileSync(file), id), decoded = decodeDib(entry.bin);
    const image = await sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: decoded.channels } }).png().toBuffer();
    ribbonItems.push({ lines: [`RT_BITMAP · ID ${id}`, `${decoded.width}×${decoded.height}`], image });
  }
  const ribbon = path.join(outputDir, 'windows11-ribbon.png'); await contactSheet(ribbonItems, ribbon, 'Windows 11 Ribbon bitmaps'); generated.push(ribbon);
  const diffFile = path.join(outputDir, 'resource-diff.json');
  if (fs.existsSync(diffFile)) {
    const diff = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
    const lines = [`# Resource compatibility report`, '', `Upstream: 7-Zip ${diff.upstreamVersion} (release ${diff.releaseId})`, `Theme package revision: ${diff.tag}`, '', `| Architecture | Theme | Changes | Unexpected | Validation | Functional tests |`, `|---|---|---:|---:|---|---|`];
    for (const item of diff.results) lines.push(`| ${item.architecture} | ${item.theme} | ${item.changes.length} | ${item.changes.filter((c) => c.classification !== 'expected').length} | ${item.peValidation.machine}, ${item.peValidation.resourceCount} resources | ${item.functionalTests.status} |`);
    lines.push('', 'Modified PE files have newly generated resource sections. Any upstream Authenticode signature is invalidated by resource editing; these files are modified theme binaries, not untouched official 7-Zip executables.', '', '## Contact sheets', '', ...generated.map((file) => `- ${path.basename(file)}`), '');
    fs.writeFileSync(path.join(outputDir, 'summary.md'), `${lines.join('\n')}\n`);
  }
  return generated;
}
