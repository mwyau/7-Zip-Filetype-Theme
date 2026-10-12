import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as PE from 'pe-library';

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export function verifyAsset(data, expected, label = 'asset') {
  if (data.length !== expected.size) throw new Error(`${label}: size mismatch (${data.length} != ${expected.size})`);
  const actual = sha256(data);
  if (actual !== expected.sha256) throw new Error(`${label}: SHA-256 mismatch (${actual})`);
  return actual;
}
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

export function validateManifest(manifest, root = process.cwd()) {
  if (!Number.isInteger(manifest.resourceLanguage) || !Array.isArray(manifest.filetypes) || manifest.filetypes.length === 0) throw new Error('Invalid theme manifest shape');
  const slugs = new Set();
  for (const theme of manifest.filetypes) {
    if (!theme.name || !/^[a-z0-9-]+$/.test(theme.slug) || slugs.has(theme.slug)) throw new Error(`Invalid or duplicate theme slug: ${theme.slug}`);
    slugs.add(theme.slug);
    if (!Array.isArray(theme.groups) || theme.groups.length === 0) throw new Error(`${theme.slug}: no icon groups`);
    const ids = new Set();
    for (const [id, source] of theme.groups) {
      if (!Number.isInteger(id) || id < 0 || ids.has(id)) throw new Error(`${theme.slug}: duplicate or invalid icon-group ID ${id}`);
      ids.add(id);
      if (!source || !fs.existsSync(path.join(root, theme.artwork, source))) throw new Error(`${theme.slug}: missing artwork ${source}`);
    }
    if (ids.size !== 27 || Array.from({ length: 27 }, (_, i) => ids.has(i)).some((found) => !found)) throw new Error(`${theme.slug}: must map every icon group 0–26 exactly once`);
  }
  const ribbon = manifest.ribbon;
  if (!ribbon || !Array.isArray(ribbon.bitmaps) || new Set(ribbon.bitmaps).size !== ribbon.bitmaps.length) throw new Error('Invalid ribbon bitmap mapping');
  for (const id of ribbon.bitmaps) if (!fs.existsSync(path.join(root, ribbon.artwork, `Bitmap${id}.res`))) throw new Error(`Missing ribbon Bitmap${id}.res`);
  return true;
}

function readResName(buffer, state, limit) {
  if (state.offset + 2 > limit) throw new Error('Truncated .res type/name field');
  const first = buffer.readUInt16LE(state.offset);
  if (first === 0xffff) {
    if (state.offset + 4 > limit) throw new Error('Truncated .res ordinal field');
    const value = buffer.readUInt16LE(state.offset + 2); state.offset += 4;
    return { value, ordinal: true };
  }
  let value = '';
  while (state.offset + 2 <= limit) {
    const code = buffer.readUInt16LE(state.offset); state.offset += 2;
    if (code === 0) return { value, ordinal: false };
    value += String.fromCharCode(code);
  }
  throw new Error('Unterminated .res name field');
}

export function inspectDib(input) {
  const dib = Buffer.from(input);
  if (dib.length < 40) throw new Error('DIB payload is shorter than BITMAPINFOHEADER');
  const headerSize = dib.readUInt32LE(0);
  if (headerSize < 40 || headerSize > dib.length) throw new Error('Invalid DIB header size');
  const width = dib.readInt32LE(4), height = dib.readInt32LE(8);
  const planes = dib.readUInt16LE(12), bitsPerPixel = dib.readUInt16LE(14);
  const compression = dib.readUInt32LE(16), declaredImageSize = dib.readUInt32LE(20);
  const colorsUsed = dib.readUInt32LE(32);
  if (width <= 0 || height === 0) throw new Error(`Invalid DIB dimensions ${width}x${height}`);
  if (planes !== 1) throw new Error(`Invalid DIB plane count ${planes}`);
  if (![1, 4, 8, 16, 24, 32].includes(bitsPerPixel)) throw new Error(`Unsupported DIB bit depth ${bitsPerPixel}`);
  if (compression !== 0) throw new Error(`Unsupported DIB compression ${compression}; expected BI_RGB`);

  const paletteEntries = colorsUsed || (bitsPerPixel <= 8 ? 2 ** bitsPerPixel : 0);
  if (bitsPerPixel <= 8 && paletteEntries > 2 ** bitsPerPixel) throw new Error('DIB palette exceeds its bit depth');
  const paletteBytes = paletteEntries * 4;
  const pixelOffset = headerSize + paletteBytes;
  const rowStride = Math.ceil((width * bitsPerPixel) / 32) * 4;
  const pixelBytes = rowStride * Math.abs(height);
  if (!Number.isSafeInteger(pixelBytes) || !Number.isSafeInteger(pixelOffset)) throw new Error('DIB dimensions exceed safe validation limits');
  if (pixelOffset > dib.length) throw new Error('DIB color table exceeds payload boundary');
  if (declaredImageSize !== 0 && declaredImageSize < pixelBytes) throw new Error('DIB declared image size is shorter than its pixel array');
  const imageBytes = declaredImageSize || pixelBytes;
  if (pixelOffset + imageBytes > dib.length) throw new Error('DIB pixel array exceeds payload boundary');
  return {
    headerSize, width, height, planes, bitsPerPixel, compression, declaredImageSize,
    rowStride, pixelOffset, pixelBytes, paletteEntries, paletteBytes,
    extraDeclaredImageBytes: Math.max(0, imageBytes - pixelBytes),
    trailingBytes: dib.length - pixelOffset - imageBytes,
  };
}

