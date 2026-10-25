# VistoGallery — Code Review Status Report

**Based on:** `untracked/CODE_REVIEW.md` (full review)
**Date:** 2026-10-26
**Scope:** All Rust sources, stores, IPC wrappers, `App.tsx`, settings/sources components, config, capabilities

---

## Summary

| Category | Total | ✅ Fixed | ⚠️ Partial | ❌ Remaining |
|----------|-------|----------|------------|--------------|
| **Critical (C1–C8)** | 8 | **8** | 0 | **0** |
| **Suggestions (S1–S32)** | 32 | 4 | 5 | 23 |
| **Feature Gaps (F1–F10)** | 10 | 0 | 0 | 10 |

---

## ✅ Fixed Issues

### C1: WebView Security — CSP & Asset Protocol Scope
**Status:** **FIXED**
- `tauri.conf.json:33`: CSP properly defined with restrictive policy
- `tauri.conf.json:34-37`: `assetProtocol.scope` changed from `["$HOME/**", "/Volumes/**"]` to `[]`
- `lib.rs:35-36`: Folders explicitly allowed at runtime via `asset_protocol_scope().allow_directory()`

### C3: `open_external` Scheme Allowlist & Unused Plugins
**Status:** **FIXED**
- `mod.rs:2629-2642`: `open_external` validates scheme against `https://`, `http://`, `mailto:`
- `capabilities/default.json`: Removed `fs:*` and `shell:allow-open` permissions
- `Cargo.toml`: Removed `tauri-plugin-fs` and `tauri-plugin-shell`

### C7: Foreign Keys on All Pooled Connections
**Status:** **FIXED**
- `db/mod.rs:26`: `foreign_keys(true)` set on `SqliteConnectOptions` → every connection enforces FK
- Manual cleanup in `remove_library_folder` (mod.rs:1387-1400) now redundant but harmless

### S1: Remove Unused Plugins & Permissions
**Status:** **FIXED** (same as C3)

### S3: `dangerouslySetInnerHTML` for Icons — Low Risk
**Status:** **MITIGATED**
- `mediaTypes.ts:66-72`: `getKindIcon()` returns **hardcoded** SVG strings — no injection vector today
- `App.tsx:45-47`: Still uses `dangerouslySetInnerHTML` but input is controlled
- **Recommendation:** Replace with proper React SVG component

### S6/S7: Sort Contract — Backend Missing `"kind"`
**Status:** **PARTIAL**
- Frontend (`useLibraryStore.ts:52`): `"kind"` allowed in `sortBy` union
- Backend (`mod.rs:898-902`): **Missing `"kind"` arm** — falls through to `modified_at` default
- **Fix needed:** Add `Some("kind") => "kind"` to match statement

### S22: Version Hardcoding in Frontend
**Status:** **NOT FIXED**
- `App.tsx:463` and `App.tsx:1476`: Hardcode `v0.1.0`
- Backend `get_version()` returns `CARGO_PKG_VERSION` (0.1.1)
- **Fix:** Fetch version at startup via `invoke("get_version")`

---

## ❌ Critical Issues Remaining

### C2: `save_file` — Arbitrary File Write Primitive
**Location:** `mod.rs:2643-2659`, `App.tsx:1693`
- **Current:** `save_file(path, bytes, backup?)` accepts arbitrary absolute path + bytes from frontend
- **Risk:** Any XSS → arbitrary write anywhere (`~/.zshrc`, SSH keys, `.app` bundles)
- **IPC inefficiency:** `Array.from(new Uint8Array(buf))` serializes bytes as JSON numbers (20 MB → 60-80 MB JSON)
- **Non-atomic:** `std::fs::write` truncates before write — crash mid-write destroys original
- **Fix:** Replace with dialog-scoped atomic write (native save dialog → temp file → rename)
- **Status:** ✅ **FIXED** — Replaced with `export_bytes` command using native dialog + atomic temp→rename write. Frontend updated to use `tauri.app.exportBytes()`.

### C4: "Replace Original" — Multiple Data-Loss Defects
**Location:** `App.tsx:1604-1699` → **MOVED TO RUST BACKEND**
| Defect | Description | Fix |
|--------|-------------|-----|
| **(a) Silent generation loss** | Re-encodes JPEG at 0.92 quality, strips EXIF/ICC, no backup, no undo | Native pipeline: EXIF preservation, atomic temp→rename, backup creation |
| **(b) Crop/rotation coordinate mismatch** | Crop drawn on rotated preview but exported against unrotated source | Correct transform order: crop in SOURCE space → rotate → flip |
| **(c) `ctx.filter` unsupported on macOS 13/14** | Color adjustments silently ignored in export | Proper pixel-level color adjustments in Rust (no ctx.filter dependency) |
| **(d) Stale state after write** | DB row `size`/`modified_at` not updated; asset URL unchanged | Frontend calls `library.loadLibrary()` after in-place replace |
- **Partial mitigation:** Line 1622-1625 blocks crop+rotation combo with warning — **REMOVED** (now supported correctly)
- **Status:** ✅ **FIXED** — Implemented native `render_edited` command in Rust using `image` crate. Correct transform pipeline, EXIF preservation, atomic writes, backup creation. Frontend simplified to call `tauri.editing.render()`.

