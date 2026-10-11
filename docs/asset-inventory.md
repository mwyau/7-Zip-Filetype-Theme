# Source and legacy build inventory

Inventory basis: the clean `origin/master` commit `4bb21b905ac218a5de276874191512348330e687`, audited before restructuring. Filetype mappings and languages were checked against all tracked Resource Hacker scripts; both x86/x64 script sets agreed.

## Canonical build inputs

- `assets/filetypes/windows10/Windows_10_res/`: Windows 10 `.ico` source files. Groups 0–26 use the exact filenames in `config/themes.json`; the additional `27_lz5.ico` and `28_liz.ico` are preserved but not part of the verified 26.04 resource mapping.
- `assets/filetypes/fluent/fluent_res/`: Fluent `.ico` artwork mapped to icon groups 0–26.
- `assets/filetypes/fluent-blue/theme_res/`: Fluent Blue `.ico` artwork mapped to icon groups 0–26.
- `assets/toolbar/windows11-ribbon/resources/`: compiled `.res` source files for RT_BITMAP IDs 100–106, 150–156, and 190. They are not raw BMP files; each contains a standard null `.res` record followed by one language-1033 bitmap record.
- `assets/*/info/`: original previews and readme attribution notices. These were kept with their themes.
- `config/themes.json`: single authoritative source-to-resource mapping; no architecture-specific mapping copies remain.

## Preserved non-build artwork and provenance

- `themes/Fluent Blue/` and `themes/Fluent_7-Zip_Theme/` contain theme-manager format ICOs, previews, INI metadata, 7z SFX icons, toolbar BMPs, and their original hierarchy.
- `themes/Windows_10_7zip_theme/` retains theme-manager ICO/PNG artwork, original PSD source files, labels, previews, and readme/INI provenance.
- `assets/toolbar/windows11-ribbon/info/preview.png` is retained.
- Theme-manager artwork and source files remain available even where the current build uses a different precompiled ICO/RES representation.

## SHA-256 duplicate audit

SHA-256 comparison covered 294 `.ico`, `.bmp`, `.png`, `.jpg`, `.psd`, and `.res` files under `assets/` and `themes/`. It found 84 exact duplicate hash groups (170 file paths). The complete hash-to-path inventory is in [`asset-duplicates.csv`](asset-duplicates.csv). Representative examples:

- `942d0345f6df557696a967d7ebb0b1e51e9a9c6d3e6e310efd34b55b67d93e8e`: the Windows 10 preview PNG appears in the migrated theme and two historical theme-manager locations.
- `ccf57cd208f1bb15e31a4cc8a68fbf4e8e7f0017cde3b5170fe9c0f585a31420`: the same original `label.psd` appears in three historical theme-manager locations.

Identical copies were retained where needed to preserve the source theme-manager directory layout and historical provenance. The build has no duplicate mapping definitions; all active replacements are in the single manifest.

## Attribution, notices, and uncertainty

- Windows 10 artwork: author `masamunecyrus`, dated 2015-08-03; original notice is in `assets/filetypes/windows10/info/readme.txt` and historical `themes/Windows_10_7zip_theme/readme.txt`.
- Fluent artwork: author `Th3Z`, dated 2021-03-25; original DeviantArt link and notice remain in `assets/filetypes/fluent/info/readme.txt`.
- Fluent Blue artwork: author `Th3Z`, dated 2021-12-12; original DeviantArt link and notice remain in `assets/filetypes/fluent-blue/info/readme.txt`.
- Historical toolbar theme-manager metadata names `thz`; the standalone Ribbon `.res` files do not have an independent authorship or license notice in the inspected source. Exact attribution and redistribution permission for those bitmap resources remain unverified.
- No third-party artwork license was invented or changed. Public distribution rights for third-party theme assets should be confirmed with the respective authors.

## Removed legacy build machinery

- `build.xml` and `childbuild.xml` (Apache Ant definitions, including a hardcoded local 7-Zip path).
- `ResourceHacker/` and all Resource Hacker script files.
- `src/Orig7z/`, `src/7zFM/`, `src/NSIS/`, and `src/zstd/` download placeholders.
- Per-theme `scripts/` Resource Hacker command files and generated `result/` placeholders.
- `dist/` placeholder and nested `.gitignore` files (replaced by one root ignore policy).
- `README RU.md` as required; relevant installation/build context is consolidated into English `README.md`.

Legacy NSIS and 7-Zip-zstd scripts/distribution variants are not part of the official 26.04 support matrix. Their artwork/theme-manager historical materials are retained where they live under `themes/`; no NSIS/zstd binaries or install utility are included in this project.
