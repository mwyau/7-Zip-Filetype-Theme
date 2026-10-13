# Source artwork and build inventory

This inventory uses upstream commit `4bb21b905ac218a5de276874191512348330e687` of `Mr4Mike4/7-Zip-Filetype-Theme`. Filetype mappings and languages agree across the tracked x86 and x64 Resource Hacker scripts.

## Canonical build inputs

- `assets/filetypes/windows10/Windows_10_res/`: Windows 10 `.ico` source files. Groups 0–26 use the exact filenames in `config/themes.json`; the additional `27_lz5.ico` and `28_liz.ico` are preserved but not part of the verified 26.04 resource mapping.
- `assets/filetypes/fluent/fluent_res/`: Fluent `.ico` artwork mapped to icon groups 0–26.
- `assets/filetypes/fluent-blue/theme_res/`: Fluent Blue `.ico` artwork mapped to icon groups 0–26.
- `assets/toolbar/windows11-ribbon/resources/`: compiled `.res` source files for RT_BITMAP IDs 100–106, 150–156, and 190. They are not raw BMP files; each contains a standard null `.res` record followed by one language-1033 bitmap record.
- `assets/*/info/`: original previews and readme attribution notices. These were kept with their themes.
- `config/themes.json`: the resource mapping for both x86 and x64 builds.

## Artwork outside current builds

- `themes/Fluent Blue/` and `themes/Fluent_7-Zip_Theme/` contain theme-manager format ICOs, previews, INI metadata, 7z SFX icons, and toolbar BMPs in their source directory layouts.
- `themes/Windows_10_7zip_theme/` contains theme-manager ICO/PNG artwork, PSD source files, labels, previews, and readme/INI metadata.
- `assets/toolbar/windows11-ribbon/info/preview.png` shows the Ribbon theme.
- The theme-manager files are available alongside the ICO/RES files used in current builds.

## SHA-256 duplicate comparison

SHA-256 comparison covered 294 `.ico`, `.bmp`, `.png`, `.jpg`, `.psd`, and `.res` files under `assets/` and `themes/`. It found 84 exact duplicate hash groups (170 file paths). The complete hash-to-path inventory is in [`asset-duplicates.csv`](asset-duplicates.csv). Representative examples:

- `942d0345f6df557696a967d7ebb0b1e51e9a9c6d3e6e310efd34b55b67d93e8e`: the Windows 10 preview PNG appears in the migrated theme and two historical theme-manager locations.
- `ccf57cd208f1bb15e31a4cc8a68fbf4e8e7f0017cde3b5170fe9c0f585a31420`: the same original `label.psd` appears in three historical theme-manager locations.

Identical files occur in multiple theme-manager directories, preserving their source layouts. `config/themes.json` defines the resource replacements used in current builds.

## Artwork attribution and rights

- Windows 10 artwork: author `masamunecyrus`, dated 2015-08-03; original notice is in `assets/filetypes/windows10/info/readme.txt` and historical `themes/Windows_10_7zip_theme/readme.txt`.
- Fluent artwork: author `Th3Z`, dated 2021-03-25; original DeviantArt link and notice remain in `assets/filetypes/fluent/info/readme.txt`.
- Fluent Blue artwork: author `Th3Z`, dated 2021-12-12; original DeviantArt link and notice remain in `assets/filetypes/fluent-blue/info/readme.txt`.
- Toolbar theme-manager metadata names `thz`. The inspected standalone Ribbon `.res` files lack an authorship or license notice, so the creator and redistribution terms remain unverified.
- Redistribution permission for third-party artwork has not been independently verified. See [artwork attribution and rights](artwork-rights.md).

## Removed legacy build machinery

- `build.xml` and `childbuild.xml` (Apache Ant definitions, including a hardcoded local 7-Zip path).
- `ResourceHacker/` and all Resource Hacker script files.
- `src/Orig7z/`, `src/7zFM/`, `src/NSIS/`, and `src/zstd/` download placeholders.
- Per-theme `scripts/` Resource Hacker command files and generated `result/` placeholders.
- `dist/` placeholder and nested `.gitignore` files (replaced by one root ignore policy).
- `README RU.md` (installation instructions are in the English `README.md`).

Releases for official 7-Zip 26.04 exclude NSIS and 7-Zip-zstd variants. Their source artwork is available under `themes/`; the release packages contain neither NSIS/zstd binaries nor an installation utility.
