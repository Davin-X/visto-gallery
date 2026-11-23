# Near-Duplicate & Burst Selection — Plan and Design

## Status
Implemented (Phases 1, 1b, 2 & Phase 3 RAW+JPEG pair guard shipped).
- **Exact Duplicates**, **Camera Bursts**, and **Similar Photos** modes available in Duplicates.
- 128-bit 2D dHash + Mean RGB color profiling with multi-core parallelism and SQLite caching.
- Capture-time proximity clustering with EXIF and filename timestamp fallbacks.
- RAW + JPEG pairing guard protects companion RAW+JPEG pairs from duplicate grouping and burst pruning.

## Problem
Users often shoot bursts or take several nearly identical photos and want to:
1. Find groups of **almost-the-same** photos (not byte-identical).
2. Compare them quickly.
3. Pick the **best** shot (sharpest/most detailed/preferred format/time) and keep it.
4. Remove, hide, or archive the rest safely.

“Almost the same” includes:
- **Burst shots**: rapid sequence, same scene/pose, minor differences (timing varies by seconds or fractions).
- **Near-duplicates**: resized exports, recompressed copies, minor edits, or visually similar frames that are **not** SHA-256 identical.
- **RAW+JPEG pairs** (related but separate): same capture represented in two formats; sometimes treated as a stack/pair rather than duplicates. This design focuses on **burst/near-duplicate selection** and notes pairing as a follow-on.

## Goals
- Detect candidate groups of visually/time-similar photos with acceptable precision (low false positives for destructive actions).
- Provide a review UI that makes picking the best shot fast and safe.
- Reuse existing patterns: `CompareOverlay`, keeper/quality heuristics, selection/delete/hide flows, progress/cancel events.
- Keep scanning responsive (learned from exact-duplicate hashing): throttled progress, cancellable work, blocking work off the async runtime.

## Non-goals (initial phases)
- Perfect semantic similarity (e.g., “same person in different poses”).
- Automatic deletion without user review.
- Video near-duplicate detection (phase later; burst selection is primarily photo-focused).
- Cloud/ML models requiring network calls (local-first).

## UX Design

### Entry points
1. **Duplicates screen evolution (recommended MVP path)**: add a mode/tab/toggle:
   - **Exact duplicates** (current, SHA-256)
   - **Similar photos / bursts** (new)
   This keeps cleanup workflows in one place and reuses group rendering, selection, trash/hide, and compare.
2. **Library Timeline assist (later)**: “Group bursts” or “Show similar in range” from a time cluster.
3. **Context action (later)**: “Find similar photos” for a selected item.

### Primary flow (Similar photos / bursts)
1. User opens **Duplicates** → selects **Similar photos** mode (or dedicated screen, per placement decision).
2. User chooses **scope and options before scanning** (visible, not hidden): scope defaults to **album/folder/time range** (avoid whole-library default until performance is proven), mode (**Bursts** MVP default; **Near-duplicates** only as a gated sub-mode later), and time-window preset (**1s, 2s, 5s**; default conservative, e.g. 2s).
3. Clicks **Scan**.
4. App shows progress with first-class states: **not started, in progress, completed (N groups), cancelled (partial results OK, never ambiguous), error**. Includes processed/total, step/current file where relevant, and cancel.
5. Results show **groups** (bursts/clusters). Each group displays:
   - Thumbnails (scroll/expand), count, time span (e.g., “12 photos · 3.2s burst”), status (**definite burst / likely similar / possible match**), and a **“why grouped”** note.
   - **Suggested keeper** (best pick) with reason badge (e.g., “Highest resolution”, “RAW source”, “Newest/Oldest”).
6. User actions per group (safe defaults):
   - **Compare** (reuse/extend `CompareOverlay`): side-by-side, zoom/pan sync; show metadata differences.
   - **Keep this** (set/confirm keeper) — required before bulk actions.
   - **Select others** / **Select all but keeper** — opt-in, enabled only after keeper is chosen; restricted for **possible match** groups.
   - **Move to Trash** / **Hide** selected (existing safe flows).
