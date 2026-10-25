# VistoGallery — Full Code Review

**Scope:** all Rust sources, all stores/types/IPC wrappers, `App.tsx` in full, settings/sources components, config and capabilities. ~25.4k LoC. No specific focus area was provided, so this covers security, correctness, performance, architecture, UX, testing, and product scope.

**Verdict:** the product thinking is genuinely good — local-first, no network, thoughtful selection/inspection model, cancellable scans, two-phase duplicate detection. The engineering risk is concentrated in three places: **(1) an over-privileged WebView trust boundary, (2) destructive photo operations that can lose or degrade originals, (3) a data layer that loads the entire catalog for every screen.**

---

## 🔴 Critical Issues

### C1. The WebView is fully privileged: CSP is disabled and `asset://` can read all of `$HOME`

**Where**
- `src-tauri/tauri.conf.json:33` — `"csp": null`
- `src-tauri/tauri.conf.json:34-37` — asset protocol enabled, scope `["$HOME/**", "/Volumes/**"]`

**Why this matters**
`csp: null` means the webview runs with zero content restrictions. The asset protocol is simultaneously scoped to every file in the user's home directory and every mounted volume. That turns *any* HTML-injection bug into **arbitrary local file read**:

```js
// If an attacker can get script execution in the webview:
const res = await fetch(convertFileSrc("/Users/me/.ssh/id_ed25519"));
console.log(await res.text());
```

Right now the only injection-shaped sink is `dangerouslySetInnerHTML` in `KindIcon` (`src/app/App.tsx:42-44`), whose input is a hardcoded switch — so this is **not currently exploitable**. But the design has no second line of defense: a future EXIF field, album name, tag, or imported filename rendered with `dangerouslySetInnerHTML` (or any dependency XSS) immediately becomes full home-directory exfiltration. This is the single highest-leverage fix in the codebase.

**Fix**

1. Define a CSP (Tauri injects nonces for its own bootstrap; inline `style={{...}}` props need `'unsafe-inline'` for styles):

```json
"security": {
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost blob: data:; media-src 'self' asset: http://asset.localhost blob:; font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-src 'none'",
  "assetProtocol": { "enable": true, "scope": [] }
}
```

2. Grant asset access per registered library root at runtime instead of globally:

```rust
// in setup() or after a folder is registered
app.asset_protocol_scope()
   .allow_directory(&folder_root, true)?; // verify exact Tauri 2 scope API for your version
```

**Rationale:** defense in depth. A gallery app needs to read photos, not `/Users/*/.ssh`, `~/Library/Mail`, browser profiles, or `/Volumes/*`. Narrow scope also makes accidental path bugs fail loudly instead of silently reading the wrong file.

---

### C2. `save_file` is an arbitrary-file-write primitive

**Where:** `src-tauri/src/commands/mod.rs:2671-2674`

```rust
#[tauri::command]
pub async fn save_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}
```

Registered in `src-tauri/src/lib.rs:187` and called from `src/app/App.tsx:1593` with `Array.from(new Uint8Array(buf))`.

**Why this matters**
The webview chooses the absolute path *and* the bytes. Combined with C1, a single XSS can overwrite `~/.zshrc`, `~/.gitconfig`, an SSH `authorized_keys`, or a `.app` bundle. Even without an attacker, the write is non-atomic: `std::fs::write` truncates the destination before writing, so a crash/disk-full/panic mid-write **destroys the original file**. For the "Replace original" flow this is applied directly to irreplaceable photos.

Secondarily, shipping a `Vec<u8>` through JSON IPC (`Array.from(...)`) serializes every byte as a decimal number — a 20 MB JPEG becomes a ~60-80 MB JSON string and hundreds of MB of transient allocations.

**Fix**

Make the backend own path selection and use an atomic write:

```rust
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn export_bytes(
    app: tauri::AppHandle,
    suggested_name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    // 1. User confirms the destination natively.
    let picked = app.dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter("Image", &["jpg", "jpeg", "png", "webp"])
        .blocking_save_file()
        .ok_or("Export cancelled")?;
    let path = picked.into_path().map_err(|e| e.to_string())?;

    // 2. Write temp next to destination, then rename (atomic on APFS).
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&tmp, &bytes).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, &path).await.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(path.to_string_lossy().into_owned())
}
```

For very large payloads, prefer writing to a temp file on the Rust side and returning a path, or use `tauri::ipc::Response` with raw bytes instead of a JSON number array.

**Rationale:** the only file the app should ever write is one the user explicitly picked in a native dialog, and it should never be truncated in place.

---

### C3. `open_external` executes arbitrary URL schemes, and the shell plugin is unnecessarily enabled

**Where**
- `src-tauri/src/commands/mod.rs:2663-2670` — `Command::new("open").arg(&url)`
- `src-tauri/capabilities/default.json:22` — `shell:allow-open`
- `src-tauri/Cargo.toml:20` + `src-tauri/src/lib.rs:29` — shell plugin initialized
- `src-tauri/capabilities/default.json:18-21` — fs read/write permissions with no `fs:scope-*` entries

**Why this matters**
`open <url>` hands the string to LaunchServices. It will happily open `file:///...`, `.app` bundles, `smb://`, `ssh://`, or any registered custom scheme — i.e. it isn't "open a website", it's "launch anything". The frontend only ever passes credit/help links (`src/engine/commands/tauri.ts:156`), but the command accepts anything.