function inspectIconPayload(input) {
  const bin = Buffer.from(input);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bin.length >= 33 && bin.subarray(0, 8).equals(pngSignature)) {
    const chunkLength = bin.readUInt32BE(8);
    if (chunkLength !== 13 || bin.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG icon IHDR chunk');
    const width = bin.readUInt32BE(16), height = bin.readUInt32BE(20);
    if (width < 1 || height < 1) throw new Error('Invalid PNG icon dimensions');
    return { format: 'png', width, height, planes: 1, bitsPerPixel: null };
  }
  if (bin.length < 40 || bin.readUInt32LE(0) < 40) throw new Error('ICO DIB payload is shorter than BITMAPINFOHEADER');
  const doubledHeight = bin.readInt32LE(8);
  if (doubledHeight <= 0 || doubledHeight % 2 !== 0) throw new Error('ICO DIB height must be positive and contain an even XOR/AND height');
  const normalizedDib = Buffer.from(bin);
  normalizedDib.writeInt32LE(doubledHeight / 2, 8);
  const dib = inspectDib(normalizedDib);
  return { format: 'dib', width: dib.width, height: dib.height, planes: dib.planes, bitsPerPixel: dib.bitsPerPixel, dib };
}

export function parseIco(input, label = 'ICO') {
  const bin = Buffer.from(input);
  if (bin.length < 6 || bin.readUInt16LE(0) !== 0 || bin.readUInt16LE(2) !== 1) throw new Error(`${label}: invalid ICONDIR header`);
  const count = bin.readUInt16LE(4);
  const tableEnd = 6 + count * 16;
  if (count === 0 || tableEnd > bin.length) throw new Error(`${label}: truncated or empty ICO directory`);
  const images = [];
  const ranges = [];
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16;
    const widthByte = bin[offset], heightByte = bin[offset + 1], colorCount = bin[offset + 2], reserved = bin[offset + 3];
    const planes = bin.readUInt16LE(offset + 4), bitsPerPixel = bin.readUInt16LE(offset + 6);
    const bytesInRes = bin.readUInt32LE(offset + 8), imageOffset = bin.readUInt32LE(offset + 12);
    if (reserved !== 0 || bytesInRes === 0 || imageOffset < tableEnd || imageOffset > bin.length || bytesInRes > bin.length - imageOffset) {
      throw new Error(`${label}: invalid ICO image directory entry ${index}`);
    }
    const payload = Buffer.from(bin.subarray(imageOffset, imageOffset + bytesInRes));
    const info = inspectIconPayload(payload);
    const width = widthByte || 256, height = heightByte || 256;
    if (info.width !== width || info.height !== height) throw new Error(`${label}: directory dimensions ${width}x${height} do not match image ${index} dimensions ${info.width}x${info.height}`);
    if (info.format === 'dib' && ((planes !== 0 && planes !== info.planes) || (bitsPerPixel !== 0 && bitsPerPixel !== info.bitsPerPixel))) {
      throw new Error(`${label}: ICO metadata does not match DIB image ${index}`);
    }
    for (const range of ranges) {
      const overlaps = imageOffset < range.end && imageOffset + bytesInRes > range.start;
      const identical = imageOffset === range.start && imageOffset + bytesInRes === range.end;
      if (overlaps && !identical) throw new Error(`${label}: overlapping image payloads in entries ${index} and ${range.index}`);
    }
    ranges.push({ start: imageOffset, end: imageOffset + bytesInRes, index });
    images.push({ widthByte, heightByte, colorCount, reserved, planes, bitsPerPixel, bytesInRes, bin: payload, info });
  }
  return images;
}

function normalizedMenuLabel(label) { return label.replaceAll('&', '').replace(/\t.*$/, '').trim().toLocaleLowerCase('en-US'); }

