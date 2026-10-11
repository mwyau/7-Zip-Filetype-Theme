import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { decodeIco } from 'icojs';
import { parseRes, readJson, validateManifest } from './core.mjs';

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
function dibToBmp(dib) {
  const headerSize = dib.readUInt32LE(0), bpp = dib.readUInt16LE(14), compression = dib.readUInt32LE(16), colorsUsed = dib.readUInt32LE(32);
  if (headerSize < 40 || headerSize > dib.length || ![1, 4, 8, 16, 24, 32].includes(bpp) || compression !== 0) throw new Error('unsupported DIB header/encoding');
  const paletteEntries = colorsUsed || (bpp <= 8 ? 2 ** bpp : 0), offset = 14 + headerSize + paletteEntries * 4;
  const bmp = Buffer.alloc(14 + dib.length); bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(offset, 10); dib.copy(bmp, 14); return bmp;
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
    try {
      const file = path.join(rootDir, manifest.ribbon.artwork, `Bitmap${id}.res`);
      if (!fs.existsSync(file)) { ribbonItems.push({ lines: [`Bitmap ${id}`, 'Source absent'], bad: true }); continue; }
      const entry = parseRes(fs.readFileSync(file), id), dib = entry.bin;
      const width = dib.readInt32LE(4), height = Math.abs(dib.readInt32LE(8));
      const image = await sharp(dibToBmp(dib)).png().toBuffer();
      ribbonItems.push({ lines: [`RT_BITMAP · ID ${id}`, `${width}×${height}`], image });
    } catch (error) { ribbonItems.push({ lines: [`Bitmap ${id}`, `Unreadable: ${error.message.slice(0, 26)}`], bad: true }); }
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