7. Global controls: filter, sort (largest group, newest burst, status/confidence/time span), keeper strategy, clear results. Global bulk selection respects the same keeper/status safety rules.

### Safety/clarity
- Never label as “duplicate” when only similar; use **“Similar photos”** / **“Burst”** / **“Near-duplicate candidates”**.
- **Keeper-first, safe defaults**: keep the suggested keeper model, but default to **select none**. Require the user to pick/confirm the keeper before any bulk action. “Select all but keeper” is convenient but risky while heuristics evolve — make it **opt-in** and only enabled **after a keeper is chosen**.
- **Group status taxonomy** (communicated in UI): `definite burst`, `likely similar`, `possible match`. Only **definite/likely** groups may allow bulk-select shortcuts; **possible match** groups should be **review manually** (no bulk auto-select).
- **Why grouped**: show a small reason per group (e.g., “taken within 2.1s”, “filename sequence IMG_1001–1008”, “same camera + similar dimensions”, later “visual hash within threshold”). Builds trust.
- Destructive actions require explicit selection + confirmation patterns consistent with current app.
- Show **why** a keeper is suggested; allow override.

## Detection Design

### MVP (Phase 1): burst clustering only
Avoid O(n²) full image comparison across the whole library.
1. **Time/sequence clustering (burst-first, high value)**
   - Group items by capture time (`createdAt`/EXIF capture time) within a sliding window preset (**1s, 2s, 5s**; default **2s** to favor true bursts; 5s can merge distinct moments). Consider same/nearby folder or camera session heuristics.
   - Also consider filename sequences (`IMG_0001`..`IMG_0010`) as a weak hint.
   - Produces **burst clusters** quickly with high precision for true bursts.
2. **Metadata/format hints (light)**
   - Same camera/lens/aspect/dimensions can strengthen grouping confidence; do not rely on size alone.
3. **RAW+JPEG pair guard (early, light-touch)**
   - Treat likely RAW+JPEG pairs as **related captures, not similar candidates**. If capture time matches closely (e.g. to the second) plus same dimensions/camera and a RAW+JPEG format combo, exclude from similarity grouping or show as a separate **pair** indicator.

### Phase 1b/2: visual near-duplicates (gated)
For candidates inside clusters/buckets when explicitly enabled:
1. **Perceptual hash (dHash/pHash/aHash)** computed from a normalized thumbnail/decode (prefer thumbnail-derived hashes, not full decode).
   - Store hash per media item (cache in DB) to avoid recomputation.
   - Compare with Hamming distance; conservative threshold determines “similar”.
2. **Optional refinement (later)**
   - Downscaled pixel/SSIM-like comparison or feature matching for borderline cases.
   - Only run on top-N candidates after hashing to control cost.

### Classification and explainability
- **Burst**: high time locality (seconds), usually same dimensions/camera.
- **Near-duplicate**: weaker time locality, may differ in size/format/edits; similarity primarily visual/hash-based (Phase 1b/2).
- Expose `groupType`, `status` (`definite burst` / `likely similar` / `possible match`), confidence, and a human-readable **grouping reason**.

### Best-shot / keeper recommendation
Extend the existing keeper concept (see `src/engine/duplicates/grouping.ts` heuristics as reference, but do not couple exact-duplicate and similarity logic incorrectly):
- **Quality signals (when available)**: resolution (width×height), RAW vs JPEG/TIFF/PNG preference (context-dependent), file size as weak proxy, EXIF sharpness/focus/exposure heuristics if metadata exists.
- **User preference modes**: “Best quality”, “Largest”, “Oldest”, “Newest”, “Prefer RAW”.
- **Burst-specific**: prefer frames not flagged blurry (future: sharpness score); until then, use resolution/format/time with clear “suggested” wording.
Return `keeperId` + `keeperReason`.

## Data Model