The fs/shell plugin permissions are also **dead weight**: the frontend imports only `@tauri-apps/plugin-dialog` (verified — no `plugin-fs`/`plugin-shell` imports in `src/`). The fs permissions have no scope entries so they're currently inert, but they're one config line away from becoming a wide hole. Worse, `open_external`, `reveal_in_finder`, and `open_folder` are `async` commands that call blocking `Command::status()` directly on a Tokio worker — a slow `open` stalls other IPC.

**Fix**

```rust
#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL")?;
    match parsed.scheme() {
        "https" | "http" | "mailto" => {}
        _ => return Err("Blocked URL scheme".into()),
    }
    tokio::task::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/open").arg(parsed.as_str()).status()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(())
}
```

Then remove `tauri-plugin-fs`, `tauri-plugin-shell` from `Cargo.toml`, drop their `.plugin(...)` calls, and delete `fs:*` / `shell:allow-open` from capabilities.

**Rationale:** least privilege; a photo gallery does not need a generic URL/file launcher in its IPC surface.

---

### C4. "Replace original" can destroy a photo: lossy re-encode, non-atomic write, and preview/export mismatch

**Where:** `src/app/App.tsx:1528-1599`

This one command combines four independent defects:

**(a) Silent generation loss.** Even a pure rotation re-encodes the JPEG at `0.92` (`App.tsx:1576`), strips EXIF/ICC, and overwrites the original (`1584`). Rotate a photo twice and quality is measurably degraded. There is no backup, no undo, and the confirmation is a `window.confirm` (`1537`).

**(b) Crop math is in the wrong coordinate space.** The crop overlay is drawn on the **rotated/flipped** preview (`App.tsx:4305-4306`), and is normalized against the **stage rect including letterboxing** (`4180-4181`, `4153-4154`). Export interprets `crop.x/y/width/height` as fractions of the **unrotated natural image** (`1548-1551`) and applies crop *before* rotation (`1572`). So `crop + rotation ≠ 0` (or `crop + flip`) exports a different region than the user saw. This is a silent data-corruption bug in the flagship editing feature.

**(c) Color adjustments may not export at all on the stated minimum OS.** `ctx.filter` (`1565-1571`) was unsupported in WebKit until Safari 18. On macOS 13/14 (both advertised as supported in `README.md:7`), the property is ignored, so exports come out unedited while the preview looks edited.

**(d) Stale state after write.** The DB row's `size`/`modified_at` are not updated, and the asset URL doesn't change (`App.tsx:390`), so the grid can keep showing the old thumbnail and wrong file size until the next scan.

**Fix**

- Move editing/export into Rust. `image` + `kamadak-exif`/`imgref` or Core Image via `objc2` gives deterministic, color-managed, EXIF-preserving output, and `render_edited` already exists as a stub for exactly this (`commands/mod.rs:1731-1734`).
- If it must stay in canvas, define one canonical transform order (crop in source space → rotate → flip), compute the crop rect from the **rendered image bounds** (`img.getBoundingClientRect()`), and unit-test the mapping with a 2×2 checkerboard image.
- For in-place edits: write to a temp file, verify decode, `rename` over the original, keep a `.bak` (or use `NSFileManager.replaceItemAt` which is transactional and preserves metadata), then update the DB row and bust the thumbnail cache.
- Never allow in-place replace for a lossy format unless the edit is metadata-only; otherwise require "Save a copy".
- Replace `window.confirm` with the app's own dialog component used elsewhere.

**Rationale:** editing is the feature where a bug costs the user their photo. It should be the most conservative code in the app, not the least.

---

### C5. The trash pipeline can leave disk and catalog divergent, and it shells out to Finder via generated AppleScript

**Where**
- `src-tauri/src/commands/mod.rs:1474-1588` (`move_to_trash`)
- `src-tauri/src/commands/mod.rs:1326-1399` (`remove_library_folder` with `delete_files`)

**Why this matters**
Files are trashed in chunks of 150 (`1507`), and the DB rows are deleted only **after all chunks succeed** (`1577-1585`). If chunk 2 fails, or the user cancels (`1509`, `1543`), the function returns `Err` — but chunk 1 is already in the Trash while its rows remain in the catalog. The UI shows a failure, the grid still lists the photos, and clicking them hits missing files. The same pattern exists in `remove_library_folder`.

The AppleScript is built by string concatenation with only `\` and `"` escaped (`1517-1519`, `1362-1364`). That escaping happens to be correct for AppleScript string literals, so I would not call it a confirmed injection — but it's a single point of failure in a **mass-delete** path, and a filename containing a newline or unusual control character produces a script error that aborts halfway. It also depends on Finder being running and on the user granting Automation permission, and `osascript` cannot be interrupted mid-call (acknowledged at `1542`).

**Fix**

Use the OS trash API instead of Finder:

```rust
// Cargo.toml: trash = "5"
for path in &paths {
    trash::delete(path).map_err(|e| format!("Could not trash {path}: {e}"))?;
}
```

Then make the DB reflect *what actually happened*, per batch:

```rust
for chunk in paths.chunks(TRASH_CHUNK) {
    let mut trashed = Vec::new();
    for path in chunk {
        if trash::delete(path).is_ok() { trashed.push(path); }
    }
    let mut tx = db.begin().await?;
    for path in &trashed {
        sqlx::query("DELETE FROM media_items WHERE path = ?").bind(path).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    // emit progress using `trashed.len()`
}
```

Return a structured result (`{ trashed, failed }`) rather than a bare `Err`, so the UI can show "12 moved to Trash, 3 failed".

**Rationale:** a partial destructive operation must be *represented*, not hidden behind an error string. Per-chunk transactions make the catalog a faithful mirror of the disk.

---

### C6. Every library load reads the entire catalog plus every relation row

**Where**
- `src-tauri/src/commands/mod.rs:921` → `hydrate_relations` at `927-944`
- `src-tauri/src/commands/mod.rs:866` — `SELECT * FROM media_items` with no default limit
- `src/engine/stores/useLibraryStore.ts:296-330` — `getItems(dto || {})` never sends `limit`/`offset`
- `src/app/App.tsx:3125` — `props.items.slice(0, renderLimit)` (rendering is windowed, data is not)

**Why this matters**
`hydrate_relations` runs two **unfiltered** queries:

```sql
SELECT mt.media_id, t.name FROM media_tags mt JOIN tags t ON t.id = mt.tag_id
SELECT media_id, album_id FROM album_items
```

…and then discards every row that doesn't match the current page. With 100k photos, 300k tag links and 50k album links, that's ~350k rows deserialized and allocated **per library load** — and the library reloads after every mutation (`refreshDerived`, favorite toggle, album change, etc.). The payload crossing IPC is the full catalog too: `MediaItem` includes name, path, dimensions, timestamps, tags and album IDs. This is the app's main scalability wall.

**Fix**

1. Pass pagination from the store and implement keyset paging:

```ts
const [items] = await Promise.all([
  tauri.library.getItems({ ...dto, limit: 200, offset: 0 }),
  ...
]);
```

2. Filter the relation queries:

```rust
let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
let placeholders = std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(",");
let sql = format!(
    "SELECT mt.media_id, t.name FROM media_tags mt
     JOIN tags t ON t.id = mt.tag_id
     WHERE mt.media_id IN ({placeholders})"
);
let mut q = sqlx::query_as::<_, (String, String)>(&sql);
for id in &ids { q = q.bind(*id); }
let tag_rows = q.fetch_all(db).await?;
```

(Or fold tags/albums into the main query with `GROUP_CONCAT` and split client-side.)

3. Add indexes that match the access paths:

```sql
CREATE INDEX IF NOT EXISTS idx_media_captured ON media_items(COALESCE(captured_at, modified_at) DESC, id);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media_items(kind, hidden);
CREATE INDEX IF NOT EXISTS idx_media_tags_media ON media_tags(media_id);
CREATE INDEX IF NOT EXISTS idx_album_items_media ON album_items(media_id);
```

**Rationale:** the UI already renders in a window; making the data window match is a small change with an order-of-magnitude effect.

---

### C7. `PRAGMA foreign_keys = ON` is applied to one pooled connection out of five

**Where:** `src-tauri/src/db/mod.rs:20` (`max_connections(5)`), `src-tauri/src/db/mod.rs:37` (`PRAGMA` executed once on `&self.pool`)

**Why this matters**
SQLite's `foreign_keys` pragma is **per connection**, not per database. With a pool of five, roughly 80% of queries run with cascades off. The code partially compensates with manual deletes (`commands/mod.rs:1385-1398`, with an honest comment about exactly this), but that's a workaround applied in some paths and not others. `DELETE FROM media_items` on a connection without FKs leaves orphaned `media_tags`/`album_items` rows, which then inflate every `hydrate_relations` call (C6) forever.

**Fix**

Set it on the connection options so every connection gets it:

```rust
use std::str::FromStr;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use std::time::Duration;

let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))?
    .create_if_missing(true)
    .foreign_keys(true)
    .journal_mode(SqliteJournalMode::Wal)
    .busy_timeout(Duration::from_secs(5))
    .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);

let pool = SqlitePoolOptions::new().max_connections(5).connect_with(options).await?;
```

Then delete the manual cleanup loops and rely on `ON DELETE CASCADE`.

**Rationale:** integrity rules that apply to 20% of your queries are not integrity rules.

---

### C8. Viewer fallback can enter an infinite `getThumbnail` loop on a corrupt image

**Where:** `src/app/App.tsx:4049`

```tsx
<img
  src={props.assetUrl(selected.path)}
  onError={(e) => {
    const target = e.currentTarget;
    void tauri.library.getThumbnail({ itemId: selected.id, size: 1024 })
      .then((r) => { target.src = r.dataUrl; }).catch(() => {});
  }}
/>
```

If the thumbnail data URL itself fails to decode (corrupt file, unsupported codec, zero-byte thumbnail), `onError` fires again and issues another `getThumbnail` request — forever. Each iteration is an IPC round-trip plus base64 decode; the tab pegs a core and floods the backend. The same handler is attached to RAW/video items where a thumbnail may legitimately not exist.

**Fix**

