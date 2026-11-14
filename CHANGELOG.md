# Changelog

All notable changes to VistoGallery are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-11-14

### Added
- **Animations filter**: a new `Animations` type chip in the library shows items the catalog treats as animated content. It is a filter over a new `is_animated` catalog flag, not a new media kind — animated items are still `photo`, so Photos counts, the viewer, compare, and edit open them exactly as before.
- **Content-based animation detection**: `is_animated` is decided by reading container headers, never by filename and never by decoding pixels — GIF block walk (a second image descriptor), WebP `VP8X` animation flag / `ANIM` chunk, PNG `acTL` before the first `IDAT` (APNG), and `avis`/`msf1` brands in an AVIF/HEIF `ftyp` box. A still GIF is therefore *not* animated, while an animated WebP/APNG/AVIF *is*.
- Catalog migration `008_add_is_animated` adds `media_items.is_animated` (default 0) and seeds existing `.gif` rows; a one-time `backfill_animation_flags` startup pass then probes every candidate row so upgraded libraries get the real answer, not the filename guess.
- **In-app playback for more videos**: VistoGallery ships its own `ffmpeg`/`ffprobe`. Each video is probed first; containers WebKit can't open (such as MKV, or HEVC tagged `hev1`) are remuxed losslessly into a playback cache, and audio is converted to AAC only when needed. Anything that still can't play offers an external player. Video posters fall back to `ffmpeg` when QuickLook can't decode them.
- **One right-click menu everywhere**: the grid, Hidden, the photo viewer and the video player share the same item menu (rating, colour label, albums, hide, move to Trash). Right-clicking inside a selection acts on every selected item and says how many.
- **Viewer filmstrip, drag-to-pan and shortcuts**: the viewer has a filmstrip that pages through the library, zoomed photos pan by dragging, and the viewer and player gain keyboard shortcuts (`Space`/`J`/`K`/`L`, `↑`/`↓` zoom, `R` rotate, `X` flip, `0` reset). RAW files show previews in the grid, compare and viewer.
- **Duplicates**: the compare view shows only the fields that differ, deleting copies shows a summary first, and the notice offers **Undo** to bring trashed copies back.
- **Albums**: create and edit Smart Albums from the Albums screen, reorder albums by dragging or with Move earlier/later, switch to a table list view, and see when each album was last updated.
- **Back and Forward** that remember where you were, including the album you had open: the sidebar's Back button, `⌘[` / `⌘]`, and a mouse's back/forward buttons.
- **Locate… a missing source**: a source folder that moved or was renamed can be pointed at its new location, and every item keeps its albums, tags and edits.
- **Inspector**: a Location row shows the folder (click it to show the file in Finder), and GPS coordinates open Apple Maps.
- Resizable sidebar and Inspector, and each library view remembers its scroll position.
- Hidden is filtered on the server like the library, and the Inspector shows why an item is hidden.

### Changed
- The Inspector starts closed and remembers your choice, so the grid gets the whole window until you open it (⌘⌥I or the toolbar button).
- Batch exports keep capture date, EXIF, camera and GPS data by default; "Strip metadata" is now the opt-in.
- A slideshow hides the top bar and fills the window, and long filenames ellipsize instead of running over the controls.
- **Move to Trash, not Delete**: menus and dialogs say "Move to Trash…" for anything that goes to the Trash, the confirmation names the files ("“a.jpg”, “b.jpg” and 10 more"), and Finder actions are called "Show in Finder" everywhere. "Delete Library Database…" is now **Reset Library…**, and says your files stay on disk.
- Right-click menus are sized and highlighted like native macOS menus; dialogs share one set of widths; the Filters panel and other popovers take keyboard focus when they open.
- The Viewer is no longer a sidebar destination; it opens from what you select or double-click.
- Settings confirm destructive actions by typing a word.
- The appearance and accent controls are back in the top bar, and the app has a new icon.
- Large duplicate cleanups move files to the Trash 200 at a time instead of 50, and one file that can't be moved no longer makes every file in its batch be retried separately.