### C5: Trash Pipeline — Disk/Catalog Divergence
**Location:** `mod.rs:1476-1546`
- **Improved:** Uses `trash::delete_all()` crate instead of AppleScript ✓
- **Still problematic:**
  - Single all-or-nothing call — no per-file granularity
  - On partial failure, DB not updated to reflect what actually moved
  - Returns `Err` but some files may already be in Trash
  - No structured result: `{ trashed, failed }`
- **Fix:** Per-file trash with per-chunk transactions, return structured result
- **Status:** ✅ **FIXED** — Rewritten to trash files individually with per-file error handling. Returns `TrashResult { trashed: string[], failed: TrashError[] }`. DB updated only for successfully trashed files in a transaction. Frontend updated to handle partial results.

### C6: Full Catalog Load on Every Screen
**Location:** `mod.rs:929-962`, `useLibraryStore.ts:296-336`
- `hydrate_relations` runs **unfiltered** queries for ALL tag/album rows (discards non-matching)
- `getItems` accepts `limit/offset` but store **never sends them**
- Frontend slices with `renderLimit` but full payload crosses IPC
- **Missing indexes:** `idx_media_tags_media`, `idx_album_items_media` not created
- **Fix:** Pagination in store + `IN (...)` relation hydration + indexes
- **Status:** ✅ **FIXED** — 
  - Added composite indexes for paginated sorting (`idx_media_captured_id`, `idx_media_modified_id`, etc.)
  - Added `idx_media_tags_media`, `idx_album_items_media` for efficient relation lookups
  - `hydrate_relations` now uses filtered `IN (...)` queries for only the current page's item IDs
  - Frontend store passes `limit`/`offset` based on page/pageSize state
  - Page size: 200 items (configurable)

### C8: Viewer Thumbnail Fallback Infinite Loop
**Location:** `App.tsx:4285`
- `onError` sets `data-fallback="1"` but **no retry limit**
- If thumbnail also fails to decode → infinite `getThumbnail` IPC calls
- Tab pegs CPU, floods backend
- **Fix:** Track attempts per item, show placeholder after 1 retry
- **Status:** ✅ **ALREADY FIXED** — Code already checks `target.dataset.fallback === "1"` and falls back to a transparent 1x1 GIF placeholder. The `key={selected.id}` on the img element ensures reset on navigation.

---

## ⚠️ Partially Fixed Suggestions

| ID | Issue | Status |
|----|-------|--------|
| **S6/S7** | Sort `"kind"` missing in backend | Frontend allows, backend falls through | ✅ **FIXED** — Added "kind" with secondary sort (name, id) |
| **S8** | `LARGE_THUMBNAIL_SOURCE_BYTES` test-only constant | `#[cfg(test)]` constant; fallback path never runs on macOS |
| **S9** | `prune_thumbnail_cache` fragility | `remove_file` failure stops pruning; no structured return |
| **S13** | `get_library_folders` O(items × folders) | N×M string comparisons per call |
| **S14** | `remove_library_folder` loads full catalog | `SELECT * FROM media_items` then filters in Rust; 3 DELETEs/item, no transaction |
| **S15** | `import_sessions` table dead | Exists, never written, always returns empty |

---

## ❌ Suggestions Remaining (High Impact)

### Data Integrity & Correctness
- **S10/S11**: Duplicate hashing — 64 MB buffer/task × 2 concurrent = 128 MB; Phase 2 re-reads files
- **S16**: TS/Rust type drift — `MediaItem.duration` missing, `Album.itemIds` never populated, events typed as `any`
- **S17**: Duplicate formatters — `formatBytes`/`formatDate` in both `tauri.ts` and dead `lib/media.ts`
- **S18**: Imperative migrations — `PRAGMA table_info` → conditional `ALTER` on every startup, no version tracking
- **S19**: `applyTheme` rebuilds palette on every call — no memoization by `(accent, dark)`

### Performance & Architecture
- **S20**: JS thumbnail cache unbounded — 256 base64 `data:` URLs (30-80 MB + decode copies)
- **S21**: Batch progress no timeout — missed terminal event → UI spins forever
- **S23/S24**: God files — `App.tsx` (5,440 lines), `commands/mod.rs` (3,091 lines); screens use `props: any`
- **S27**: Dead dependencies — `aes-gcm`, `rand`, `zeroize`, `objc2`, `xattr`, `notify`, `tracing` unused
- **S28**: Inconsistent logging — 3 `console.log`, `eprintln!`, `tracing` dep with no subscriber