```tsx
const fallbackTried = useRef(new Set<string>());
// ...
onError={(e) => {
  if (fallbackTried.current.has(selected.id)) {
    e.currentTarget.src = FALLBACK_ICON; // or show a "preview unavailable" tile
    return;
  }
  fallbackTried.current.add(selected.id);
  void tauri.library.getThumbnail({ itemId: selected.id, size: 1024 })
    .then((r) => { e.currentTarget.src = r.dataUrl; })
    .catch(() => { e.currentTarget.src = FALLBACK_ICON; });
}}
```

Also gate the fallback on `selected.kind === "photo"` and reset the "tried" set when `selected.id` changes.

**Rationale:** an error handler that can recursively trigger itself needs an explicit terminal state.

---

## 🟡 Suggestions

### Security & hardening

**S1. Remove unused plugins and permissions.** `tauri-plugin-fs` and `tauri-plugin-shell` are initialized (`lib.rs:28-29`) but never imported by the frontend. Remove both from `Cargo.toml:19-20`, their `.plugin()` calls, and `fs:allow-*`/`shell:allow-open` from `capabilities/default.json:18-22`. Fewer plugins = smaller attack surface and smaller binary.

**S2. Validate IPC paths against registered roots.** `reveal_in_finder` (`1590-1600`), `open_folder` (`1602-1609`), `move_to_trash` (`1474`), and `remove_library_folder` (`1326`) accept any absolute path. Even with C1/C2 fixed, defense in depth says: reject paths that aren't inside a `library_folders` row (except dialog-returned export paths, which should be passed as one-time capabilities).

**S3. Replace `dangerouslySetInnerHTML` for icons.** `src/app/App.tsx:43` is safe today because `getKindIcon` returns hardcoded strings, but it's a latent foot-gun. Return a React node or use CSS masks:

```tsx
const KIND_ICON_PATHS: Record<Kind, string> = { photo: "…", video: "…", raw: "…" };
function KindIcon({ kind, size = 14 }: { kind: Kind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={KIND_ICON_PATHS[kind]} />
    </svg>
  );
}
```

**S4. Don't log user file paths in production.** `useLibraryStore.ts:311,328` logs the full DTO and item count; `commands/mod.rs:1550` prints the failing AppleScript (including up to 500 chars of paths); `commands/mod.rs:1186` includes stderr. Gate behind `#[cfg(debug_assertions)]` or a log level. (There are only 3 `console.log`s total, which is otherwise commendably clean.)

**S5. Block dev/asset access in release.** If `devtools` is enabled anywhere in release builds, disable it; also confirm the `asset:` protocol rejects directory listings and symlink escapes outside scope.

### Data integrity & correctness

**S6. Fix the `sortBy` contract.** `useLibraryStore.ts:52` allows `"kind"`, `commands.ts:29` omits it, and the backend whitelist (`commands/mod.rs:896-901`) has no `kind` arm — so choosing "Kind" silently sorts by `modified_at`. Add `Some("kind") => "kind"` plus a secondary `name` tiebreaker, and add `"kind"` to `LibraryFilterDTO`.

**S7. `modifiedAt` isn't a real sort option either.** `tauri.ts`/`commands.ts` advertise it, but the match falls through to the default. Make every declared option explicit:

```rust
let sort_column = match f.sort_by.as_deref() {
    Some("capturedAt") => "COALESCE(captured_at, modified_at)",
    Some("modifiedAt") => "modified_at",
    Some("name") => "name COLLATE NOCASE",
    Some("size") => "size",
    Some("kind") => "kind",
    _ => "COALESCE(captured_at, modified_at)",
};
qb.push(format!(" ORDER BY {sort_column} {sort_order}, id ASC"));
```

**S8. `#[cfg(test)]` constant is used in production code paths.** `LARGE_THUMBNAIL_SOURCE_BYTES` (`commands/mod.rs:980-981`) is only compiled for tests, and `generate_cached_thumbnail` has an `#[allow(unreachable_code)]` (`1113`) because the macOS `return` makes the fallback dead. The fallback path (`1127-1157`) is therefore **never tested on macOS and never runs in production** — `image` decoding is dead code. Either remove it (and the constant) or invert the structure:

```rust
#[cfg(target_os = "macos")]
fn generate_cached_thumbnail(...) -> ... { generate_with_macos_sips(...) }

#[cfg(not(target_os = "macos"))]
fn generate_cached_thumbnail(...) -> ... { /* image crate path, actually reachable */ }
```

**S9. `prune_thumbnail_cache` is fragile and its test encodes the fragility.** `commands/mod.rs:1073-1111` deletes oldest-by-mtime `.jpg` files until under budget; `remove_file` failures keep `total` unchanged, so a permission error stops pruning entirely. The test asserting `total > 0` after pruning (per your test module) will fail if the fixture directory ever shrinks. Make the contract explicit: return `PrunedReport { deleted, bytes_freed, failed }`, and test `total <= max_bytes || all_deletes_failed`.

**S10. Duplicate hashing allocates 64 MB per concurrent task.** `commands/mod.rs:2406` allocates `vec![0u8; 64 * 1024 * 1024]` inside `compute_full_sha256_with_progress`, and up to 2 run concurrently (`2253`). That's 128 MB of zeroed buffers per duplicate scan on top of the read pages, for a single sequential stream. A 1 MB buffer achieves the same throughput on APFS/NVMe; use `tokio::fs::File::read_buf` with a reused `BytesMut`.