export function findMenuCommand(menuInput, parentLabel, childLabel) {
  const buffer = Buffer.from(menuInput);
  if (buffer.length < 12 || buffer.readUInt16LE(0) !== 1) throw new Error('Unsupported or truncated MENUEX resource');
  const itemOffset = 4 + buffer.readUInt16LE(2);
  if (itemOffset < 8 || itemOffset + 4 > buffer.length) throw new Error('Invalid MENUEX header offset');
  const state = { offset: itemOffset + 4 }; // The DWORD following wOffset is the menu help ID.
  const align = () => { state.offset = (state.offset + 3) & ~3; };
  const readText = () => {
    let text = '';
    while (state.offset + 2 <= buffer.length) {
      const character = buffer.readUInt16LE(state.offset); state.offset += 2;
      if (character === 0) return text;
      text += String.fromCharCode(character);
    }
    throw new Error('Unterminated MENUEX item label');
  };
  const readLevel = () => {
    const items = [];
    while (state.offset + 14 <= buffer.length) {
      const type = buffer.readUInt32LE(state.offset), itemState = buffer.readUInt32LE(state.offset + 4);
      const id = buffer.readUInt32LE(state.offset + 8), flags = buffer.readUInt16LE(state.offset + 12);
      state.offset += 14;
      const label = readText(), item = { type, state: itemState, id, flags, label, children: [] };
      if (flags & 1) {
        align();
        if (state.offset + 4 > buffer.length) throw new Error('Truncated MENUEX popup help ID');
        state.offset += 4;
        item.children = readLevel();
      }
      items.push(item);
      if (flags & 0x80) return items;
      align();
    }
    throw new Error('MENUEX level has no terminating item');
  };
  const items = readLevel();
  const parents = items.filter((item) => normalizedMenuLabel(item.label) === normalizedMenuLabel(parentLabel));
  if (parents.length !== 1) throw new Error(`MENUEX must contain exactly one ${parentLabel} menu`);
  const children = parents[0].children.filter((item) => normalizedMenuLabel(item.label) === normalizedMenuLabel(childLabel));
  if (children.length !== 1 || (children[0].flags & 1) || children[0].id === 0) throw new Error(`MENUEX must contain exactly one command for ${parentLabel} > ${childLabel}`);
  return children[0].id;
}

export function findMenuCommandInExecutable(input, language, parentLabel, childLabel) {
  const exe = PE.NtExecutable.from(input, { ignoreCert: true });
  const menus = PE.NtExecutableResource.from(exe).entries.filter((entry) => entry.type === 4 && Number(entry.lang) === language);
  const matches = [];
  for (const entry of menus) {
    try { matches.push({ menuId: Number(entry.id), language: Number(entry.lang), commandId: findMenuCommand(entry.bin, parentLabel, childLabel) }); }
    catch (error) {
      if (String(error.message).includes(`exactly one ${parentLabel} menu`) || String(error.message).includes(`exactly one command for ${parentLabel}`)) continue;
      throw error;
    }
  }
  if (matches.length !== 1) throw new Error(`Expected one ${parentLabel} > ${childLabel} menu command in language ${language}; found ${matches.length}`);
  return matches[0];
}

export function parseRes(input, expectedId) {
  const buffer = Buffer.from(input); let offset = 0; const records = [];
  while (offset < buffer.length) {
    if (buffer.length - offset < 8) throw new Error('Truncated .res record header');
    const dataSize = buffer.readUInt32LE(offset), headerSize = buffer.readUInt32LE(offset + 4);
    if (headerSize < 24 || headerSize > buffer.length - offset || dataSize > buffer.length - offset - headerSize) throw new Error('Invalid .res record boundary');
    const state = { offset: offset + 8 };
    const type = readResName(buffer, state, offset + headerSize);
    const id = readResName(buffer, state, offset + headerSize);
    state.offset = (state.offset + 3) & ~3;
    if (state.offset + 16 !== offset + headerSize) throw new Error('Unexpected .res header layout');
    const dataVersion = buffer.readUInt32LE(state.offset);
    const memoryFlags = buffer.readUInt16LE(state.offset + 4);
    const language = buffer.readUInt16LE(state.offset + 6);
    const version = buffer.readUInt32LE(state.offset + 8);
    const characteristics = buffer.readUInt32LE(state.offset + 12);
    const nullHeader = dataSize === 0 && type.ordinal && id.ordinal && type.value === 0 && id.value === 0;
    if (nullHeader && records.length === 0) {
      offset = (offset + headerSize + 3) & ~3;
      continue;
    }
    if (!type.ordinal || type.value !== 2 || !id.ordinal || id.value !== expectedId) throw new Error(`Unexpected .res record type/id; expected RT_BITMAP/${expectedId}`);
    if (dataVersion !== 0 || version !== 0 || characteristics !== 0 || !Number.isInteger(language)) throw new Error('Unexpected .res metadata');
    const start = offset + headerSize;
    const payload = Buffer.from(buffer.subarray(start, start + dataSize));
    const dib = inspectDib(payload);
    records.push({ type: 2, id: id.value, lang: language, bin: payload, dib });
    offset = (start + dataSize + 3) & ~3;
  }
  if (offset !== buffer.length || records.length !== 1) throw new Error(`Expected exactly one RT_BITMAP/${expectedId} record`);
  return records[0];
}

