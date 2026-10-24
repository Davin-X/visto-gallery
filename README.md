# Stillroom

A fast, local-first photo & video gallery for macOS — React, TypeScript, Vite, Tauri 2 (Rust).

![Stillroom icon](src-tauri/icons/icon.png)

> **Status:** Beta · `v0.1.0` · Local-first · macOS 13+ · MIT

## What Stillroom is

Stillroom is your private photo library — on your Mac, under your control. It scans folders you choose, builds a local SQLite catalog, reads/writes EXIF metadata, lets you non-destructively edit and export, finds duplicates by SHA-256, and can hide sensitive items from the gallery.

Nothing is uploaded. Nothing phones home. Your photos stay on your disk.

| Layer | What it does |
|-------|--------------|
| **Frontend** (`src/`) | React 18 + TypeScript + Vite UI |
| **Backend** (`src-tauri/`) | Tauri 2 + Rust + SQLite (`sqlx`) |
| **Bridge** | Typed Tauri invoke layer |

## Features

- **Library views** — Grid, Details, Timeline, Filmstrip, and Overview layouts
- **Sorting and selection** — sort by name, capture date, modified date, kind, or size; select across timeline groups
- **Sources manager** — add multiple folders at once, filter and inspect sources, rescan, reveal in Finder, and remove sources without moving files
- **Inspector** — preview a selected item and edit tags alongside file metadata
- **Smart filters** — All / Photos / Videos / RAW / Favorites
- **Search** — by filename, folder path, camera model, tags
- **Viewer** — keyboard navigation, zoom, full-screen, video playback (volume, background playback, picture-in-picture), and a thumbnail filmstrip; controls auto-hide
- **Non-destructive edits** — exposure, contrast, warmth, rotation, flip; export JPEG/PNG/HEIC/AVIF
- **Duplicate detection** — SHA-256 scanner with live progress and cancellation
- **Long-running scans** — cancel folder indexing, file imports, or duplicate hashing; completed work stays saved
- **Batch tools** — rename, export, convert, strip metadata
- **Slideshow** — configurable photo interval, shuffle and transitions; videos advance when playback ends; video volume controls, picture-in-picture, and auto-hiding controls
- **Hidden** — conceal sensitive items and their metadata in the gallery; files stay on disk at their original paths (not encrypted)
- **Dark / Light / System** appearance
- **Finder tags** read/write

## Quick start

### Browser preview (no Rust needed)

```sh
git clone https://github.com/Davin-X/stillroom.git
cd stillroom
npm install
npm run dev        # open http://localhost:1420/harness.html
npm run build      # dist/
npm run preview    # open http://localhost:4173/harness.html
```

The browser preview uses a small Tauri API stub for UI review. Native file access, scanning, and Finder actions require the desktop app.

### Native macOS desktop app

Requires Node.js, Rust toolchain, Tauri CLI.

```sh
npm install
npm run tauri dev     # desktop app
npm run tauri build   # .app bundle (macOS)
```

> Targets macOS 13+. Universal (Apple Silicon + Intel) builds supported.

## Project structure

```
stillroom/
├── src/              # React/Vite frontend
├── src-tauri/        # Tauri 2 + Rust backend
│   └── icons/        # App icons used by Tauri bundles
├── scripts/          # Maintainer utilities
├── index.html
├── harness.html     # Browser preview with a Tauri API stub
├── LICENSE
├── package.json
├── tsconfig.json
├── vite.config.js
└── README.md
```

## Current limitations

- The browser preview does not have native file-system access; use the Tauri desktop app to index folders.
- Hidden items are visually concealed in the app but are not encrypted and remain accessible at their original file paths.
- Folder watching, network access, and crash reporting are not available yet.

See [`CHANGELOG.md`](./CHANGELOG.md) for release notes and [`CONTRIBUTING.md`](./CONTRIBUTING.md) for development guidance.

## Contributing

Contributions are reviewed through pull requests. Check the repository's current branch rules before opening one.

1. Fork, create branch: `git checkout -b feature/your-feature`
2. Run `npm run typecheck` to verify
3. Commit: `feat:`, `fix:`, `chore:`, `docs:`
4. Open a PR against `main`

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) · [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)

## Security

Local-first, no network requests by design. Disclose responsibly.

See [`SECURITY.md`](./SECURITY.md).

## License

MIT License. See [`LICENSE`](./LICENSE).

---

**Stillroom** — your photos, your Mac, your terms.