**S11. Duplicate scan re-reads files.** Phase 1 reads the first 64 KB (`2378`), Phase 2 re-opens and reads from byte 0 (`2403-2414`). Cache the first chunk and feed it into the SHA-256 context to avoid a second open/seek per file.

**S12. `find_duplicates` includes hidden items but the UI may not.** Intentional per the comment (`2156-2157`), but "reclaimable space" in `DuplicatesScreen` (`App.tsx:5038`) should state whether hidden items count, otherwise the number feels wrong.

**S13. `get_library_folders` is O(items × folders).** `commands/mod.rs:1264-1280` calls `path_is_inside` for every registered root for every item. With 30 sources and 100k items that's 3M string comparisons per call — and it's called on every `loadLibrary` and after every folder removal. Precompute a sorted prefix list and binary-search, or add a `folder_path` column updated at scan time and `GROUP BY` it in SQL.

**S14. `remove_library_folder` loads the entire catalog.** `commands/mod.rs:1337-1352` fetches all rows then filters in Rust, then issues 3 queries per item (`1387-1398`) with no transaction. Replace with a single prefix query and a transaction:

```rust
let mut tx = db.begin().await?;
sqlx::query("DELETE FROM media_items WHERE path = ? OR path LIKE ? ESCAPE '\\'")
    .bind(&root).bind(format!("{}/%", escape_like(&root)))
    .execute(&mut *tx).await?;
tx.commit().await?;
```

**S15. `import_sessions` is written never and read always as empty.** The table exists (`db/mod.rs:139-150`), `get_sessions` returns `vec![]` (`commands/mod.rs:738,855`), and `clear_sessions` deletes from it (`2651`). Either implement import history (see F6) or drop the table and the field from the DTO.

**S16. TS types have drifted from the Rust DTOs.** `MediaItem.duration` is used in `ViewerScreen` but absent from `src/engine/types/media.ts`; `Album.itemIds?` (`media.ts:35`) is never populated; `BatchExportItem` omits `kind`/`date`; `events.*` payloads are `any` (`tauri.ts`). Generate these with `ts-rs` or `specta` in a `build.rs` step so drift becomes a compile error.

**S17. Duplicate formatters.** `formatBytes`/`formatDate` exist in both `src/engine/commands/tauri.ts:195-223` and `src/lib/media.ts`, with different behavior. Keep one and delete the browser pipeline (`src/lib/media.ts` is largely dead — `createMediaItems` has no callers).

**S18. Migrations run imperatively on every startup.** `db/mod.rs:168-209` does `PRAGMA table_info` → conditional `ALTER`/`DROP` on every launch, with no version record. One malformed migration and the app either won't start or silently loses a column. Use `sqlx::migrate!()` with numbered files, or at minimum store `PRAGMA user_version` and branch on it.

**S19. `applyTheme` rebuilds the accent palette on every call.** `useSettingsStore.ts:138+` derives ~10 tokens; `App.tsx:568` calls it inside an effect keyed on `[dark, appearance, accentColor, systemDark]`, so it runs on every system appearance flip too. Memoize by `(accent, dark)` in a module-level `Map`.

**S20. Thumbnail cache is unbounded on the JS side by *bytes*.** `App.tsx:2304-2338` keeps 256 base64 `data:` URLs. At 1024 px JPEG that's easily 30-80 MB of strings retained for the session, plus decode copies. Cache the *object URL* of the cached file (or the file path) and let the webview's image cache do the work, or cap by bytes.

**S21. `useBatchStore` progress subscription has no timeout.** A missed terminal event leaves the export UI spinning forever. Add a watchdog (no progress for N seconds → mark stalled) and always clean up the listener in a `finally`.

**S22. Version is hardcoded in two places and contradicts the build.** `App.tsx:432` and `App.tsx:1403` say `v0.1.0`; `package.json`, `Cargo.toml`, and `tauri.conf.json` say `0.1.1`; `get_version` (`commands/mod.rs:2617`) is unused. Read it once at boot:

```tsx
const [version, setVersion] = useState("");
useEffect(() => { void invoke<string>("get_version").then(setVersion); }, []);
```

### Architecture & maintainability

**S23. `App.tsx` (5,440 lines) and `commands/mod.rs` (3,091 lines) are god files.** App.tsx holds routing, import orchestration, editor export, all dialogs, and eight screens as inner `function`s with `props: any` (7 occurrences). Split by screen under `src/screens/`, move editing/export into `src/engine/editing/`, and move dialogs into `src/design/dialogs/`. In Rust, split `commands/` into `library.rs`, `media.rs`, `albums.rs`, `duplicates.rs`, `settings.rs`, with `dto.rs` and `paths.rs` shared.

**S24. `props: any` defeats the type system exactly where it matters.** Screens receive `props: any` (`App.tsx:2927, 3854, 4102, 4450, 4927, 5025`), so renaming a field or dropping one from the store produces no error. Define `interface LibraryScreenProps { ... }` per screen; the store types already exist.

