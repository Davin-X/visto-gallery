# Contributing to VistoGallery

Thank you for contributing! VistoGallery is a local-first macOS photo gallery built with React, TypeScript, Vite, and Tauri 2 (Rust). Contributions are reviewed through pull requests. Check the repository's current branch rules for review and merge requirements.

---

## How we work

- **Branching:** Create a feature branch from `main` (`git checkout -b feature/your-feature`)
- **Commits:** Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`)
- **Review:** Open a PR against `main` and follow the review requirements shown by GitHub.

---

## Getting started

```sh
# Fork, then clone your fork
git clone https://github.com/<your-username>/visto-gallery.git
cd visto-gallery

# Install dependencies
npm install

# Run the browser prototype
npm run dev           # open http://localhost:1420/harness.html
npm run build         # production Vite build

# Run the native desktop app (requires Rust toolchain)
npm run tauri dev
npm run tauri build

# Type-check
npm run typecheck
```

### Rust toolchain (for native backend)

```sh
# Install Rust if you don't have it
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add the Apple Silicon/Intel targets if cross-building
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

---

## Making changes

### Frontend (`src/`)
- Components live in `src/design/components/`
- State lives in `src/engine/stores/` (Zustand)
- Shared types live in `src/engine/types/`
- Tauri bridge lives in `src/engine/commands/tauri.ts`
- Styles live in `src/design/styles/`

### Backend (`src-tauri/`)
- Commands: `src-tauri/src/commands/mod.rs`
- Models/DB rows: `src-tauri/src/models/mod.rs`
- SQLite + migrations: `src-tauri/src/db/mod.rs`
- Tauri entrypoint: `src-tauri/src/lib.rs`
- Native menu: `src-tauri/src/menu.rs`
- Config: `src-tauri/tauri.conf.json`

---

## Pull request checklist

Before requesting review, make sure:

- [ ] `npx tsc --noEmit` passes (frontend types)
- [ ] `cargo check` passes (backend types) — if you touched Rust
- [ ] New UI follows the design tokens in `src/design/styles/global.css`
- [ ] New icons use the shared `Svg` contract in `src/design/components/icons.tsx` (24×24 viewBox, `currentColor`)
- [ ] Screenshots included for user-facing changes
- [ ] Linked to any related issue
- [ ] Commit messages follow Conventional Commits

---

## Code of conduct

Please read and follow our [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

---

## Questions?

Open a discussion or an issue. We're happy to help you get started.
