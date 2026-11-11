# Contributing to VistoGallery

Thanks for helping. VistoGallery is a local-first macOS photo and video gallery built with Tauri 2: a React + TypeScript + Vite frontend on a Rust + SQLite backend. Changes land through pull requests against `main`.

## Setup

You need macOS, [Node.js](https://nodejs.org/) LTS, the [Rust toolchain](https://www.rust-lang.org/tools/install) and the Xcode Command Line Tools (`xcode-select --install`).

```bash
git clone https://github.com/<your-username>/visto-gallery.git
cd visto-gallery
npm install
npm run ffmpeg:build
```

`npm run ffmpeg:build` compiles the `ffmpeg` and `ffprobe` sidecars into `src-tauri/binaries/`
(git-ignored, a couple of minutes). The backend needs them for lossless video remuxing and for
video posters, and `cargo build` refuses to run without them because `tauri.conf.json` lists them
as `externalBin`. Pass `VISTO_FFMPEG_FORCE=1` to rebuild after changing `scripts/build-ffmpeg.sh`.

`npm install` also points Git at the tracked hooks in `.githooks/`, which strip AI-assistant `Co-authored-by` trailers from commit messages so they don't show up as repository contributors. Re-run it with `sh scripts/setup-hooks.sh`.

## Running the app

`npm run tauri dev` does not start the frontend for you; it expects the Vite dev server on `http://localhost:5173`. Use two terminals.

Terminal 1, the frontend:

```bash
npm run dev
```

Terminal 2, the native app:

```bash
npm run tauri dev
```

Frontend edits reload instantly. Rust edits rebuild and relaunch the app.

To try the interface without the Rust backend, open `http://localhost:5173/harness.html` while `npm run dev` is running. The harness uses fixture data, so anything that needs the backend (scanning, thumbnails, editing) won't work there.

> **Your real catalog.** A dev build uses the same catalog as the installed app: `~/Library/Application Support/com.vistogallery.desktop/visto-gallery.db`. A branch that adds a migration upgrades that file, and older builds then refuse to open it. Copy the folder somewhere safe before running a branch with schema changes.

## Checks

CI runs all of these on every pull request. Run them before you push.

Frontend:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Backend:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

CI also runs `cargo audit` on `src-tauri/Cargo.lock` and `npm audit --omit=dev --audit-level=high`.

## Project layout

### Frontend (`src/`)

| Path | What lives there |
|---|---|
| `src/app/` | App shell, navigation, dialogs, native menu and keyboard wiring |
| `src/screens/` | One component per screen (Library, Albums, Viewer, Edit, Duplicates, Batch, Hidden, Video) |
| `src/design/components/` | Shared UI components and icons |
| `src/design/styles/` | Design tokens (`global.css`) and shared styles |
| `src/engine/stores/` | App state (Zustand) |
| `src/engine/commands/tauri.ts` | Typed wrappers for every backend command |
| `src/engine/types/` | TypeScript types that mirror the Rust IPC structs |
| `src/engine/utils/` | Pure helpers (folder watching, Finder tags, dates, media types) |

### Backend (`src-tauri/`)

| Path | What lives there |
|---|---|
| `src/lib.rs` | App setup, shared state, the command list |
| `src/commands/mod.rs` | IPC structs, shared helpers, supported extensions, path checks |
| `src/commands/access.rs` | Which paths the app may import (picked in a dialog, dropped, or already a source) |
| `src/commands/library.rs` | Scanning, importing, paging and filtering the library, thumbnails, folder watching |
| `src/commands/scan_jobs.rs` | Per-scan cancellation and per-folder scan locks |
| `src/commands/media.rs` | Trash, open and reveal, EXIF, rendering edits |
| `src/commands/*.rs` | Albums, Smart Albums, duplicates, batch export, backups, root mapping, settings, update checks |
| `src/media_*.rs` | Header-only readers: dimensions, animation detection, content signatures |
| `src/db/mod.rs` | Opening the catalog, migrations, one-time backfills |
| `migrations/` | Versioned SQL migrations |
| `vendor/wry/` | A patched `wry` for macOS 27 (see `vendor/wry/VISTO-PATCH.md`) |

## Backend conventions

- **Never edit a migration that has shipped.** Add a new numbered file in `src-tauri/migrations/` instead. Released catalogs record which migrations ran, and an edited or missing one stops the app from starting.
- **Keep blocking work off the async runtime.** Filesystem walks, file reads and image decoding go in `tokio::task::spawn_blocking`.
- **Treat the webview as untrusted.** Commands take catalog ids rather than file paths where they can. When a path must come from the frontend, check it with the helpers in `access.rs` or `validate_path_under_registered_roots`. Let the backend open save dialogs itself rather than accepting a destination path.
- **IPC structs use `#[serde(rename_all = "camelCase")]`** and must match `src/engine/types/`.
- **Every new command** needs an entry in `generate_handler!` in `lib.rs` and a wrapper in `src/engine/commands/tauri.ts`.

## Pull requests

- Branch from `main` (for example `fix/short-description`).
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `test:`, `ci:`, `chore:`.
- Keep each commit to one change, and explain why in the body.
- Add or update tests for behavior changes.
- Add a line under **Unreleased** in [CHANGELOG.md](./CHANGELOG.md) for anything a user would notice.
- Include before and after screenshots for UI changes, in light and dark mode.
- For changes to native behavior (Trash, Finder tags, file dialogs, drag and drop), work through the relevant rows of [docs/MAC_NATIVE_VALIDATION.md](./docs/MAC_NATIVE_VALIDATION.md).

### Checklist

- [ ] All checks in [Checks](#checks) pass
- [ ] New UI uses the design tokens in `src/design/styles/global.css` and works in light and dark mode
- [ ] New icons use the shared `Svg` component in `src/design/components/icons.tsx` (24×24 viewBox, `currentColor`)
- [ ] CHANGELOG updated for user-visible changes
- [ ] Linked to the related issue, if there is one

## Updating README screenshots

README screenshots live in `docs/screenshots/` as `<screen>-light.jpg` and `<screen>-dark.jpg`, captured at 1600 px wide from a demo library with no personal files. The README shows each pair with a `<picture>` element, so GitHub picks the one that matches the reader's theme.

## Code of conduct

Please follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Maintainers: issue labels

Dependabot pull requests expect the labels `dependencies`, `npm` and `rust` to exist. Label small, well-scoped tasks `good first issue` or `help wanted` to invite new contributors.

## Questions

Open a [discussion](https://github.com/Davin-X/visto-gallery/discussions) or an issue.
