# VistoGallery native macOS validation checklist

Use this checklist on a signed native build or `npm run tauri dev`. Record the result and evidence for each row before release. A checkbox is not complete if it was only checked in the browser harness.

## Test environment

- Date:
- macOS version:
- Mac model / chip:
- VistoGallery version:
- Build command: `npm run tauri dev` or release build
- Test source folder:
- Test backup path:
- Test media IDs/paths:

## Automated checks available now

```sh
npm test
npm run typecheck
npm run build
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
npm run benchmark:library
cargo test ten_thousand_item_page_and_album_overview -- --ignored --nocapture
```

These do not replace native Finder, permission, VoiceOver, or menu validation.

## Keyboard and focus

- [ ] Library → press `Cmd/Ctrl+F`; focus lands in Search.
- [ ] Library → press `Cmd/Ctrl+A`; selection reflects the visible scope.
- [ ] Library → use Tab/Shift+Tab through filters and type filter buttons.
- [ ] Grid → Right-click photo; menu opens; Arrow keys move; Home/End jump; Escape closes; invoking focus is predictable.
- [ ] `File > Export…` and `Cmd/Ctrl+E` open Batch Export; selected items are preserved; empty selection opens an actionable state.
- [ ] Albums → `Enter`/`Space` opens focused album card.
- [ ] Viewer → Left/Right navigate; `Escape` closes viewer; focus returns to Library/origin.
- [ ] About dialog → Tab/Shift+Tab stays inside dialog; `Escape` closes; focus returns to the button that opened it.
- [ ] Reset/Delete/Restore confirmation dialogs → same focus-in/Tab/Shift+Tab/Escape/return behavior.
- [ ] Settings → Tab order reaches tabs, panel controls, and destructive actions in a sensible order.
- [ ] Context menu appears within screen bounds at edges and supports keyboard activation.

## VoiceOver

Use VoiceOver on the native app and record the exact output where it differs from expected labels.

- [ ] Top bar announces the current section.
- [ ] Search announces its name and search role.
- [ ] Filter buttons announce name and pressed/selected state.
- [ ] Selection count announces changes politely.
- [ ] Photo tiles announce name and selection state.
- [ ] Context menus announce menu role and actions.
- [ ] Dialogs announce dialog title and close/action controls.
- [ ] Batch Export announces selection count and destination/action controls.
- [ ] Error/notice messages are announced without requiring a visual-only cue.

## Native integration

- [ ] Fresh/default profile does not contact GitHub for updates until user opts in.
- [ ] `Help > Check for Updates…` works manually.
- [ ] `Help > Check for Updates…` announces result visually and to VoiceOver.
- [ ] Watcher starts after app restart for registered sources.
- [ ] Copying a new supported file into a watched source appears without manual rescan when auto-import is on.
- [ ] Same file does not appear twice after a burst of rename/modify/create events.
- [ ] Disabled auto-import does not import until manual rescan.
- [ ] Removing a source stops watching or displays a clear failure notice.
- [ ] Full Disk Access denial or inaccessible source produces an actionable message.
- [ ] Finder tag action on one file appears in Finder > Get Info or Tags.
- [ ] Bulk Finder tag action reports per-file success/failure and does not delete Finder-only tags.
- [ ] First delete on a fresh macOS user account shows the Automation prompt naming Finder, and allowing it moves the files to the Trash.
- [ ] Refusing the Automation prompt still deletes: the fallback (NSFileManager) trashes the files and logs that Finder automation is unavailable.
- [ ] A trashed photo appears in Finder > Trash and "Put Back" restores it to its original folder when the Finder path was used.
- [ ] Cancelling mid-batch keeps already-moved files out of the catalog and reports the remainder as not moved.
- [ ] Settings → Save Backup creates a versioned snapshot.
- [ ] Settings → Restore Backup validates before confirmation; malformed file fails without changing library.
- [ ] Valid restore recovers albums/tags/ratings after restart.
- [ ] Missing/moved source paths are reported; root-path mapping preview is required before applying.

## Performance

- [ ] Browser harness benchmark remains reproducible on this branch.
- [ ] Native clean-profile first useful screen recorded on a 10,000-item synthetic library.
- [ ] Native album overview query and wall-clock result recorded.
- [ ] Native thumbnail concurrency observed and recorded.
- [ ] Native memory use recorded with a consistent build/profile.

## Findings

Record each failure as:

- exact app version and commit,
- exact steps,
- expected vs actual,
- screenshot/recording/log/VoiceOver text,
- severity,
- issue link.

## Current validation status

Automated tests and browser/Chromium harness coverage exist for many items above. As of 2026-11-03, Finder visibility, macOS permission outcomes, native menu click-through, and the full VoiceOver pass have **not** been recorded as passing. Do not mark them complete without evidence from the native app.