function key(entry) {
  const id = typeof entry.id === 'string' ? `s${encodeURIComponent(entry.id)}` : entry.id;
  return `${entry.type}:${id}:${entry.lang ?? entry.language}`;
}
function entriesMap(entries) { return new Map(entries.map((entry) => [key(entry), Buffer.from(entry.bin)])); }
export function validateResourceOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error('Native resource update requires a nonempty operation list');
  const seen = new Set();
  return operations.map((operation) => {
    const { type, id, language, action } = operation ?? {};
    if (![2, 3, 14].includes(type)) throw new Error(`Unsupported native resource type ${type}`);
    if (typeof id === 'number' && (!Number.isInteger(id) || id < 1 || id > 0xffff)) throw new Error(`Invalid numeric resource ordinal ${id}; Win32 resource APIs cannot distinguish ordinal zero from a null name`);
    if (typeof id === 'string' && (id.length === 0 || id.length > 255 || id.includes('\0'))) throw new Error('Invalid named resource ID');
    if (typeof id !== 'number' && typeof id !== 'string') throw new Error(`Invalid resource ID ${id}`);
    if (!Number.isInteger(language) || language < 0 || language > 0xffff) throw new Error(`Invalid resource language ${language}`);
    if (!['update', 'delete'].includes(action)) throw new Error(`Invalid resource action ${action}`);
    const resourceKey = `${type}:${typeof id === 'string' ? `s${encodeURIComponent(id)}` : id}:${language}`;
    if (seen.has(resourceKey)) throw new Error(`Duplicate native resource operation ${resourceKey}`);
    seen.add(resourceKey);
    if (action === 'update' && (!Buffer.isBuffer(operation.bin) || operation.bin.length === 0)) throw new Error(`Update ${resourceKey} requires nonempty binary data`);
    if (action === 'delete' && operation.bin !== null) throw new Error(`Delete ${resourceKey} must not include payload data`);
    return { type, id, language, action, bin: action === 'update' ? Buffer.from(operation.bin) : null };
  });
}
function assertResourceKeys(entries) {
  const seen = new Set();
  for (const entry of entries) { const k = key(entry); if (seen.has(k)) throw new Error(`Duplicate resource key ${k}`); seen.add(k); }
}
export function parseGroupIcon(input, label = 'RT_GROUP_ICON') {
  const bin = Buffer.from(input);
  if (bin.length < 6 || bin.readUInt16LE(0) !== 0 || bin.readUInt16LE(2) !== 1) throw new Error(`${label}: invalid GRPICONDIR header`);
  const count = bin.readUInt16LE(4);
  if (count === 0 || bin.length !== 6 + count * 14) throw new Error(`${label}: malformed GRPICONDIR entry table`);
  const icons = [];
  const seenIds = new Set();
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 14;
    const id = bin.readUInt16LE(offset + 12);
    if (id === 0 || seenIds.has(id)) throw new Error(`${label}: invalid or duplicate RT_ICON ID ${id}`);
    seenIds.add(id);
    icons.push({
      widthByte: bin[offset], heightByte: bin[offset + 1], colorCount: bin[offset + 2], reserved: bin[offset + 3],
      planes: bin.readUInt16LE(offset + 4), bitsPerPixel: bin.readUInt16LE(offset + 6), bytesInRes: bin.readUInt32LE(offset + 8), id,
    });
  }
  return icons;
}

export function buildGroupIcon(images) {
  if (!Array.isArray(images) || images.length === 0 || images.length > 0xffff) throw new Error('A group icon must contain at least one image');
  const output = Buffer.alloc(6 + images.length * 14);
  output.writeUInt16LE(0, 0); output.writeUInt16LE(1, 2); output.writeUInt16LE(images.length, 4);
  const seenIds = new Set();
  images.forEach((image, index) => {
    if (!Number.isInteger(image.id) || image.id < 1 || image.id > 0xffff || seenIds.has(image.id)) throw new Error(`Invalid or duplicate RT_ICON ID ${image.id}`);
    if (!Number.isInteger(image.bytesInRes) || image.bytesInRes < 1 || image.bytesInRes > 0xffffffff) throw new Error('Invalid RT_ICON byte length');
    seenIds.add(image.id);
    const offset = 6 + index * 14;
    output[offset] = image.widthByte; output[offset + 1] = image.heightByte;
    output[offset + 2] = image.colorCount; output[offset + 3] = image.reserved;
    output.writeUInt16LE(image.planes, offset + 4); output.writeUInt16LE(image.bitsPerPixel, offset + 6);
    output.writeUInt32LE(image.bytesInRes, offset + 8); output.writeUInt16LE(image.id, offset + 12);
  });
  return output;
}

export function allocateIconImages(payloads, reservedIds = []) {
  if (!Array.isArray(payloads)) throw new Error('Icon payload allocation requires an array');
  const reserved = new Set();
  for (const id of reservedIds) {
    if (!Number.isInteger(id) || id < 1 || id > 0xffff) throw new Error(`Invalid reserved RT_ICON ID ${id}`);
    reserved.add(id);
  }
  let nextId = 1, duplicatePayloadCount = 0;
  const buckets = new Map(), imagesById = new Map(), ids = [];
  for (const input of payloads) {
    if (!Buffer.isBuffer(input) || input.length === 0) throw new Error('RT_ICON image payloads must be nonempty Buffers');
    const bin = Buffer.from(input), hash = sha256(bin), bucket = buckets.get(hash) ?? [];
    const existing = bucket.find((image) => image.bin.equals(bin));
    if (existing) { ids.push(existing.id); duplicatePayloadCount++; continue; }
    while (nextId <= 0xffff && reserved.has(nextId)) nextId++;
    if (nextId > 0xffff) throw new Error('No collision-free RT_ICON IDs remain');
    const image = { id: nextId++, bin, sha256: hash };
    reserved.add(image.id); bucket.push(image); buckets.set(hash, bucket); imagesById.set(image.id, image); ids.push(image.id);
  }
  return { ids, images: [...imagesById.values()].sort((a, b) => a.id - b.id), duplicatePayloadCount };
}