**S25. Module-level mutable caches are implicit globals.** `useLibraryStore.ts:156` (`sortedSource`), `useSettingsStore.ts:21` (`pendingPatch`), `useEditStore.ts:17` (`draftRevision`). They work, but they make tests order-dependent and break if the app ever runs two windows. Move them into the store slice (or a `WeakMap` keyed by store instance) and export a test reset.

**S26. Screen navigation is a string union + `if/else`.** Works, but there's no back-stack, no deep-link, and no way to restore the last screen. A tiny state machine or `react-router` with `MemoryRouter` would make "back from Viewer to the album you came from" explicit.

**S27. Dead dependencies.** `Cargo.toml`: `aes-gcm`, `rand`, `zeroize` (vault crypto, removed feature), `objc2`/`objc2-foundation` (only if used — grep shows no direct use beyond Tauri), `xattr` (Finder tags stub), `notify` (marked "for future"), `anyhow`/`thiserror` (barely used), `tracing`/`tracing-subscriber` (no init found). Remove or wire them up; each one is compile time and supply-chain surface.

**S28. Logging is inconsistent.** Three `console.log`s, `eprintln!` for real errors, and `tracing` as a dependency with no subscriber. Pick `tracing` + `tauri-plugin-log` with a file sink, and log at `info`/`warn`/`error` consistently. Users will need logs when a scan fails on a permission-protected folder.

### UX / accessibility

**S29. Crop handles are pointer-only.** `App.tsx:4307` uses `onPointerDown` on a `div` with no `tabIndex`, `role`, or keyboard alternative. Add `role="application"` with arrow-key nudge/resize, or provide numeric crop fields. Same for the video PiP controls (`2657`).

**S30. Dialog behavior is inconsistent.** Some dialogs use `role="dialog"` + backdrop + close button (e.g. `1812-1827`), while "replace original" uses blocking `window.confirm` (`1537`). Unify on the custom component; add a focus trap, restore focus to the trigger, and close on `Escape`.

**S31. Empty states should be actions.** `EditScreen` with no item is a nice picker (`4196-4239`), but the Library empty state (`3040+`) and Batch screen when nothing is selected should offer a primary CTA ("Add a folder", "Select photos") rather than explanatory text.

**S32. Confirm scan cancellation.** `SCAN_CANCEL` is a single global `AtomicBool` (`commands/mod.rs`) shared by scan, duplicate hashing, trashing, and batch export. Cancelling one operation can therefore cancel an unrelated one, and the UI's "cancel" affordance is ambiguous. Use per-operation `CancellationToken`s.

---

## ✅ Good Practices

These are worth keeping and building on:

1. **Genuinely local-first.** No network calls, no telemetry, no accounts. For a photo library that's both a privacy feature and a trust feature.
2. **Two-phase duplicate detection** (`commands/mod.rs:2163-2244`): size filter → 64 KB fingerprint → SHA-256 only for fingerprint collisions. This is the right algorithm and avoids reading multi-GB videos unnecessarily.
3. **Structural thumbnail cache key** (`commands/mod.rs:1045-1046`): `item_id:modified_at:source_size:requested_size:v1`. Correct invalidation, including the format version — a detail most apps get wrong.
4. **Atomic thumbnail commit** (`commands/mod.rs:1154-1166`): temp file + `rename`, with a `destination.exists()` race fallback. Clean.
5. **`sips`/ImageIO for thumbnails** (`commands/mod.rs:1169-1204`): downsamples during decode, handles HEIC/HEIF, keeps memory flat, and falls back gracefully with the original reason in the error message.
6. **Thumbnail disk budget with time-based pruning** (`commands/mod.rs:1049-1111`): a 512 MB cap and a 1-hour interval, rather than pruning on every request. Pragmatic.
7. **Cancellation-aware long operations.** `AtomicBool` checks inside scan walk, hash loop, and trash chunks; `spawn_blocking` for `osascript`; `yield_now()` between batches to keep the runtime responsive. The intent is right even where the global flag needs scoping (S32).
8. **Inspection vs. selection is explicitly modeled and documented** (`useLibraryStore.ts:39-43`). This is a subtle UX distinction that most galleries blur; the comments make it maintainable.
9. **Debounced settings persistence with optimistic UI** (`useSettingsStore.ts:8-42`). The comment explains *why* (slider drag → 40 IPC calls), which is exactly how comments should be used.
10. **Accessibility fundamentals are present**: skip target `main-content` with `tabIndex={-1}` (`App.tsx:1407`), `aria-label` on icon-only buttons, `role="status"`/`role="alert"` for notices (`1794`), `role="progressbar"` with `aria-valuenow` for all three progress types (`1703-1773`), `aria-pressed` on toggles, `role="option"`/`listbox` on the album picker. Better than most v0.1 apps.
11. **Security-conscious SQL.** `QueryBuilder` with bound parameters throughout, and the sort column is explicitly whitelisted with a comment explaining why (`commands/mod.rs:894-901`). No SQL injection found.
12. **Honest code comments.** e.g. `commands/mod.rs:1385-1386` explains the FK workaround; `1504` justifies the chunk size; `1553` documents the cancel limitation. This makes review and handoff much easier.
13. **Clean IPC wrapper layer.** `src/engine/commands/tauri.ts` centralizes every `invoke` call, so the command surface is auditable in one file.
14. **Tests exist where they matter most** (thumbnail cache identity, prune behavior, batch naming/export), even if the suite is small.