### SQLite (new/extended tables — proposed)
- `media_similarity_hash` (Phase 1b/2; or extend media metadata/cache tables)
  - `media_id` (PK/FK)
  - `algorithm` (`dhash64`, `phash64`, etc.)
  - `hash` (integer/blob/text)
  - `computed_at`, `source_size`, `source_mtime`, and `path` (or existing content-change signal if available) for invalidation
- **Do not persist similarity group tables in MVP/early phases.** Compute groups on demand, return results, and keep an in-memory result cache until there is a real need (resume/faster reload) and invalidation/staleness are solved. Persistent group tables can create invalidation bugs in a destructive workflow.

**Decision:** Phase 1 needs no hash table. Phase 1b/2 persist **per-item perceptual hashes** for speed; exact-duplicate hashes remain separate.

### Rust/backend types
- `SimilarGroup { id/key, groupType, confidence, reasonHints, keeperId, items: Vec<MediaItem-like>, stats }`
- Progress phases: e.g. `scanning`/`analyzing`/`hashing`/`comparing` (align with frontend progress mapping; be careful with `progressBelongsToOperation` like the import/hashing fix).

## Backend Design (Tauri/Rust)

### Commands (proposed)
- `scan_similar_photos(options)` → groups/progress via events, cancellable.
  - Options: `mode: burst|similar|all`, `timeWindowMs`, `threshold`, `scope` (all library / selected folder / album), `limit`.
- `cancel_similar_scan()` (or reuse a generic scan-cancel pattern if appropriate).
- `get_media_similarity_hash(id)` / internal ensure-hash path.

### Progress & cancellation (carry lessons from exact duplicates)
- Frontend/backend must distinguish first-class states: **not started, in progress, completed (with N groups), cancelled, error**. Avoid ambiguous half-states.
- **Cancel contract**: cancel stops new work, finishes in-flight item safely where possible, and returns a defined result (**partial results OK**, never ambiguous).
- Emit progress at bounded intervals (time-based throttle) and coalesce events; avoid UI/render storms.
- Add/align phases only as needed and ensure `progressBelongsToOperation`-style mapping remains correct.

### Performance & responsiveness
- Run image decode/hash in `spawn_blocking`/bounded worker pool; **never** block the Tauri async executor.
- Reuse existing thumbnail/cache pipeline where possible instead of decoding originals repeatedly.
- Cancellation token checked between items/batches.
- Persist hashes incrementally (Phase 1b/2) so rescans are fast.

### Correctness
- Exclude hidden/trashed items according to product rules (match existing duplicate behavior expectations).
- Invalidate hash cache when file size/mtime/path or a stronger content-change signal indicates change; avoid silently stale results.
- Conservative thresholds/presets by default; tune with real libraries.

## Frontend Design

### State/engine
- `useLibraryStore` or a dedicated `useSimilarityStore` (preferred if scope grows) for:
  - `similarGroups`, `scanSimilar()`, `cancelSimilarScan()`, `clear()`, `progress`, `busy`.
- Reuse `progressBelongsToOperation` mapping; add phases if needed.

### UI components
- Extend `DuplicatesScreen` with a **mode switch** (Exact / Similar) **or** create `SimilarPhotosScreen` that shares group/compare primitives.
- Shared pieces to extract/reuse:
  - Group card/list rendering patterns
  - Keeper badge + “keep this” action
  - Bulk selection (all but keeper)
  - `CompareOverlay` enhancements (show similarity score/time delta if useful)
- New microcopy: “Similar photos”, “Burst”, “Suggested best shot”, “Review before deleting”.

### Accessibility/keyboard
- Same keyboard affordances as Duplicates where applicable (select, compare, trash with confirmation).
- Clear focus states and announcements for scan progress/results.

## Phased Plan

### Phase 0 — Design validation
- Confirm UX placement (Duplicates mode vs separate screen) — placement affects clarity: Duplicates is a cleanup surface, but “Similar/Bursts” may need clearer separation if it changes review expectations.
- Lock MVP to **time-window clustering + filename sequence hinting + basic keeper (resolution/format/time)**. Do **not** commit to a perceptual-hash crate in the same milestone.
- Spike: representative-library performance for time clustering; define scan scopes and progress semantics.