function assertIconIntegrity(entries) {
  assertResourceKeys(entries);
  const byKey = entriesMap(entries), refs = new Set();
  const groups = entries.filter((entry) => Number(entry.type) === 14);
  for (const group of groups) {
    for (const icon of parseGroupIcon(group.bin, `RT_GROUP_ICON/${group.id}/${group.lang}`)) {
      const iconKey = `3:${icon.id}:${group.lang}`;
      const payload = byKey.get(iconKey);
      if (!payload) throw new Error(`Dangling RT_ICON reference ${iconKey} from group ${group.id}`);
      if (payload.length !== icon.bytesInRes) throw new Error(`RT_GROUP_ICON/${group.id}/${group.lang} declares ${icon.bytesInRes} bytes for ${iconKey}, found ${payload.length}`);
      const info = inspectIconPayload(payload);
      const expectedWidth = icon.widthByte || 256, expectedHeight = icon.heightByte || 256;
      if (info.width !== expectedWidth || info.height !== expectedHeight) throw new Error(`RT_GROUP_ICON/${group.id}/${group.lang} dimensions do not match ${iconKey}`);
      refs.add(iconKey);
    }
  }
  const orphan = entries.find((entry) => Number(entry.type) === 3 && !refs.has(key(entry)));
  if (orphan) throw new Error(`Orphan RT_ICON resource ${key(orphan)}`);
  return { groupCount: groups.length, iconResourceCount: entries.filter((entry) => Number(entry.type) === 3).length, referenceCount: refs.size };
}
export function validateIconResourceGraph(entries) { return assertIconIntegrity(entries); }
function relocationRecords(exe) {
  const directory = exe.newHeader.optionalHeaderDataDirectory.get(5);
  if (!directory.size) return [];
  const section = exe.getAllSections().find((item) => directory.virtualAddress >= item.info.virtualAddress && directory.virtualAddress < item.info.virtualAddress + item.info.sizeOfRawData);
  if (!section) throw new Error('Base relocation directory does not map to a PE section');
  const start = directory.virtualAddress - section.info.virtualAddress;
  if (start + directory.size > section.data.byteLength) throw new Error('Base relocation directory exceeds its PE section');
  const bin = Buffer.from(section.data).subarray(start, start + directory.size), result = [];
  let offset = 0;
  while (offset + 8 <= bin.length) {
    const page = bin.readUInt32LE(offset), blockSize = bin.readUInt32LE(offset + 4);
    if (page === 0 && blockSize === 0 && bin.subarray(offset).every((byte) => byte === 0)) break;
    if (blockSize < 8 || blockSize % 2 !== 0 || offset + blockSize > bin.length) throw new Error('Malformed PE base-relocation block');
    const entries = [];
    for (let p = offset + 8; p < offset + blockSize; p += 2) entries.push(bin.readUInt16LE(p));
    result.push([page, entries]); offset += blockSize;
  }
  if (offset < bin.length && !bin.subarray(offset).every((byte) => byte === 0)) throw new Error('Unexpected trailing base-relocation data');
  return result;
}
export function planIconPatch(input, theme, language, root = process.cwd()) {
  const exe = PE.NtExecutable.from(input, { ignoreCert: true });
  const entries = PE.NtExecutableResource.from(exe).entries;
  assertResourceKeys(entries);
  const graph = assertIconIntegrity(entries);
  if (!Number.isInteger(language) || language < 0 || language > 0xffff) throw new Error('Invalid icon resource language');
  const groupIds = theme.groups.map(([id]) => id).sort((a, b) => a - b);
  if (groupIds.length !== 27 || groupIds.some((id, index) => id !== index)) throw new Error(`${theme.slug}: expected exactly icon groups 0–26`);
  const originalGroups = entries.filter((entry) => Number(entry.type) === 14 && Number(entry.lang) === language).sort((a, b) => Number(a.id) - Number(b.id));
  if (originalGroups.length !== 27 || originalGroups.some((entry, index) => Number(entry.id) !== index || (index === 0 ? entry.id !== '0' : typeof entry.id !== 'number'))) {
    throw new Error(`${theme.slug}: upstream language ${language} must contain exactly RT_GROUP_ICON IDs 0–26`);
  }
  const originalGroupsById = new Map(originalGroups.map((entry) => [Number(entry.id), entry]));
  const oldIconKeys = new Set();
  for (const group of originalGroups) {
    for (const icon of parseGroupIcon(group.bin, `RT_GROUP_ICON/${group.id}/${language}`)) oldIconKeys.add(`3:${icon.id}:${language}`);
  }
  const originalIcons = entries.filter((entry) => Number(entry.type) === 3 && Number(entry.lang) === language);
  if (oldIconKeys.size !== originalIcons.length || originalIcons.some((entry) => !oldIconKeys.has(key(entry)))) {
    throw new Error(`${theme.slug}: language ${language} RT_ICON graph has unreferenced or non-target images`);
  }

  const reservedIds = entries.filter((entry) => Number(entry.type) === 3 && Number(entry.lang) === language && !oldIconKeys.has(key(entry))).map((entry) => Number(entry.id));
  const sourceDimensions = new Map(), formats = new Map();
  let sourceImageEntryCount = 0;
  const sourceGroups = [], sourcePayloads = [];
  for (const [groupId, filename] of [...theme.groups].sort((a, b) => a[0] - b[0])) {
    const sourcePath = path.join(root, theme.artwork, filename);
    const icoImages = parseIco(fs.readFileSync(sourcePath), `${theme.slug}/${filename}`);
    sourceImageEntryCount += icoImages.length;
    for (const image of icoImages) {
      sourcePayloads.push(image.bin);
      const sizeKey = `${image.info.width}x${image.info.height}`;
      sourceDimensions.set(sizeKey, (sourceDimensions.get(sizeKey) ?? 0) + 1);
      formats.set(image.info.format, (formats.get(image.info.format) ?? 0) + 1);
    }
    sourceGroups.push({ groupId, images: icoImages });
  }
  const allocation = allocateIconImages(sourcePayloads, reservedIds);
  const expectedGroups = [];
  let sourceImageIndex = 0;
  for (const { groupId, images } of sourceGroups) {
    const groupImages = images.map((image) => ({ ...image, id: allocation.ids[sourceImageIndex++] }));
    const upstreamGroup = originalGroupsById.get(groupId);
    expectedGroups.push({ type: 14, id: upstreamGroup.id, groupId, language, bin: buildGroupIcon(groupImages) });
  }

  const expectedImages = allocation.images.map((image) => ({ type: 3, id: image.id, language, bin: image.bin }));
  const expectedImageKeys = new Set(expectedImages.map(key));
  const obsoleteIconKeys = [...oldIconKeys].filter((iconKey) => !expectedImageKeys.has(iconKey));
  const operations = [
    ...expectedImages.map((image) => ({ type: 3, id: image.id, language, action: 'update', bin: image.bin })),
    ...expectedGroups.map((group) => ({ type: 14, id: group.id, language, action: 'update', bin: group.bin })),
    ...obsoleteIconKeys.map((iconKey) => {
      const [, id, oldLanguage] = iconKey.split(':').map(Number);
      return { type: 3, id, language: oldLanguage, action: 'delete', bin: null };
    }),
  ].sort((a, b) => a.type - b.type || a.id - b.id || a.language - b.language);
  const uniqueCount = expectedImages.length;
  const summary = {
    groupCount: expectedGroups.length,
    originalImageResourceCount: originalIcons.length,
    sourceImageEntryCount,
    uniqueImagePayloadCount: uniqueCount,
    duplicatePayloadEntryCount: sourceImageEntryCount - uniqueCount,
    repeatedPayloadReferences: allocation.duplicatePayloadCount,
    removedImageResourceCount: obsoleteIconKeys.length,
    formats: Object.fromEntries([...formats.entries()].sort()),
    dimensions: Object.fromEntries([...sourceDimensions.entries()].sort()),
    outputIconIdRange: expectedImages.length ? [expectedImages[0].id, expectedImages.at(-1).id] : [],
    sourcePayloadBytes: sourcePayloads.reduce((total, payload) => total + payload.length, 0),
    uniquePayloadBytes: expectedImages.reduce((total, image) => total + image.bin.length, 0),
    upstreamGraph: graph,
  };
  return { operations, expectedGroups, expectedImages, oldIconKeys: [...oldIconKeys], summary };
}