### Fixed
- **Moves and renames keep the item**: a file moved or renamed inside a source folder used to be pruned and re-imported under a new id, quietly dropping its favourite flag, rating, tags and album membership. The scan now matches vanished rows against newly appeared files by a content fingerprint (migration `010_add_content_signature`: size plus the first and last 64 KiB, never a full read) and re-keys the surviving row, along with its tags, albums and edit records, to the new path. Matching is only applied when it is unambiguous: a copy next to the original, or two vanished files with the same fingerprint, go through the ordinary import path.
- **Hidden items stayed visible in Smart Albums**: Smart Album grids and cover images included hidden items while their counts left them out. Hidden items are now excluded everywhere unless you're on the Hidden screen.
- **Dimensions for more formats**: HEIC, AVIF, RAW, MP4/MOV and some JPEGs showed "Dimensions: Unknown". They are now read on import, and existing items are filled in in the background on the next launch. Formats without a reader yet (WebM, MKV, AVI, WMV) show "—".
- **Search treats `%` and `_` literally**: searching for `_` no longer matches every item.
- **Cancelling a scan stays cancelled**: starting another scan used to silently resume a cancelled one. Two scans of the same folder now run one after the other.
- **Launch survives a damaged catalog**: a locked or corrupt catalog now shows an error instead of crashing, and one-time catalog updates no longer delay launch.
- **Delete library is all-or-nothing**: it runs as one transaction and also clears Smart Albums, edit records, folder watchers and the thumbnail cache.
- **Camera names, capture dates and GPS from EXIF**: camera and lens names were stored in quotes, no photo ever got a capture date (so "Date captured" sorting and the Timeline used file modification time), and southern/western GPS coordinates had the wrong sign. All three are read correctly now, and existing photos are corrected in the background on the next launch.
- **Dates are unambiguous**: dates show a month name ("11 Jul 2026") everywhere, and capture times show exactly what the camera recorded instead of shifting with your time zone.
- **Show extensions works**: names showed the extension even with the setting off, and twice ("a.jpg.jpg") with it on.
- Long file names in the grid are shortened in the middle, so names that share a prefix stay distinguishable.
- Type chips with nothing to show are dimmed; albums no longer show both Play and Slideshow; thumbnail-size buttons are hidden in Details, where they did nothing.
- The viewer's shortcut legend shows once per session instead of on every mouse move (⌘/ lists every shortcut).
- The sidebar drops the always-zero "Uncategorized" row and the static "Storage Healthy" badge.
- "Smart Albums" heading is readable in dark mode.
- The compare dialog says "1 field differs" instead of "1 fields differ".
- **Edit lists every saved draft**: the Saved drafts list only showed drafts among the photos already loaded in the library (0, 3 or 11 instead of all of them).
- **Undo after a duplicate cleanup works on external drives**: it only looked in your home Trash, while macOS keeps trashed files on their own drive.
- **Notices no longer cut each other short**: a quick "Importing…" notice could clear the 10-second Undo toast early.
- **Rescan no longer cancels other scans**, such as auto-import or the cleanup scan at launch.
- **Settings that did nothing now work**: Restore window size and position, Open on launch → Last, and Enable debug logging.
- Hidden's type chips keep their counts when one type is selected, and the sidebar's library stats add up to their total.
- A deleted or disconnected source folder is shown as missing instead of failing.
- Exports, reverts and in-place edits can no longer leave half-written or damaged files, and temporary export files are cleaned up.
- Tag filters no longer produce invalid SQL that emptied the lists; counts, hidden paging and sort order are consistent across pages.
- The native menu's Zoom, Full Screen, Settings and Shortcuts items work.
- The remove-draft badge, album names on narrow cards, and the slideshow caption are laid out correctly.

### Security
- Saving an edited copy no longer accepts a source or destination path from the interface: the backend shows the save dialog and only moves files it rendered.
- Scanning and importing only accept folders and files you picked in a dialog, dropped on the window, or already added as a source.
- Library sources can only be registered from folders you pick: root mapping and backup restore no longer accept a path from the interface, and backups are opened from an isolated copy.
- Video playback only remuxes files that are in your catalog.
- Undo from the Trash only puts files back inside your library sources, under their own name.

### Performance
- Scans and imports read files off the main async runtime, so large libraries no longer stall other actions.
- The default library sort (capture date) uses an index (migration `011_sort_date_index`) instead of sorting the whole catalog for each page.
- Cached thumbnails are read once instead of three times.
- Only the five newest pre-restore catalog snapshots are kept.