### Phase 1 — Burst clustering MVP (smaller, safer)
- Backend: time-window clustering (presets like 1s/2s/5s, default conservative e.g. 2s) + filename sequence hints + basic keeper suggestion.
- Frontend: Similar/Bursts mode (or separate screen, per decision), group review with **“why grouped”** note, compare, keeper-first selection model, trash/hide.
- **No visual hashing yet.** High precision for true bursts, lower false-positive risk.
- Scoped scans preferred by default (album/folder/time range), with visible options before scan starts.
- Progress + cancel with explicit states and a clear cancel contract.

### Phase 1b (optional, gated) — Near-duplicates
- Only after Phase 1 validation. Gate behind an explicit **“Near-duplicates”** sub-mode with conservative defaults (not the same default scan as bursts).
- Evaluate perceptual-hash approach against pipeline constraints (thumbnail-derived hashes preferred; license fit). dHash is a likely prefilter candidate, but choose based on measured fit.

### Phase 2 — Cached perceptual hashing
- Compute/cache per-item hashes (e.g. dHash/pHash) from thumbnails; similarity grouping with confidence thresholds and invalidation/rescan behavior.
- **Persist per-item hashes** for speed. **Do not persist similarity groups** in MVP/early phases — compute on demand and keep in-memory cache until there’s a clear need (resume/faster reload) and invalidation is solved.

### Phase 3 — Quality/refinement
- Optional sharpness/quality scoring, RAW+JPEG pairing integration, “best of burst” improvements.
- Performance tuning, tests. Keep local-first/privacy constraints.

## Testing Plan
- **Rust unit tests**: time clustering (1s/2s/5s presets), filename sequence hints, threshold grouping, keeper selection, hash distance (Phase 1b/2), cancellation/partial results contract.
- **Failure-mode tests (early)**: empty library, single item, all items hidden/trashed, cancellation mid-scan, hash-cache invalidation, and clusters that **should not** form (guard against false positives).
- **Frontend tests**: grouping/keeper logic (pure), keeper-selection state machine, **“can I bulk-trash right now?”** guard (keeper chosen + group status rules), store behavior, progress phase/state mapping, UI actions (render tests similar to `DuplicatesScreen.test.tsx`).
- **Manual QA**: scoped-scan defaults, large library responsiveness, burst sequences, false positives, RAW+JPEG pair handling, hidden items, cancel behavior and partial-result clarity.
- **Fixtures**: synthetic burst sets (same scene, small offsets), filename-sequence bursts, and resized/recompressed copies (Phase 1b/2).

## Risks & Mitigations
- **False positives → accidental deletion**: conservative defaults, clear labels, no auto-delete, compare-first UX.
- **Performance on large libraries**: prefilter by time/metadata, cached hashes, throttled progress, blocking isolation.
- **Metadata missing**: fall back to file mtime/filename; degrade gracefully.
- **Scope creep (RAW pairing, semantic similarity)**: keep explicit non-goals and phased delivery.

## Open Questions
1. **Placement**: Should Similar/Bursts live inside the Duplicates screen (mode) or as a separate screen? Duplicates is a cleanup surface, but a distinct screen may be clearer if review/selection semantics differ.
2. **Time presets**: Default to **2s** for true bursts? Expose presets **1s / 2s / 5s** (not free-form) for predictability and testing.
3. **Hash crate/approach (Phase 1b/2)**: Evaluate Rust ecosystem fit, thumbnail-derived hashing (avoid full decode), and project license compatibility. dHash may be a good speed/quality prefilter, but choose based on measured pipeline fit.
4. **RAW+JPEG**: Treat as “related captures/pairs”, not “similar candidates”. Define exclusion/indicator behavior explicitly (light-touch rule early; full pairing later if needed).
5. **Caching**: Persist **per-item hashes** (with robust invalidation). Avoid persisting similarity groups until invalidation/resume needs are proven.