---

## Feature gaps

### Must-have (a photo manager is incomplete without these)

| # | Gap | Evidence | Why it matters |
|---|-----|----------|----------------|
| F1 | **Folder watching / auto-import** is stubbed | `watch_folder`/`unwatch_folder` return `Ok(())` (`commands/mod.rs:1211-1215`); `notify` is a dependency marked "for future" | Users expect files added in Finder to appear. Manual rescan is the #1 friction. Use FSEvents + a 2 s debounce, incremental upsert. |
| F2 | **EXIF read/write** are stubs | `read_exif` returns an all-`None` struct (`1707-1722`); `write_exif` is a no-op (`1725-1728`) | `capturedAt` is the primary sort/filter axis, and it's currently derived from metadata inspection only. Camera/lens/ISO/GPS are table stakes. Use `kamadak-exif` for read; for write prefer sidecar XMP. |
| F3 | **Finder tags** are stubs | `write_finder_tags`/`read_finder_tags` no-op (`2469-2478`); `xattr` dependency unused | On macOS, tags are the native organizational primitive. Reading `com.apple.metadata:_kMDItemUserTags` and mapping to `tags` is a high-value, low-effort win. |
| F4 | **Safe non-destructive edit pipeline** | `render_edited` returns "Not implemented" (`1731-1734`); export is canvas with C4 defects | Editing must be (a) preview-accurate, (b) EXIF/ICC-preserving, (c) undoable. Without this, "Replace original" is a liability. |
| F5 | **Undo for destructive actions** | Trash, remove-from-album, batch export, replace-original all irreversible | Even a 10-action in-memory undo stack for album/tag/favorite changes materially reduces anxiety. Trash already has OS-level undo via Finder — surface it. |
| F6 | **Import session UI/history** | Table exists but never written (`db/mod.rs:139`); DTO always `vec![]` | Users need "what did I import last time, and did it finish?" Especially for large SD-card ingests. |
| F7 | **Resume/verify for large scans** | `scan_library` is all-or-nothing per invocation, with no persisted checkpoint | A 200k-file library on an external drive will be interrupted (sleep, unplug). Currently that means starting over. |
| F8 | **Catalog backup/restore** | No export of albums/tags/favorites; DB is a single SQLite file | Tags and albums represent hours of work. Offer "Export catalog" (JSON) and a `VACUUM INTO` backup on demand. |
| F9 | **Search across albums/duplicates/hidden** | `query` only applied in `get_library_items`; each screen has its own ad-hoc filtering | A single global search (name, album, tag, camera) is expected. |
| F10 | **Grid pagination/virtualization** | Full catalog in memory (C6), `slice(0, renderLimit)` | Not a feature per se, but it gates every other feature at scale. |

### Nice-to-have

- Smart albums (saved filter predicates), map view from GPS, duplicate resolution actions ("keep newest, trash rest" with a dry-run preview).
- Keyboard shortcut cheatsheet + command palette (`⌘K`), drag-and-drop import onto the window/album.
- Sidecar XMP support (non-destructive, interoperable with Lightroom/Darktable).
- Quick Look integration (`QLPreviewPanel`) instead of the custom viewer for formats the webview can't decode.
- Export presets ("Web 2048px", "Full quality + metadata") and remembered last-used folder.
- Face/OCR search — optional, and only if it can be done fully on-device with a clear opt-in.
- Apple Photos / iCloud import assist (read-only, via `Photos.framework`).
- Per-folder ignore rules (`.vistogalleryignore`) for caches and `node_modules`-style noise.
- Batch rename with a live, validated preview (the naming helpers already exist at `App.tsx:4401-4442`).

### Remove / stop advertising

| Item | Where | Recommendation |
|------|-------|----------------|
| `check_updates` returning `{ available: false }` | `commands/mod.rs:2658-2661` | Either implement Tauri updater or remove the command and any UI entry. A fake updater is worse than none. |
| `compute_hash` stub | `commands/mod.rs:2462` | Delete; duplicates already hash internally. |
| `render_edited` stub | `commands/mod.rs:1731` | Implement (F4) or delete the command from the handler so it can't be called. |
| Unused browser media pipeline | `src/lib/media.ts` (`createMediaItems`, ~119+) | Delete; no callers, duplicates formatters and extension lists. |
| `MEDIA_EXTENSIONS` duplication | `mediaTypes.ts` vs `kind_for_ext` | Keep the Rust side authoritative; expose one command for the frontend. |
| `import_sessions` table/field/DTO | `db/mod.rs:139`, `commands/mod.rs:38` | Implement F6 or remove. |
| Vault crypto deps | `Cargo.toml:53-56` (`aes-gcm`, `rand`, `zeroize`) | Remove; the "vault" concept was folded into `hidden` (`db/mod.rs:165-187`). |
| Layout modes `filmstrip`/`overview` if not reachable | `types/media.ts` | Either wire them into the layout switcher or remove them from the union. |
| `window.confirm` delete/replace flows | `App.tsx:1537` | Replace with the existing dialog component. |

---

## Design-flow review