### Known limitations
- A move between two different source folders is still a fresh import: the match only looks at rows that vanished from the folder being scanned. Rows imported before this release have no fingerprint until their file is inspected again (a Rescan fills them in), and macOS `mv` preserves the modification time, which lets them follow a same-volume move in the meantime.
- Detection covers the image containers the catalog imports (GIF, WebP, PNG/APNG, AVIF/HEIF). An unreadable or unrecognised file falls back to the `.gif` filename rule rather than being marked still, so a transient I/O error cannot silently un-animate an item; a rescan corrects it.
- Edit/export still flattens animated files: exporting a GIF through the render/export pipeline loses the loop. Not addressed here.

## [0.3.3] - 2026-11-07

### Changed
- Moved the global “Go back” control into the left sidebar for easier access without overlapping screen headers; hidden on the Video screen where the player has its own back control.

### Fixed
- Restored the main content positioning context so the Video player screen no longer overlaps the visible sidebar.
- Improved collapsed sidebar spacing/alignment for the toggle and back controls.

## [0.3.2] - 2026-11-07

### Added
- **Sidebar rail**: collapse the sidebar to an icon rail with a proper panel toggle, persistent WORKSPACE header behavior, restored Sources entry, rail layout polish, and a **Library stats** chart button that opens a portaled stats popup (escapes clipping, paints above main content, viewport-anchored/clamped, keyboard/outside-click dismissal) with accent styling consistent with Sources.
- **Data integrity / trash (P0)**: id-based “Move to Trash” flow with Finder integration on macOS (Put Back support) and server-side catalog-path resolution/validation. Trash is scoped to catalog rows/registered roots, rejects unsafe paths, and reports per-item refusals/failures.
- **Edit originals journal**: in-place edits journal the true original once per media id in app data (verified by size and SHA-256 on revert) instead of relying on a single `.bak` file; legacy `.bak` still supported; trashing removes journal/backup artifacts.
- **Duplicates**: side-by-side compare overlay with synced zoom/pan and metadata diff, quality-based keeper mode (RAW/TIFF > PNG > JPEG/HEIC, then resolution/size) plus oldest/newest, fan thumbnails/UX polish, and delete confirmations that report reclaimed space.
- **Video player**: paged queue with scroll load-more and queue summary, streamlined header with time/queue pill chips, single stage prev/next controls with SVG chevrons and auto-hide behavior aligned with playback hints/controls.

### Changed
- **Editor redesign/polish**: refreshed header/navigation and metadata tiles, sidebar Edit opens the drafts/selection screen with a scrollable saved-drafts grid, toolbar/canvas/layout polish, and aspect/crop workflow refinements.
- **Duplicates screen**: grouping/keeper logic extracted to `src/engine/duplicates/grouping.ts` with tests; compact 32px toolbar/selection/group control rhythm; top padding aligned with other screens.
- **Top bar / panel controls**: clearer sidebar/inspector toggles with matched panel icons and collapse-direction chevron cues.
- **Playback**: single-instance guard (relaunch focuses existing window) and cross-surface audio exclusivity so the same media doesn’t play/sound from multiple surfaces at once.
- Progress events are treated as presentation-only with **phase-matched guards** (e.g. scan vs trash) to prevent overlay/cancel-target confusion.

### Fixed
- **Trash/delete reliability**: deleting from Duplicates/Hidden no longer fails for items outside the loaded library page; failed trash chunks report all covered ids; catalog failures after files reach Trash are reported as rescan warnings (not failed deletes); hidden item deletes no longer shrink library totals incorrectly.
- **Progress/UI responsiveness**: import progress no longer freezes at 0 (phase mapping); duplicate selection pruned when copies are trashed/hidden; duplicate scanning hashes candidates sequentially in `spawn_blocking` with throttled progress/events to keep UI and playback responsive.
- **Editor**: aspect guide dropdown no longer clips (portal + viewport-aware positioning), crop ratio sizing maximizes correctly within the frame, “Crop to this” applies a single atomic update and matches draggable guide size/position; crop counted as adjustments; draft re-persist race on revert/clear fixed; render-loop risk from inline img ref state updates fixed; crash/error text contrast improved.
- **Hide/Unhide**: selection/state resolves correctly in Hidden view, hide/unhide syncs `hiddenItems`/visible `items` and collections, and collections reload after state changes; Hidden disclaimer spacing tightened.
- **Sidebar rail**: fixed stripe/blank layout when sidebar is hidden and collapsed together; Sources visibility and collapsed layout/restyle fixes.
- **Albums/Viewer/Video**: album type counts remain correct when a zero-count filter is selected; viewer opens duplicates/off-scope items reliably via fresh lookup/fallbacks; Duplicates header docks flush without a floating gap.

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
