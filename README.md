<p align="center">
  <img src="src-tauri/icons/icon.png" width="112" alt="VistoGallery icon" />
</p>

<h1 align="center">VistoGallery</h1>

<p align="center">
  A fast, private photo and video gallery for macOS.<br/>
  Browse, edit, tag and clean up your library. Everything stays on your disk.
</p>

<p align="center">
  <a href="https://github.com/Davin-X/visto-gallery/releases"><img alt="Download" src="https://img.shields.io/badge/Download-.dmg-blue?style=flat-square"></a>
  <a href="https://github.com/Davin-X/visto-gallery/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Davin-X/visto-gallery/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-MIT-green?style=flat-square"></a>
  <img alt="Platform" src="https://img.shields.io/badge/macOS-13%2B-lightgrey?style=flat-square">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/library-dark.jpg">
    <img src="docs/screenshots/library-light.jpg" alt="The VistoGallery library: a sidebar with sources and library totals, and the All Media grid of landscapes, architecture and space photos with type filters, ratings and favorite badges" width="900">
  </picture>
</p>
<p align="center"><sub>Shown in your GitHub theme. Every screen in the <a href="#tour">tour</a> appears in both light and dark.</sub></p>

VistoGallery points at the folders you already have. It never copies, moves or uploads your files; it builds a local catalog next to them so you can browse thousands of photos and videos quickly, organize them, and find duplicates.

## Contents