**First run → empty library.** The `LibraryScreen` empty state explains but doesn't convert. There is no prominent "Add your first folder" CTA in the main content area; the path is Sidebar → Sources → Add. For a local-first app, the folder picker should be the empty state's primary button. Also: after picking a folder, the scan begins with no "X photos found / Y skipped / Z failed" summary — `ScanResult` has the data, but the UI reduces it to a transient notice.

**Import vs. rescan is conflated.** `scan_library` both discovers new files and refreshes existing ones, and `SettingsScreen` exposes a "Rebuild" path that bypasses the progress/busy UI. That means two code paths for the same operation, with different feedback and different cancellation behavior. Model it explicitly: `addSource(path)` (first scan, full progress) vs. `refreshSource(path)` (incremental, quiet) vs. `rebuildSource(path)` (force, destructive-ish, requires confirmation). One pipeline, three entry points.

**Destructive actions are inconsistent.** Three different confirmation patterns:
- Delete item: custom `alertdialog` with count (`App.tsx:2015-2033`)
- Remove folder: custom dialog with optional "also delete files" (`2168-2205`)
- Replace original: native `window.confirm` (`1537`)

Pick one component, and always state the **exact consequence** and the **reversibility**. "This cannot be undone" is honest; make that visually distinct (destructive button styling) and default-focus Cancel.

**Edit → Export is a one-way door.** Drafts are persisted (`useEditStore` localStorage), but:
- Exporting clears the draft even for "save a copy" (`1594`), so iterating on an edit means losing your recipe.
- There's no "Save preset" or "Copy edits / Paste edits" across photos.
- There's no before/after toggle in the export dialog (the editor has "show original", but export doesn't summarize what will change).
- In-place replace doesn't refresh the DB row or thumbnail (C4d).

Recommended flow: `Edit → Save (draft) → Export copy` as the default; `Replace original` as a secondary, clearly-marked destructive action that first creates a backup and records an undo entry.

**Batch export.** Driven entirely by `selectedIds` (`App.tsx:1607-1608`). If the user navigates to Batch with nothing selected, they get an empty screen. Better: show "N selected" with a link back to Library, or allow selecting within Batch. The naming preview (`4426`) is a nice touch — extend it with collision detection and a "will overwrite" warning.

**Duplicates.** The hashing progress is well-designed (`phase`, `filesProcessed`, `bytesProcessed`, `currentFile`). But the screen doesn't persist scan results across navigation, and "reclaimable space" doesn't state whether hidden items are included. Add a clear summary ("12 groups · 3.4 GB reclaimable · 4 files hidden") and a dry-run resolution flow.

**Viewer.** The zoom/rotate/flip model is good, and the "inspection ≠ selection" separation is excellent. Two gaps: no pan when zoomed (zooming to 200% centers, so you can't inspect corners), and the `<img onError>` fallback loop (C8). Add drag-to-pan plus `+`/`-`/`0` keyboard shortcuts and a filmstrip.

**Settings.** `SettingsScreen` and `SourcesManager` both surface scan/rebuild actions, which duplicates state and invites races (start a rebuild while a startup scan is running). Route every scan through one store action with a single busy flag, and disable scan controls while `busy === true`.

**Version/update surface.** About says `v0.1.0`, the sidebar says `v0.1.0`, package/README say `0.1.1`, and `check_updates` always says "up to date". This is a trust detail: users notice. Fix S22 and either ship the updater or remove the update check.

---

## Prioritized plan

**Week 1 — stop the bleeding (security & data loss)**
1. C1: define CSP, narrow asset scope, allow roots at runtime.
2. C2: replace `save_file` with dialog-scoped atomic writes.
3. C3: scheme allowlist for `open_external`; remove unused fs/shell plugins and permissions.
4. C4a/b: make in-place replace backup + atomic, and fix crop/rotation coordinate mapping (or gate crop+rotate combos until fixed).

**Week 2 — integrity & scalability**
5. C7: `foreign_keys(true)` in connect options; delete manual cascade workarounds.
6. C5: `trash` crate + per-chunk transactions + structured partial results.
7. C6: pagination in the store + `IN (...)` relation hydration + indexes.
8. C8: terminal fallback state in the viewer.
9. S6/S7: fix sort whitelist and TS contract.

**Weeks 3-4 — architecture & confidence**
10. Split `App.tsx` and `commands/mod.rs`; type every screen's props.
11. Add Vitest + Testing Library; cover export transform math, store reducers, and the duplicate merge logic.
12. Add GitHub Actions: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `npm run typecheck`, `npm run build`.
13. Implement F1/F2/F3 (watch + EXIF + Finder tags) — these unlock the "native macOS gallery" promise.
14. S18: move to `sqlx::migrate!`.
15. Remove the stubs and dead dependencies listed above.

**Then** — F4 (native edit pipeline), F5 (undo), F6 (import sessions), F8 (catalog backup).

---

### Final note

The strongest parts of this codebase are the product instincts: local-first, cancellable long operations, structural thumbnail caching, two-phase duplicate detection, and an explicit selection model. The weakest part is that the **security and data-loss boundaries were drawn around "the webview is trusted" and "the file is still there"** — both assumptions that break the moment there's one bug. Fixing C1-C5 doesn't require redesigning anything; it requires narrowing the blast radius of code that already exists.
