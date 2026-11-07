# Changelog

All notable changes to VistoGallery are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.2] - 2026-11-07

### Added
- Side-by-side duplicate comparison with synced zoom/pan and a metadata table that flags every field the two files disagree on
- Delete confirmations report the space reclaimed, not just the number of items moved
- Journaled edit originals: the true original of an edited photo is verified by size and SHA-256 before a revert, instead of relying on a single `.bak` file that a second edit overwrote
- "Move to Trash" goes through Finder, so deleted items appear in Trash with a working Put Back, and requests are sent as catalog ids that the backend resolves and validates itself
- Duplicates screen can pick the keeper by best quality (RAW > TIFF > PNG > JPEG/HEIC, then pixel count), oldest, or newest

### Changed
- Duplicate grouping and keeper selection moved out of the screen into `src/engine/duplicates/grouping.ts` with unit tests
- Trash refusals are reported per item instead of filtering missing paths out of the request

### Fixed
- Deleting from the duplicates or hidden screen no longer fails for items outside the loaded library page
- A failed trash chunk reports every id it covered, so rows never linger for files that may already have moved
- A catalog failure after the files reached the Trash is reported as a rescan warning instead of a failed delete
- Hidden items no longer shrink the library total count when deleted
- Import progress no longer freezes at 0: an import is titled `importing` locally while the backend reports `scanning`, so phase equality dropped every event
- Duplicate selection is pruned when copies are trashed or hidden, so the action bar stops counting items that are gone
- Duplicate scanning hashes candidates sequentially with throttled progress events so the UI and media playback stay responsive
- The Duplicates screen sticky header docks flush without a floating gap above it

## [0.3.0] - 2026-11-04

### Added
- Capture-date range filtering with EXIF capture time and file-modification fallback
- Smart Albums backed by validated, rule-based filter definitions rather than copied item lists
- Versioned catalog backup and restore with integrity/schema validation, transactional restore, automatic pre-restore snapshots, and missing-path reporting
- Explicit moved-source-root mapping with preview, conflict detection, and transactional rewriting of only the selected registered root
- Automatic folder watching for registered library sources, including startup recovery and actionable watcher errors
- Single-file and bulk actions to merge VistoGallery tags into existing Finder tags without deleting Finder-only tags
- Bounded Albums overview cards based on counts and up to four cover candidates per album
- Details and Timeline library views, including sortable details columns and timeline group selection
- Sources manager actions for filtering, rescanning, revealing, and removing indexed folders
- Multi-folder source selection from the native folder picker
- Visible progress for duplicate hashing, including candidate counts, bytes read, and current file
- Cooperative cancel controls for folder scans, file imports, and duplicate hashing
- Picture-in-picture support for viewer and slideshow videos
- Background video playback when the app loses focus
- Video volume controls (ArrowUp/ArrowDown) in viewer and slideshow

### Changed
- Automatic update checks are now opt-in and default off; Help > Check for Updates remains available and Privacy copy describes the GitHub release-metadata request accurately
- Ordinary library refreshes no longer block behind scan/import busy UI; filter changes use a quiet, non-blocking refresh state with a delayed indicator
- Library grid/overview layouts use the virtualized tile window directly, avoiding a redundant progressive-render wall and misleading "remaining" counter
- Album overview cards load a bounded cover set instead of each album's complete membership
- RAW/JPEG pairing and burst-stacking settings are clearly marked unavailable while dormant values remain compatible
- Refined the top bar, compact navigation, source controls, and destructive settings section
- Updated README and release notes to reflect the current views and browser preview limitations
- Built the browser harness as a second Vite entry so it also works with `npm run preview`
- Improved Viewer navigation and filmstrip behavior, with media fit respecting image aspect ratios
- Viewer and slideshow controls now auto-hide and reappear on hover/movement
- Refreshed the app and in-app brand marks; added native macOS and Windows icon bundle assets
- Reduced idle work during window resizing and removed automatic periodic source scans
- Reduced edit-picker work for large libraries by avoiding per-photo draft reads and loading thumbnails lazily
- Library tiles now load cached 512 px thumbnails (1024 px in Overview, 128 px in Details) instead of full-resolution originals
- Scans now prune catalog rows for files that disappeared from disk since the last scan
- Avoided re-reading unchanged media during regular scans; explicit rebuilds still inspect every file
- Limited duplicate hashing to one file at a time to reduce disk contention on large libraries

### Fixed
- File > Export… and Cmd/Ctrl+E now route to Batch Export instead of reporting "coming soon"
- Folder auto-import can process watched-source changes when enabled, coalesces duplicate events, and surfaces scan failures
- Finder-tag copying deduplicates safely, merges into existing tags, and reports per-file failures without discarding unrelated Finder tags
- Context menus and confirmation dialogs provide usable keyboard focus behavior and predictable focus return
- Clear all resets media type, query, source, rating, label, camera, lens, Smart Album, and capture-date filters from one visible action
- Slideshow video playback now advances on the video's ended event and follows play/pause state
- Videos no longer pause automatically when the app loses focus, enabling background playback
- Inspector toggle uses the inspector icon and remains available in narrow windows
- Hidden item details stay concealed in the inspector until the preview is revealed
- Removed unused panel imports, props, CSS rules, and frontend dependencies
- Fixed source-picker errors and made warnings visible above the panel that triggered them
- Fixed multi-folder selection registering all selected folders in a single pass

### Known limitations
- Native Finder tag visibility, folder watcher behavior under macOS permission denial, native menu click-through, and the full VoiceOver pass still require target-Mac validation
- Smart Album restart persistence and dynamic membership are covered only partially; invalid definitions and applied filter behavior are covered
- First useful screen time, thumbnail concurrency, and memory use have not yet been measured; no performance target is claimed for those metrics
- RAW/JPEG pairing and burst stacking are not implemented

## [0.1.0] — 2026-10-19

### Added
- Browser prototype: React 18 + TypeScript + Vite frontend
- Library grid (Grid / Filmstrip / Overview layouts), smart filters, search
- Viewer with navigation, zoom, full-screen
- Non-destructive edit pipeline with export
- Duplicate detection (SHA-256)
- Batch tools, slideshow, dark/light/system theme
- Tauri 2 + Rust backend scaffold with SQLite catalog, EXIF metadata commands, vault commands