function checkNativePeSafety(beforeExe, afterExe) {
  const beforeHeader = beforeExe.newHeader, afterHeader = afterExe.newHeader;
  if (beforeHeader.fileHeader.machine !== afterHeader.fileHeader.machine) throw new Error('Native resource update changed the PE machine type');
  for (const field of ['timeDateStamp', 'pointerToSymbolTable', 'numberOfSymbols', 'characteristics', 'sizeOfOptionalHeader']) {
    if (beforeHeader.fileHeader[field] !== afterHeader.fileHeader[field]) throw new Error(`Native resource update changed PE file-header field ${field}`);
  }
  for (const field of [
    'magic', 'addressOfEntryPoint', 'baseOfCode', 'imageBase', 'sectionAlignment', 'fileAlignment',
    'majorOperatingSystemVersion', 'minorOperatingSystemVersion', 'majorImageVersion', 'minorImageVersion',
    'majorSubsystemVersion', 'minorSubsystemVersion', 'win32VersionValue', 'subsystem', 'dllCharacteristics',
    'sizeOfCode', 'sizeOfUninitializedData', 'sizeOfStackReserve', 'sizeOfStackCommit',
    'sizeOfHeapReserve', 'sizeOfHeapCommit', 'loaderFlags', 'numberOfRvaAndSizes',
  ]) {
    if (beforeHeader.optionalHeader[field] !== afterHeader.optionalHeader[field]) throw new Error(`Native resource update changed PE optional-header field ${field}`);
  }
  const directoriesBefore = beforeHeader.optionalHeaderDataDirectory, directoriesAfter = afterHeader.optionalHeaderDataDirectory;
  for (let index = 0; index < beforeHeader.optionalHeader.numberOfRvaAndSizes; index++) {
    if ([2, 4, 5].includes(index)) continue;
    if (JSON.stringify(directoriesBefore.get(index)) !== JSON.stringify(directoriesAfter.get(index))) throw new Error(`Native resource update changed PE data directory ${index}`);
  }
  const specialSection = (name) => name.toLowerCase().startsWith('.rsrc') || name === '.reloc';
  const beforeSections = beforeExe.getAllSections(), afterSections = afterExe.getAllSections();
  const normalSections = (sections) => sections.filter((section) => !specialSection(section.info.name));
  const beforeNormal = normalSections(beforeSections), afterNormal = normalSections(afterSections);
  if (beforeNormal.length !== afterNormal.length) throw new Error('Native resource update added or removed a non-resource PE section');
  for (const section of beforeNormal) {
    const matches = afterNormal.filter((candidate) => candidate.info.name === section.info.name);
    if (matches.length !== 1) throw new Error(`Native resource update changed non-resource section inventory for ${section.info.name}`);
    const after = matches[0];
    if (section.info.virtualAddress !== after.info.virtualAddress || section.info.virtualSize !== after.info.virtualSize ||
        section.info.sizeOfRawData !== after.info.sizeOfRawData || section.info.characteristics !== after.info.characteristics ||
        !Buffer.from(section.data).equals(Buffer.from(after.data))) {
      throw new Error(`Native resource update changed unrelated PE section ${section.info.name}`);
    }
  }
  if (afterHeader.fileHeader.numberOfSections !== afterSections.length) throw new Error('Native resource update produced an inconsistent PE section count');
  if (!afterSections.some((section) => section.info.name.toLowerCase().startsWith('.rsrc'))) throw new Error('Native resource update removed the PE resource section');
  if (JSON.stringify(relocationRecords(beforeExe)) !== JSON.stringify(relocationRecords(afterExe))) throw new Error('Native resource update changed PE base-relocation records');
}

