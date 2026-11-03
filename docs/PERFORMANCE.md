# Library performance checks

## Backend query benchmark

Command:

```sh
cargo test ten_thousand_item_page_and_album_overview -- --ignored --nocapture
```

Result from 2026-11-03:

```text
10k benchmark: first-page items=250 total=10000 page=25ms; album-overviews=1 covers=4 total=25ms
```

`EXPLAIN QUERY PLAN` for the Albums overview used `idx_media_hidden` and `idx_album_items_media` plus a temporary order tree. The date-range query used `idx_media_captured_id`, so no new index was added for those paths.

## Browser harness benchmark

Command:

```sh
npm run build
npm run benchmark:library
```

The command starts `vite preview`, opens the built `harness.html?benchmark=10000`, and records:

- time to first mounted gallery tile;
- Albums overview click-to-cards time;
- command counts for Library and Albums;
- maximum active synthetic thumbnail requests;
- Chromium JavaScript heap size before and after Albums;
- mounted tile/card counts.

Result from 2026-11-03:

```json
{
  "items": 10000,
  "viewport": "1440x900",
  "firstUsefulScreenMs": 94,
  "albumsOverviewMs": 132.2,
  "mountedTiles": 36,
  "albumCards": 101,
  "callsAfterLibrary": {
    "get_library_items": 1,
    "get_album_overviews": 1,
    "get_smart_albums": 1,
    "get_item_thumbnail": 16
  },
  "maxActiveThumbnails": 6,
  "firstScreenMemory": {
    "jsHeapUsedBytes": 9304440,
    "nodes": 1531,
    "jsEventListeners": 318
  },
  "albumsMemory": {
    "jsHeapUsedBytes": 10381708,
    "nodes": 4435,
    "jsEventListeners": 1023
  }
}
```

These are **browser harness proxies**, not signed native/WebKit measurements. The synthetic thumbnail handler does no disk or macOS ImageIO decode, and its `JSHeapUsedSize` value is not process RSS. They do not prove a native 10,000-item first-screen target. They do demonstrate that the application keeps one bounded Library page request, one bounded Albums overview request, virtualized tiles, and no more than six active thumbnail requests in this harness.