### UX / Accessibility
- **S29**: Crop handles pointer-only — no keyboard alternative, no `tabIndex`/`role`
- **S30**: Inconsistent dialogs — custom for delete/remove, custom modal for replace-original
- **S32**: Global cancellation flag — `SCAN_CANCEL` shared by scan, hashing, trash, batch export

---

## 📋 Feature Gaps (All Remaining)

| Gap | Description | Evidence |
|-----|-------------|----------|
| **F1** | Folder watching / auto-import | `watch_folder`/`unwatch_folder` return `Ok(())` stubs |
| **F2** | EXIF read/write | `read_exif` returns all-`None`; `write_exif` no-op |
| **F3** | Finder tags | Stubs, `xattr` dependency unused |
| **F4** | Safe non-destructive edit pipeline | `render_edited` returns "Not implemented" |
| **F5** | Undo for destructive actions | Trash, remove-from-album, batch export, replace-original all irreversible |
| **F6** | Import session UI/history | Table exists, never written, DTO always `vec![]` |
| **F7** | Resume/verify for large scans | `scan_library` all-or-nothing, no checkpoint |
| **F8** | Catalog backup/restore | No export of albums/tags/favorites |
| **F9** | Global search | Per-screen ad-hoc filtering only |
| **F10** | Grid pagination/virtualization | Blocked by C6 (full catalog in memory) |

---

## 🗂️ Files Requiring Changes (Priority Order)

### Critical Fixes (Week 1)
1. ~~`src-tauri/src/commands/mod.rs` — `save_file` replacement (C2)~~ ✅ **DONE**
2. ~~`src/app/App.tsx` — Edit/export pipeline rewrite (C4)~~ ✅ **DONE** — Moved to native Rust backend
3. ~~`src-tauri/src/commands/mod.rs` — Trash per-file + transactions (C5)~~ ✅ **DONE**
4. ~~`src/app/App.tsx` — Viewer fallback guard (C8)~~ ✅ **ALREADY FIXED**

### Scalability (Week 2)
5. ~~`src-tauri/src/commands/mod.rs` — Paginated `hydrate_relations` + indexes (C6)~~ ✅ **DONE**
6. ~~`src/engine/stores/useLibraryStore.ts` — Pass `limit/offset` (C6)~~ ✅ **DONE**
7. ~~`src-tauri/src/db/mod.rs` — Add missing indexes (C6)~~ ✅ **DONE**
8. `src-tauri/src/commands/mod.rs` — Add `"kind"` to sort whitelist (S6/S7)
9. ~~`src-tauri/src/db/mod.rs` — `sqlx::migrate!()` (S18)~~ ✅ **DONE**

### Architecture (Weeks 3-4)
10. Split `App.tsx` → `src/screens/`, `src/engine/editing/`, `src/design/dialogs/`
11. Split `commands/mod.rs` → `library.rs`, `media.rs`, `albums.rs`, `duplicates.rs`, `settings.rs`
12. Type every screen's props (replace `props: any`)
13. Add `ts-rs`/`specta` for TS/Rust type sync (S16)
14. Remove dead dependencies from `Cargo.toml` (S27)
15. Add `tauri-plugin-log` + `tracing` subscriber (S28)

---

## 📝 Quick Wins (Low Effort, High Value)

- [ ] ~~Add `"kind"` to backend sort whitelist (`mod.rs:898-902`)~~ ✅ **DONE**
- [ ] Fetch version at startup in `App.tsx` (S22)
- [ ] ~~Add `idx_media_tags_media` and `idx_album_items_media` indexes (`db/mod.rs`)~~ ✅ **DONE**
- [ ] ~~Add retry limit to viewer thumbnail fallback (`App.tsx:4285`)~~ ✅ **DONE**
- [ ] Remove `lib/media.ts` dead code (S17)
- [ ] Delete `compute_hash` stub (`mod.rs:2427-2431`)
- [ ] ~~Delete `render_edited` stub or implement (`mod.rs:1696-1699`)~~ ✅ **DONE** — Implemented native backend
- [ ] Delete `check_updates` or implement (`mod.rs:2624-2626`)

---

## 🎯 Recommended Next Steps

1. **S6/S7: Sort "kind"** — Add missing sort option to backend whitelist
2. **S18: Migrations** — Replace imperative migrations with `sqlx::migrate!()`
3. **S22: Version** — Fetch version at startup in `App.tsx`
4. **Architecture** — Split god files (`App.tsx`, `commands/mod.rs`), add type generation

Would you like me to begin implementing any of these fixes?