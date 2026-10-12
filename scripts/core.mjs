import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as PE from 'pe-library';
import * as ResEdit from 'resedit';

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

function key(entry) { return `${entry.type}:${entry.id}:${entry.lang}`; }
function entriesMap(entries) { return new Map(entries.map((entry) => [key(entry), Buffer.from(entry.bin)])); }
function iconGroups(entries) { return ResEdit.Resource.IconGroupEntry.fromEntries(entries); }
function assertResourceKeys(entries) {
  const seen = new Set();
  for (const entry of entries) { const k = key(entry); if (seen.has(k)) throw new Error(`Duplicate resource key ${k}`); seen.add(k); }
}
function assertIconIntegrity(entries) {
  const groups = iconGroups(entries), refs = new Set();
  for (const group of groups) {
    for (const icon of group.icons) {
      const k = `3:${icon.iconID}:${group.lang}`;
      if (!entries.some((entry) => key(entry) === k)) throw new Error(`Dangling RT_ICON reference ${k} from group ${group.id}`);
      refs.add(k);
    }
  }
  const orphan = entries.find((entry) => entry.type === 3 && !refs.has(key(entry)));
  if (orphan) throw new Error(`Orphan RT_ICON resource ${key(orphan)}`);
}
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
function checkPeSafety(beforeExe, afterExe) {
  const before = new Map(beforeExe.getAllSections().map((s) => [s.info.name, s]));
  for (const section of afterExe.getAllSections()) {
    const prior = before.get(section.info.name);
    if (!prior) throw new Error(`Unexpected PE section added: ${section.info.name}`);
    if (!['.rsrc', '.reloc'].includes(section.info.name) && !Buffer.from(section.data).equals(Buffer.from(prior.data))) throw new Error(`Unrelated PE section modified: ${section.info.name}`);
  }
  for (const section of before.values()) if (!afterExe.getAllSections().some((s) => s.info.name === section.info.name)) throw new Error(`PE section removed: ${section.info.name}`);
  const dirsA = beforeExe.newHeader.optionalHeaderDataDirectory;
  const dirsB = afterExe.newHeader.optionalHeaderDataDirectory;
  // Directory RVAs for exports/imports/exceptions/TLS/load config/IAT remain stable.
  for (const index of [0, 1, 3, 9, 10, 12]) if (JSON.stringify(dirsA.get(index)) !== JSON.stringify(dirsB.get(index))) throw new Error(`PE data directory ${index} changed`);
  // The resource editor may move/resize the base-relocation directory as sections are laid out.
  // Compare its logical relocation blocks independently to prove loader fixups are unchanged.
  if (JSON.stringify(relocationRecords(beforeExe)) !== JSON.stringify(relocationRecords(afterExe))) throw new Error('PE base-relocation records changed');
  // Resource editing invalidates Authenticode by changing signed bytes; no original signature is claimed.
  void dirsA.get(4); void dirsB.get(4);
}

export function patchIcons(input, theme, language) {
  const original = PE.NtExecutable.from(input, { ignoreCert: true });
  const resources = PE.NtExecutableResource.from(original);
  assertResourceKeys(resources.entries);
  const before = entriesMap(resources.entries);
  const intended = new Set();
  for (const [id, filename] of theme.groups) {
    const group = iconGroups(resources.entries).find((entry) => Number(entry.id) === id && Number(entry.lang) === language);
    if (!group) throw new Error(`${theme.slug}: required RT_GROUP_ICON/${id}/${language} is missing`);
    intended.add(`14:${id}:${language}`);
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(theme.artwork, filename)));
    if (!iconFile.icons.length) throw new Error(`ICO has no images: ${filename}`);
    for (const icon of group.icons) intended.add(`3:${icon.iconID}:${language}`);
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, iconFile.icons.map((item) => item.data));
    const replacement = iconGroups(resources.entries).find((entry) => Number(entry.id) === id && Number(entry.lang) === language);
    if (!replacement) throw new Error(`${theme.slug}: group ${id} disappeared during replacement`);
    for (const icon of replacement.icons) intended.add(`3:${icon.iconID}:${language}`);
  }
  assertResourceKeys(resources.entries); assertIconIntegrity(resources.entries); resources.outputResource(original);
  const output = Buffer.from(original.generate());
  const checkedExe = PE.NtExecutable.from(output); checkPeSafety(PE.NtExecutable.from(input, { ignoreCert: true }), checkedExe);
  const checked = PE.NtExecutableResource.from(checkedExe); assertResourceKeys(checked.entries); assertIconIntegrity(checked.entries);
  const after = entriesMap(checked.entries), changes = diffResourceMaps(before, after, (k) => intended.has(k));
  return { output, changes, machine: checkedExe.newHeader.fileHeader.machine };
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

function checkNativeRibbonPeSafety(beforeExe, afterExe) {
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

  const directoriesBefore = beforeHeader.optionalHeaderDataDirectory;
  const directoriesAfter = afterHeader.optionalHeaderDataDirectory;
  // Resource (2), certificate (4), and base-relocation (5) directories may be rewritten.
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

export function verifyRibbonBitmaps(input, outputInput, records, expectedIds, language) {
  const original = PE.NtExecutable.from(input, { ignoreCert: true });
  const output = Buffer.from(outputInput);
  const checkedExe = PE.NtExecutable.from(output);
  checkNativeRibbonPeSafety(original, checkedExe);
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
    const [type, id, language] = k.split(':').map(Number);
    return { type, id, language, change: !oldData ? 'added' : !newData ? 'removed' : 'replaced', oldSha256: oldData ? sha256(oldData) : null, newSha256: newData ? sha256(newData) : null, classification: intended(k) ? 'expected' : 'unexpected' };
  }).filter(Boolean);
}

export function validatePe(input, expectedMachine, expectedVersion = null) {
  const exe = PE.NtExecutable.from(input);
  if (exe.newHeader.fileHeader.machine !== Number(expectedMachine)) throw new Error(`PE machine mismatch: 0x${exe.newHeader.fileHeader.machine.toString(16)}`);
  const resources = PE.NtExecutableResource.from(exe); assertResourceKeys(resources.entries); assertIconIntegrity(resources.entries);
  if (expectedVersion) {
    const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
    const values = versions.map((v) => `${v.fixedInfo.fileVersionMS >>> 16}.${String(v.fixedInfo.fileVersionMS & 0xffff).padStart(2, '0')}`);
    if (!versions.length || !values.some((value) => value === expectedVersion)) throw new Error(`PE version ${values.join(', ')} does not include ${expectedVersion}`);
  }
  return { machine: `0x${exe.newHeader.fileHeader.machine.toString(16).padStart(4, '0')}`, resourceCount: resources.entries.length, hasAuthenticode: exe.newHeader.optionalHeaderDataDirectory.get(4).size > 0 };
}
