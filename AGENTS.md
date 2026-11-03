# AGENTS.md — VistoGallery

> A fast, private photo & video gallery app for macOS.
> React 18 + TypeScript + Vite + Tauri (Rust backend). Version 0.2.2.

## Project layout

```
src/
  app/                # App.tsx (root component), startup, shortcuts, nativeMenu, exportFlow, backgroundVideo
  design/             # Reusable components & styles
    components/       # VideoPlayer, MiniPlayer, CachedThumbnail, VideoThumb, SlideshowOverlay, ContextMenu, SettingsScreen, icons...
    styles/           # global.css, settings.css, interactive.css, components.css
  screens/            # LibraryScreen, ViewerScreen, AlbumsScreen, EditScreen, HiddenScreen, BatchScreen, DuplicatesScreen, CameraLensBrowserScreen
  engine/
    stores/          # Zustand stores: useLibraryStore, useViewerStore, usePlaybackStore, useSettingsStore, useEditStore, useSlideshowStore, useBatchStore
    types/           # media.ts, settings.ts, commands.ts
    utils/           # mediaTypes.ts, time.ts, draftImage.ts, folderWatcher.ts, finderTags.ts, shortcut.ts
    commands/        # tauri.ts (typed Rust command bridge)
src-tauri/           # Rust backend
  src/                # main.rs, lib.rs, commands/*, db/, menu/, models/
  icons/, Cargo.toml
```

## Key architecture points

- **Single root component**: `src/app/App.tsx` (~3850 lines). Holds screen state, navigation, the viewer host, MiniPlayer rendering, keyboard shortcuts. Most logic lives here.
- **Screen state**: `useState<Screen>("Library")` where `Screen` = `"Library" | "Albums" | "Viewer" | "Duplicates" | "Edit" | "Batch" | "Hidden" | "CameraLens" | "Settings"`.
- **Viewer host pattern**: The ViewerScreen is always mounted inside a `viewer-host` div, even when `screen !== "Viewer"`. When off-screen it uses CSS `position: fixed; inset: 0; z-index: 0; opacity: 0; pointer-events: none` so the video element stays mounted (audio continues) but is invisible and inert.
- **Frozen viewer item**: When navigating away from Viewer, if the last item was a video, `frozenViewerItem` is set to keep it mounted. If it was a photo, `viewer.close()` is called and the viewer unmounts.
- **MiniPlayer**: A fixed-position "now playing" bar (z-index 60, bottom-right) shown when `screen !== "Viewer"` AND `frozenViewerItem?.kind === "video"`. It reads from `usePlaybackStore` and controls the still-mounted video element.
- **Stores**: Zustand. `usePlaybackStore` mirrors the state of the video element mounted in the viewer so the MiniPlayer can control it after the user leaves the Viewer screen.

## Important files

| File | Purpose |
|------|---------|
| `src/app/App.tsx` | Root component: screen state, navigation, viewer host, MiniPlayer rendering, keyboard shortcuts |
| `src/design/components/VideoPlayer.tsx` | In-viewer video player with transport controls, PiP, media session, auto-advance |
| `src/design/components/MiniPlayer.tsx` | "Now Playing" mini bar for background video |
| `src/screens/ViewerScreen.tsx` | Photo/video viewer stage, filmstrip, navigation, transform controls |
| `src/engine/stores/usePlaybackStore.ts` | Shared playback state between VideoPlayer and MiniPlayer |
| `src/engine/stores/useViewerStore.ts` | Viewer zoom/rotation/fit/transform state |
| `src/engine/stores/useLibraryStore.ts` | Library items, inspection, selection, viewer scope derivation |
| `src/engine/utils/mediaTypes.ts` | Media kind definitions, in-app video format support check |
| `src/app/App.css` | App layout, sidebar, grid, viewer host, mini-player positioning |

## Coding conventions

- React functional components with hooks (useState, useEffect, useRef, useCallback).
- Zustand for state management. Selectors: `useStore((s) => s.field)`.
- TypeScript strict mode. Types in `src/engine/types/`.
- CSS modules/App.css for styling. CSS custom properties for theming (defined in `global.css`).
- No comments unless asked.
- Use `import.meta.env.DEV` for dev-only console output.
- Tauri commands: `tauri.items.xxx()` in frontend, `#[tauri::command]` in Rust.

## Testing

- `npm test` → vitest
- `npm run typecheck` → tsc --noEmit
- `npm run tauri dev` → run in development
- `npm run tauri build` → build for macOS