- [Features](#features)
- [Tour](#tour)
- [Install](#install)
- [Supported formats](#supported-formats)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Privacy](#privacy)
- [Build from source](#build-from-source)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Features

- **Private by default.** No account, no cloud, no telemetry. Update checks are off unless you turn them on.
- **Your folders, in place.** Add folders as sources; files are read where they are. Moved or renamed files keep their favorites, tags and albums.
- **Browse your way.** Grid, Details, Timeline, Filmstrip and Overview layouts, sorted by capture date, name, size or type.
- **Find anything.** Search names, tags, camera and lens. Filter by capture date, rating, color label, camera, lens, source and type (photos, videos, RAW, animations).
- **Organize.** Albums, Smart Albums that update themselves, tags, favorites, ratings, color labels and hidden items.
- **Edit without fear.** Exposure, contrast, highlights, shadows, warmth, saturation, crop, rotate and flip. Edits are drafts until you save, and the original is kept so you can restore it.
- **Clean up duplicates.** SHA-256 matching finds exact copies, then a side-by-side compare shows what differs before anything moves to the Trash.
- **Export in batches.** Convert to JPEG, PNG or WebP, or keep the original format, with naming patterns, resizing and metadata stripping.
- **Feels like a Mac app.** Finder tags, Reveal in Finder, Trash with Put Back, light, dark and system themes, and accent colors.
- **Portable catalog.** Back up and restore the catalog, or point it at a library that moved to a new drive.

## Tour

<p align="center">
  <img src="docs/media/vistogallery-tour.gif" alt="A 20-second tour: the library with the Inspector, the photo viewer, the video player, albums, the timeline, the duplicate compare dialog and the editor" width="720">
</p>

### Albums and Smart Albums

<table>
  <tr>
    <th>Light</th>
    <th>Dark</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/albums-light.jpg" alt="Albums screen with a row of Smart Albums above a grid of regular albums (light theme)" width="440"></td>
    <td><img src="docs/screenshots/albums-dark.jpg" alt="Albums screen with a row of Smart Albums above a grid of regular albums (dark theme)" width="440"></td>
  </tr>
</table>

Smart Albums are saved filters (for example "5-star picks" or "Sunsets") that stay current as your library changes.

### Album view

<table>
  <tr>
    <th>Light</th>
    <th>Dark</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/album-view-light.jpg" alt="The Alpine Weekend album in the library grid, with the sidebar collapsed to icons (light theme)" width="440"></td>
    <td><img src="docs/screenshots/album-view-dark.jpg" alt="The Alpine Weekend album in the library grid, with the sidebar collapsed to icons (dark theme)" width="440"></td>
  </tr>
</table>

Open an album to see just its photos, with the same filters, sorting and layouts as the library. Collapse the sidebar to icons when you want more room.

### Viewer

<table>
  <tr>
    <th>Light</th>
    <th>Dark</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/viewer-light.jpg" alt="Photo viewer showing a mountain valley, with capture date, size, camera and lens above it, zoom and favorite controls below, and a filmstrip of the library (light theme)" width="440"></td>
    <td><img src="docs/screenshots/viewer-dark.jpg" alt="Photo viewer showing a mountain valley, with capture date, size, camera and lens above it, zoom and favorite controls below, and a filmstrip of the library (dark theme)" width="440"></td>
  </tr>
</table>

Zoom, pan, favorite and hide without leaving the photo. The filmstrip pages through the library, and the camera, lens and capture date sit above the photo.

### Video player

<table>
  <tr>
    <th>Light</th>
    <th>Dark</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/player-light.jpg" alt="Video player with an Earth-from-orbit clip, playback time, and a queue of five videos below (light theme)" width="440"></td>
    <td><img src="docs/screenshots/player-dark.jpg" alt="Video player with an Earth-from-orbit clip, playback time, and a queue of five videos below (dark theme)" width="440"></td>
  </tr>
</table>

Videos play in the app, including MKV and HEVC files that the system web view can't open: the bundled ffmpeg repackages them for playback without re-encoding or touching the original. Keep a video playing in the background while you browse.

### Edit

<table>
  <tr>
    <th>Light</th>
    <th>Dark</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/edit-editor-light.jpg" alt="Editor with light and color sliders, crop tools, and save draft, save copy and restore original actions (light theme)" width="440"></td>
    <td><img src="docs/screenshots/edit-editor-dark.jpg" alt="Editor with light and color sliders, crop tools, and save draft, save copy and restore original actions (dark theme)" width="440"></td>
  </tr>
</table>

Adjustments are saved as drafts, and the Edit screen lists every saved draft so you can pick up where you left off. Save a copy, or replace the file knowing the original is kept and can be restored.

### Duplicates

<table>
  <tr>
    <th>Light</th>
    <th>Dark</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/duplicates-compare-light.jpg" alt="Compare dialog showing a keeper and a copy side by side with a table of differing metadata (light theme)" width="440"></td>
    <td><img src="docs/screenshots/duplicates-compare-dark.jpg" alt="Compare dialog showing a keeper and a copy side by side with a table of differing metadata (dark theme)" width="440"></td>
  </tr>
</table>

Compare a keeper and its copies side by side, with synced zoom and only the fields that differ, before moving copies to the Trash. Undo puts them back, even from an external drive.

### Timeline and Details

<table>
  <tr>
    <th>Timeline</th>
    <th>Details</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/library-timeline-dark.jpg" alt="Library timeline grouped by month, November and October 2025, with ratings and favorite badges on each photo" width="440"></td>
    <td><img src="docs/screenshots/library-list-dark.jpg" alt="Library Details view: a sortable table of names, dates, sizes and types" width="440"></td>
  </tr>
</table>

Group the library by month, or switch to a sortable table. Each view remembers where you were.

### Sources

<table>
  <tr>
    <th>Light</th>
    <th>Dark</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/sources-light.jpg" alt="Sources dialog listing library folders with item counts and sizes (light theme)" width="440"></td>
    <td><img src="docs/screenshots/sources-dark.jpg" alt="Sources dialog listing library folders with item counts and sizes (dark theme)" width="440"></td>
  </tr>
</table>

Add, rescan or remove folders. Removing a source only removes it from the catalog; your files stay on disk. If a folder moves, **Locate…** points the source at its new place and everything keeps its albums, tags and edits.

<sub>The screenshots show a demo library of openly licensed photos and videos from Wikimedia Commons, NASA and rawpixel. Credits are in [docs/screenshots/CREDITS.md](docs/screenshots/CREDITS.md).</sub>

## Install

1. Download the latest `.dmg` from [GitHub Releases](https://github.com/Davin-X/visto-gallery/releases). It runs on Apple Silicon Macs (M1 or later).
2. Open it and drag **VistoGallery.app** into **Applications**.
3. Eject the disk image and open the app.

### macOS Gatekeeper (unsigned build)

VistoGallery is not notarized yet, so macOS may say the app is "damaged" or from an unidentified developer. Either right-click the app, choose **Open**, then **Open** again, or run:

```bash
xattr -dr com.apple.quarantine /Applications/VistoGallery.app
```

Every release publishes checksums and a build provenance attestation, and a GPG signature of the `.dmg` when the release key is configured (0.4.0 has none). [docs/VERIFYING_RELEASES.md](docs/VERIFYING_RELEASES.md) shows how to check them.

## Supported formats

| Type | Extensions |
|---|---|
| Photos | AVIF, BMP, GIF, HEIC/HEIF, JPEG (`jpg`, `jpeg`, `jpe`, `jfif`), JPEG XL, PNG, TIFF, WebP |
| RAW | 3FR, ARI, ARW, BAY, CAP, CR2, CR3, DCR, DCS, DNG, DRF, EIP, ERF, FFF, GPR, IIQ, K25, KDC, MDC, MEF, MOS, MRW, NEF, NRW, OBM, ORF, PEF, PTX, PXN, R3D, RAF, RAW, RW2, RWL, SR2, SRF, SRW, X3F |
| Video | 3GP, 3G2, ASF, AVI, FLV, M2TS, M4V, MKV, MOV, MP4, MPEG/MPG, MTS, OGV, TS, VOB, WebM, WMV |

Videos that WebKit can't play in the app (such as MKV and AVI) open in an installed player like IINA or VLC. Animated GIF, WebP, APNG and AVIF files are detected from their contents and appear under **Animations**.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| <kbd>⌘</kbd> <kbd>O</kbd> | Add a source folder |
| <kbd>⌘</kbd> <kbd>I</kbd> | Import files |
| <kbd>⌘</kbd> <kbd>E</kbd> | Export selection with Batch |
| <kbd>⌘</kbd> <kbd>F</kbd> | Search |
| <kbd>⌘</kbd> <kbd>A</kbd> | Select or deselect all |
| <kbd>⌘</kbd> <kbd>\\</kbd> | Toggle sidebar |
| <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>I</kbd> | Toggle inspector |
| <kbd>⌘</kbd> <kbd>↩</kbd> | Open the inspected item in the viewer |
| <kbd>←</kbd> <kbd>→</kbd> | Previous or next item in the viewer |
| <kbd>Space</kbd> | Play or pause a video |
| <kbd>Esc</kbd> | Close the viewer, inspector or dialog |
| <kbd>⌘</kbd> <kbd>/</kbd> | Show all shortcuts |

## Privacy

VistoGallery is local-first. It never uploads photos, metadata or usage data, and it only reads folders and files you choose in a macOS dialog or drop onto the window. The catalog lives in `~/Library/Application Support/com.vistogallery.desktop/`.

Hidden items are hidden inside the app only; the files stay where they are on disk. The only network request the app can make is the optional update check against GitHub Releases.

## Build from source

You need macOS, [Node.js](https://nodejs.org/) LTS, the [Rust toolchain](https://www.rust-lang.org/tools/install) and the Xcode Command Line Tools (`xcode-select --install`).

```bash
npm install
npm run ffmpeg:build
```

The second command compiles the `ffmpeg` and `ffprobe` binaries the app ships. They are
static, contain only the demuxers, decoders and encoders VistoGallery calls, and live in
`src-tauri/binaries/` (git-ignored). Tauri copies them into the app bundle as sidecars and
`cargo` will not build without them, so run it once after cloning. It takes a few minutes
and needs nothing beyond the Xcode Command Line Tools.

In development only, a missing sidecar falls back to a Homebrew `ffmpeg` if you have one,
which is handy while iterating on the player. Bundles never rely on that fallback.

The native app loads the frontend from the Vite dev server, so run it in one terminal:

```bash
npm run dev
```

Then start the app in a second terminal:

```bash
npm run tauri dev
```

To build a `.dmg`:

```bash
npm run tauri build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for tests, checks and project layout.

## How it works

VistoGallery is a [Tauri 2](https://tauri.app/) app: a React and TypeScript interface on top of a Rust backend.

- **Catalog.** A SQLite database (WAL mode) stores one row per file with its path, size, dates, dimensions, EXIF and your own data (favorites, ratings, tags, albums). Schema changes are versioned migrations in `src-tauri/migrations/`.
- **Scanning.** Rescans only inspect new or changed files, judged by size and modification time. File reads run off the main async runtime, so large libraries don't stall the app.
- **Thumbnails.** Generated on demand and cached in the app's cache folder, with a size budget.
- **Safety.** The backend only accepts folders you picked or dropped, only opens files that are in the catalog, and moves deleted files to the macOS Trash so you can put them back.
- **.bak files.** When you confirm "Replace original" and a file already exists at the destination, the previous version is copied to `<name>.<ext>.bak` next to the new one before the save. These backups are never deleted automatically — when you're happy with the new render, remove the `.bak` files yourself.

## Troubleshooting

- **macOS blocks the app.** See [Gatekeeper](#macos-gatekeeper-unsigned-build).
- **`npm run tauri dev` shows a blank window.** Start `npm run dev` first; the app loads its interface from `http://localhost:5173`.
- **`npm run tauri dev` fails to compile.** Install Rust and the Xcode Command Line Tools, then try again.
- **`npm install` fails.** Use a current Node.js LTS. If it still fails, delete `node_modules` and reinstall.
- **Still stuck?** Open an [issue](https://github.com/Davin-X/visto-gallery/issues) or start a [discussion](https://github.com/Davin-X/visto-gallery/discussions). [SUPPORT.md](./SUPPORT.md) says what to include and what to expect.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, checks and pull request guidelines, [SECURITY.md](./SECURITY.md) to report a vulnerability privately, and [SUPPORT.md](./SUPPORT.md) for questions and bug reports. [ACCESSIBILITY.md](./ACCESSIBILITY.md) describes keyboard and screen reader support and how to report a barrier.

## License

[MIT](./LICENSE)