export function verifyIconPatch(input, outputInput, plan) {
  const beforeExe = PE.NtExecutable.from(input, { ignoreCert: true });
  const output = Buffer.from(outputInput), afterExe = PE.NtExecutable.from(output);
  checkNativePeSafety(beforeExe, afterExe);
  const beforeEntries = PE.NtExecutableResource.from(beforeExe).entries, afterEntries = PE.NtExecutableResource.from(afterExe).entries;
  assertResourceKeys(beforeEntries); assertResourceKeys(afterEntries);
  assertIconIntegrity(afterEntries);
  const before = entriesMap(beforeEntries), after = entriesMap(afterEntries);
  const expectedGroups = new Map(plan.expectedGroups.map((entry) => [key(entry), entry.bin]));
  const expectedImages = new Map(plan.expectedImages.map((entry) => [key(entry), entry.bin]));
  for (const [resourceKey, payload] of [...expectedGroups, ...expectedImages]) {
    if (!after.has(resourceKey) || !after.get(resourceKey).equals(payload)) throw new Error(`Native icon resource payload mismatch for ${resourceKey}`);
  }
  const oldIconKeys = new Set(plan.oldIconKeys);
  const retainedImageKeys = new Set(beforeEntries.filter((entry) => Number(entry.type) === 3 && !oldIconKeys.has(key(entry))).map(key));
  const expectedImageKeys = new Set([...retainedImageKeys, ...expectedImages.keys()]);
  const actualImageKeys = new Set(afterEntries.filter((entry) => Number(entry.type) === 3).map(key));
  if (expectedImageKeys.size !== actualImageKeys.size || [...expectedImageKeys].some((resourceKey) => !actualImageKeys.has(resourceKey))) {
    throw new Error('Native icon patch left obsolete RT_ICON resources or removed retained images');
  }
  const intended = new Set([...plan.oldIconKeys, ...expectedImages.keys(), ...expectedGroups.keys()]);
  const changes = diffResourceMaps(before, after, (resourceKey) => intended.has(resourceKey));
  const unexpected = changes.filter((change) => change.classification !== 'expected');
  if (unexpected.length) throw new Error(`Native icon patch changed unrelated resources: ${JSON.stringify(unexpected)}`);
  const groupKeys = afterEntries.filter((entry) => Number(entry.type) === 14 && Number(entry.lang) === Number(plan.expectedGroups[0]?.language)).map(key).sort();
  if (groupKeys.length !== expectedGroups.size || [...expectedGroups.keys()].some((resourceKey) => !groupKeys.includes(resourceKey))) {
    throw new Error('Native icon patch changed the target RT_GROUP_ICON inventory');
  }
  return { output, changes, machine: afterExe.newHeader.fileHeader.machine, iconResources: plan.summary };
}

export function readRibbonBitmaps(bitmapFiles, expectedIds, language) {
  if (!Array.isArray(expectedIds) || expectedIds.length === 0 || !Number.isInteger(language) || language < 0 || language > 0xffff) throw new Error('Invalid Ribbon resource mapping');
  const seen = new Set();
  return expectedIds.map((id) => {
    if (!Number.isInteger(id) || id < 1 || id > 0xffff || seen.has(id)) throw new Error(`Duplicate or invalid Ribbon bitmap ID ${id}`);
    seen.add(id);
    const record = parseRes(fs.readFileSync(bitmapFiles(id)), id);
    if (record.lang !== language) throw new Error(`Bitmap ${id} language ${record.lang} != ${language}`);
    return record;
  });
}

export function verifyRibbonBitmaps(input, outputInput, records, expectedIds, language) {
  const original = PE.NtExecutable.from(input, { ignoreCert: true });
  const output = Buffer.from(outputInput);
  const checkedExe = PE.NtExecutable.from(output);
  checkNativePeSafety(original, checkedExe);
  const beforeEntries = PE.NtExecutableResource.from(original).entries;
  const afterEntries = PE.NtExecutableResource.from(checkedExe).entries;
  assertResourceKeys(beforeEntries); assertResourceKeys(afterEntries);
  const before = entriesMap(beforeEntries), after = entriesMap(afterEntries);
  if (before.size !== after.size || [...before.keys()].some((resourceKey) => !after.has(resourceKey))) throw new Error('Native resource update added or removed unrelated resource entries');
  const expected = new Map(records.map((record) => [key(record), record]));
  if (expected.size !== expectedIds.length) throw new Error('Ribbon update list does not cover every expected bitmap exactly once');
  for (const id of expectedIds) {
    const resourceKey = `2:${id}:${language}`, record = expected.get(resourceKey);
    if (!record) throw new Error(`Ribbon update is missing RT_BITMAP/${id}/${language}`);
    if (!before.has(resourceKey)) throw new Error(`Required RT_BITMAP/${id}/${language} is missing from upstream PE`);
    const actual = after.get(resourceKey);
    if (!actual || !actual.equals(record.bin)) throw new Error(`Native resource update payload mismatch for RT_BITMAP/${id}/${language}`);
  }
  const changes = diffResourceMaps(before, after, (resourceKey) => expected.has(resourceKey));
  const unexpected = changes.filter((change) => change.classification !== 'expected');
  if (unexpected.length) throw new Error(`Native resource update changed unrelated resources: ${JSON.stringify(unexpected)}`);
  return { output, changes, machine: checkedExe.newHeader.fileHeader.machine };
}

export function diffResourceMaps(before, after, intended = () => false) {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.map((k) => {
    const oldData = before.get(k), newData = after.get(k);
    if (oldData && newData && oldData.equals(newData)) return null;
    const [typeText, idText, languageText] = k.split(':');
    const namedId = idText.startsWith('s');
    const id = namedId ? decodeURIComponent(idText.slice(1)) : Number(idText);
    return { type: Number(typeText), id, ...(namedId ? { idType: 'name' } : {}), language: Number(languageText), change: !oldData ? 'added' : !newData ? 'removed' : 'replaced', oldSha256: oldData ? sha256(oldData) : null, newSha256: newData ? sha256(newData) : null, classification: intended(k) ? 'expected' : 'unexpected' };
  }).filter(Boolean);
}

export function parseVersionInfo(input) {
  const bin = Buffer.from(input);
  if (bin.length < 6) throw new Error('Truncated VS_VERSION_INFO root block');
  const rootLength = bin.readUInt16LE(0), valueLength = bin.readUInt16LE(2), type = bin.readUInt16LE(4);
  if (rootLength < 6 || rootLength > bin.length || type !== 0) throw new Error('Invalid VS_VERSION_INFO root metadata');
  let offset = 6, keyText = '';
  while (offset + 2 <= rootLength) {
    const code = bin.readUInt16LE(offset); offset += 2;
    if (code === 0) break;
    keyText += String.fromCharCode(code);
  }
  if (keyText !== 'VS_VERSION_INFO' || offset > rootLength) throw new Error('Missing VS_VERSION_INFO root key');
  offset = (offset + 3) & ~3;
  const valueBytes = type === 1 ? valueLength * 2 : valueLength;
  if (valueBytes < 52 || offset + 52 > rootLength || offset + valueBytes > rootLength) throw new Error('VS_VERSION_INFO has no complete VS_FIXEDFILEINFO value');
  if (bin.readUInt32LE(offset) !== 0xfeef04bd) throw new Error('Invalid VS_FIXEDFILEINFO signature');
  const fileVersionMS = bin.readUInt32LE(offset + 8), fileVersionLS = bin.readUInt32LE(offset + 12);
  return { fileVersionMS, fileVersionLS };
}

export function validatePe(input, expectedMachine, expectedVersion = null) {
  const exe = PE.NtExecutable.from(input);
  if (exe.newHeader.fileHeader.machine !== Number(expectedMachine)) throw new Error(`PE machine mismatch: 0x${exe.newHeader.fileHeader.machine.toString(16)}`);
  const resources = PE.NtExecutableResource.from(exe); assertResourceKeys(resources.entries); assertIconIntegrity(resources.entries);
  if (expectedVersion) {
    const versions = resources.entries.filter((entry) => Number(entry.type) === 16).map((entry) => parseVersionInfo(entry.bin));
    const values = versions.map((v) => `${v.fileVersionMS >>> 16}.${String(v.fileVersionMS & 0xffff).padStart(2, '0')}`);
    if (!versions.length || !values.some((value) => value === expectedVersion)) throw new Error(`PE version ${values.join(', ')} does not include ${expectedVersion}`);
  }
  return { machine: `0x${exe.newHeader.fileHeader.machine.toString(16).padStart(4, '0')}`, resourceCount: resources.entries.length, hasAuthenticode: exe.newHeader.optionalHeaderDataDirectory.get(4).size > 0 };
}
