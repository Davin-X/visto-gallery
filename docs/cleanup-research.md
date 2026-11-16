# Cleanup research: how other Mac cleaners work

This document records what other macOS cleanup tools actually do, compared against
VistoGallery's Cleanup screen (`src-tauri/src/commands/junk.rs`), and the phased
plan that came out of it. [Status](#status) says which parts of the plan have
shipped; the research sections describe the other tools, not VistoGallery.

Reviewed November 2026:

| Tool | Version / source |
|---|---|
| Mole CLI | `tw93/Mole` `main`, security design last reviewed against V1.59.0 on 2026-10-08 |
| Mole for Mac | `mole.fit` product and docs pages |
| CleanMyMac | MacPaw Safety Database articles, updated 2026-10-26 |
| AppCleaner | FreeMacSoft 3.7 release notes and product description |
| PearCleaner | `alienator88/Pearcleaner` 5.4.3 (project on hold) |
| DaisyDisk | `daisydiskapp.com` tech specs, APFS guide, developer comments |
| BleachBit | `bleachbit/cleanerml` `release/*.xml` |
| OnyX | Titanium Software 5.1.2 product page |
| MacSweep | the CLI this feature was originally modelled on; `clean all --execute` |

## The four questions

Every cleaner answers the same four questions. Tools differ far more in 2–4 than
in 1.

1. **Discovery** — what becomes a candidate?
2. **Protection** — what is structurally forbidden, whatever the input?
3. **Pre-flight** — is it still safe at the instant of deletion?
4. **Review** — how does the user verify before, and after?

A cleaner that is strong on 1 and weak on 2–4 is a liability. A cleaner that is
narrow on 1 but strong on 2–4 is merely limited.

---

## Mole

### Shape

A bash library plus two Go programs: `mo analyze` (disk treemap TUI) and
`mo status` (hardware dashboard). The cleaner is not clever code; it is a large
curated body of knowledge. Approximate sizes of the knowledge files:

| File | Size |
|---|---|
| `lib/clean/dev.sh` | ~270 KB |
| `lib/clean/project.sh` | ~161 KB |
| `lib/clean/apps.sh` | ~123 KB |
| `lib/clean/app_caches.sh` | ~102 KB |
| `bin/clean.sh` | ~90 KB |
| `lib/clean/caches.sh` | ~57 KB |

That is roughly 700 KB of shell encoding "what this tool leaves behind". The list
is the product.

### Discovery

- Ten cleanup categories: user essentials, app caches, browsers, developer tools,
  AI tools, communication/design tools, uninstall leftovers, installers, System
  Data, Trash.
- `mo purge` looks for 33 artifact names inside project roots: `node_modules`,
  `target`, `build`, `dist`, `venv`, `.venv`, `.pytest_cache`, `.mypy_cache`,
  `.tox`, `.nox`, `.ruff_cache`, `.gradle`, `.terragrunt-cache`, `__pycache__`,
  `.next`, `.nuxt`, `.output`, `vendor`, `bin`, `obj`, `.turbo`,
  `.parcel-cache`, `.dart_tool`, `.zig-cache`, `zig-out`, `.angular`,
  `.svelte-kit`, `.astro`, `coverage`, `DerivedData`, `Pods`, `.cxx`, `.expo`,
  `.build`.
- Project roots are identified by **manifest indicators** — `package.json`,
  `Cargo.toml`, `go.mod`, `pyproject.toml`, `requirements.txt`, `pom.xml`,
  `build.gradle`, `terragrunt.hcl`, `Gemfile`, `composer.json`, `pubspec.yaml`,
  `Package.swift`, `Makefile`, `build.zig`, `build.zig.zon`, `.git` — not by
  folder names like `~/Projects`.
- `bin` and `vendor` are excluded from quick hint scans because they are noisy;
  `bin` is guarded separately because .NET build output and a project's own
  `bin/` are indistinguishable by name.

### Protection

Every deletion funnels through `validate_path_for_deletion` in
`lib/core/file_ops.sh`. Six independent checks, any one of which rejects:

1. **Non-empty and absolute.** Relative paths interact with the caller's `$PWD`
   and are never accepted.
2. **Leaf symlink resolution.** A symlink target is resolved and re-checked
   against the deny lists.
3. **Ancestor symlink resolution.** Check 2 only inspects the leaf; a redirected
   `~/Library/Caches` could otherwise walk into `~/Documents`. The parent is
   canonicalised (a physical `cd`) and the deny predicates re-run on the resolved
   leaf. This check is **deny-only**: resolving may reject, never grant. The
   common case stays fork-free by walking ancestors with `[[ -L ]]`.
4. **Path traversal.** `..` is rejected only as a full path component, so
   Firefox's `name..files` directory remains legitimate.
5. **Control characters.** `\n`, `\t`, and other `[[:cntrl:]]` bytes are rejected
   to prevent log injection and shell surprises.
6. **Allow-then-deny.** An explicit allow-list for known-rebuildable subtrees
   under `/private` (`/private/tmp`, `/private/var/log`, `/private/var/folders`,
   `/private/var/db/diagnostics`) and `coresymbolicationd` data, *then* a deny
   list for `/`, `/bin*`, `/sbin*`, `/usr*`, `/System*`, `/Library/Extensions*`,
   `/etc*`, `/var/db*`, `/private`, `/private/etc*`, then
   `should_protect_path`.

The ordering matters: allow first means adding a safe system cache never requires
weakening a deny rule.

Three overlapping app lists, deliberately redundant:

| List | Used by | Shape | Why |
|---|---|---|---|
| Inline `case` patterns | cleanup | wildcards | fast `com.apple.*` guard in tight loops; misses are acceptable |
| `SYSTEM_CRITICAL_BUNDLES` | uninstall + path protection | explicit IDs | must be exhaustive — a miss would let a user uninstall Finder |
| `APPLE_UNINSTALLABLE_APPS` | uninstall | explicit IDs | allow-list, because `com.apple.*` cannot be a blanket block |
| `DATA_PROTECTED_BUNDLES` | cleanup + path protection | wildcards | 1Password, JetBrains, VPNs and similar |

A monthly CI job (`bundle_audit.yml` → `audit_bundle_drift.sh`) enumerates
`/System/Applications`, reads each `CFBundleIdentifier`, and opens an issue for
any ID not classified. That is how the lists survive a macOS release.

**The best engineering idea in the repo:** raw `rm -rf` and `find … -delete` are
only permitted with a same-line `# SAFE: <reason>`, enforced by
`scripts/audit_destructive_sinks.py` from `scripts/check.sh` and the CI security
job. The validated wrappers carry the annotation too. The effect is that every
bypass must state its constraint in writing before it can land.

### Pre-flight

- `MOLE_DRY_RUN=1` short-circuits the remove primitive, not the UI. A dry run of
  `mo clean` also writes every candidate to `~/.config/mole/clean-list.txt`.
- `MOLE_TEST_NO_AUTH=1` refuses `sudo`, `osascript`, and `launchctl`, enforced by
  PATH stubs in `scripts/test.sh`.
- **Caches belonging to running apps are skipped**, with a reason
  (`pnpm cache · skipped (pnpm busy)`).
- Before deletion the original path, the protection lists, the user whitelist,
  and the object's identity are checked **again**.
- The whitelist lives at `~/.config/mole/whitelist`, one path per line. If the
  file cannot be read, `clean`, `purge`, and `optimize` **stop** instead of
  running without it. Fail-closed by design.
- `mo purge` protects: directories containing deployment keypairs, nested Git
  repositories, and any directory Git tracks. The Git probe is a bounded
  `git ls-files` with a literal, case-insensitive pathspec, `GIT_OPTIONAL_LOCKS=0`,
  `core.fsmonitor=false`, and `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` scrubbed
  from the environment. A timeout returns "unknown", which is treated as unsafe.
- `CACHEDIR.TAG` with the standard signature marks a directory as a cache.
- Scans have per-phase time budgets (`MOLE_TIMEOUT_*`, 2–300 s). Results carry
  `scan_status: complete | partial | unavailable`.
- Fuzz corpora: 96 adversarial paths in `tests/fuzz_corpus/dangerous_paths.txt`
  plus a Go fuzz target asserting that any accepted path is absolute, free of
  null bytes, and free of `..` components.

### Review

- Trash routing differs by command. `analyze`, `uninstall`, and `slim` go to
  Trash. `clean`, `purge`, and `installer` **delete permanently**.
- The Trash path tries `/usr/bin/trash`, then an atomic no-overwrite rename into
  the per-volume Trash, and uses Finder AppleScript only as the last fallback.
  Each route is validated before and after resolution, and `trash`/`osascript`
  run with a 30-second timeout so a hung Finder cannot wedge the binary.
- Every operation is appended to `~/Library/Logs/mole/operations.log` and
  `deletions.log`; `mo history --json` reads it back. `MO_NO_OPLOG=1` disables it.
- The native app sorts candidates by **recovery cost**: *regenerable*,
  *expensive to rebuild*, *irreplaceable*. Only regenerable items are routine
  cleanup. Running apps and protected paths stay out; uncertain items arrive
  unchecked; the result separates cleaned, trashed, skipped, and failed.

### Weaknesses

- Permanent deletion by default for the three highest-volume commands.
- The knowledge lives in shell, which is fast to write and hard to test; the
  project compensates with bats suites and fuzz corpora, not types.
- A CLI cannot show you *what* a file is — only its path, owner, and size.

---

## CleanMyMac — curated negative knowledge

The Safety Database is a "remove-or-keep reference book" of rules, exceptions, and
app-specific instructions curated since 2008. Its value is not the cache path
list; it is the exceptions:

- Spotify keeps its offline library inside cache files.
- Some apps store licenses or configuration in cache-shaped directories.
- Some apps must be quit, with consent, and reopened around a clean (Safari,
  Chrome, Electron apps, JetBrains).
- Photo Junk refuses to scan Photos versions it has not verified.

Smart Selection pre-checks only automatically generated data. Explicitly left
unchecked: application leftovers, Xcode module cache and archives, document
versions closer than four hours (keeping the latest), and the most recent iOS
backup. Each module has an Ignore List, and every clean is still reviewed.

The lesson matches Mole's built-in exclusions (`.ollama/models`,
`.lmstudio/models`, `.cache/huggingface`, `.claude/projects`, `.codex/sessions`,
and `Library/Caches/com.apple.e5rt.e5bundlecache`, which says "cache" in its name
and is still excluded because it holds Apple Neural Engine compiled models):

> A cleaner's quality is measured by what it refuses, not by what it finds.

---

## AppCleaner and PearCleaner — identity matching

Both resolve the app's **bundle identifier** (`Info.plist` / `mdls`), not its
display name, then search roughly twenty known roots at depth one to two:

`Application Support`, `Caches`, `Preferences`, `Containers`,
`Application Scripts`, `Saved Application State`, `LaunchAgents`,
`/Library/Application Support`, `/Library/LaunchDaemons`, `/var/db/receipts`,
cookies, widgets, plug-ins.

Matching is by app name and bundle ID with a user-visible sensitivity setting;
extensions are stripped before comparison; `com.apple.*` folders are skipped.
PearCleaner adds include/exclude directories, a privileged helper for system
folders, Full Disk Access, and a Sentinel Monitor that watches the Trash and
offers the leftover sweep when an app is trashed.

Known failure modes: false positives on shared components and license files, and
false negatives on deeply nested or daemon-installed files. Both tools mitigate
with a review checklist and Trash, not with stronger inference.

This is a different axis from cache cleaning: it is *uninstall*, and it needs
admin rights for half the interesting paths. It is out of scope for a gallery app.

---

## DaisyDisk and `mo analyze` — measurement, not deletion

DaisyDisk walks the file catalog (name and size only, never contents), reports
**physical** size, detects **APFS clones** (first occurrence counted, clones get
zero), handles hard links, and exposes **hidden space** — the difference between
used bytes and everything it could see. That gap is how local Time Machine
snapshots become visible. Restricted folders are scanned through a privileged
helper ("scan as administrator"); parallel scans are queued on rotational disks
because concurrent reads make the head jump.

Deletion is permanent and entirely user-driven, with "safety stoppers" for
essential paths.

Its own marketing makes the category-wide argument: cleaners typically recover
1–5 GB of caches that grow back, while deleting files you no longer need recovers
10–100 GB. That is a fair critique, and it is why a cleanup screen should also
answer "what is actually big?", not only "what is technically disposable?".

`mo analyze` is the same idea in a terminal: treemap, `scan_status`, APFS clone
accounting, and confirmed moves to Trash.

---

## BleachBit — rules as data

One XML file per application in `bleachbit/cleanerml`:

```xml
<cleaner id="7zip" os="windows">
  <label>7-Zip</label>
  <option id="history">
    <action command="winreg" path="HKCU\Software\7-Zip\Compression" name="ArcHistory"/>
  </option>
</cleaner>
```

Commands include `delete`, `truncate`, `shred`, `walk.all`, and `winreg`. Each
file carries `@tested`, `@testeddate`, and `@cleanerby` metadata in its header.

The architectural point: contributions are low-risk data changes that never touch
the engine, and the engine can validate the rule file before acting on it.
BleachBit's other axis — shredding and free-space wiping — is a privacy product,
not a space product, and does not belong here.

---

## OnyX — maintenance is a separate axis

OnyX wraps `periodic daily/weekly/monthly`, LaunchServices rebuilds, Spotlight
reindexing, DNS flush, cache and log removal, and permission repair. One binary
per macOS major version; administrator rights required.

It reclaims almost nothing. It fixes broken state. Mixing "optimize" into a
space-reclaim screen is how cleaners acquire their reputation.

---

## Cross-tool comparison

| | Mole | CleanMyMac | AppCleaner/Pear | DaisyDisk | BleachBit | OnyX | **VistoGallery** |
|---|---|---|---|---|---|---|---|
| Primary axis | cleanup + uninstall + status | suite | uninstall | measure | privacy | maintain | cleanup |
| Discovery | curated shell lists | curated DB | bundle ID match | full walk | XML rules | fixed tasks | fixed allowlist + manifest-matched artifacts |
| Path validation | 6 checks + app lists | ignore list | protected apps | safety stoppers | engine | n/a | allowlist + id re-check |
| Re-check at delete | yes | yes | yes | yes | yes | n/a | **yes** |
| Running-app awareness | yes (skip) | yes (quit/reopen) | protects running apps | n/a | no | n/a | **yes (skip)** |
| Skip reason surfaced | yes | implicit | n/a | n/a | no | yes | **yes** |
| User whitelist | yes, fail-closed | ignore list | exclude dirs | no | yes | yes | **yes, fail-closed** |
| Rules editable without rebuild | yes (shell) | yes (DB) | no | n/a | yes (XML) | no | **no** |
| VCS/keypair protection | yes | no | no | no | no | n/a | **yes** |
| Completeness reporting | yes | yes | partial | yes | no | yes | **yes** |
| Operation log | yes | yes | no | no | partial | no | **yes (history)** |
| Recovery | Trash for 3 of 6 | Trash | Trash | permanent | permanent | n/a | **Trash always** |
| Recovery-cost model | 3 tiers | smart selection | n/a | n/a | n/a | n/a | 2 tiers (irreplaceable never listed) |

## Status

As of November 2026, in `src-tauri/src/commands/junk.rs` and
`src/screens/CleanupScreen.tsx`:

| Plan item | State |
|---|---|
| 1.1 Busy detection | Shipped. `ps` process names per rule; an unknown process list makes every guarded rule busy. |
| 1.2 Skips as data | Shipped. `JunkSkip` with `SkipReason`; shown collapsed under each category. |
| 1.3 Completeness | Shipped. `ScanStatus` `complete`/`partial`/`unavailable`/`off` per category, scanned in parallel. |
| 1.4 Whitelist | Shipped as **Never clean** (`cleanup_ignored`), checked at scan and clean; an unreadable list refuses both. |
| 1.5 Operation log | Shipped as cleanup history (`cleanup_runs`, last 50 runs). |
| 1.6 Single sink | Shipped as a unit test: `junk.rs` may not call `std::fs::remove_*` outside its tests. |
| 2.1 Recovery tiers | Shipped. `JunkTier` `regenerable`/`rebuildable`; only regenerable items are one-click selectable. |
| 2.2 Project-aware purge | Shipped. 20 artifact rules matched by manifest, Git-tracked/nested-repo/key/recent-activity refusal, hermetic bounded Git probe. `dist`, `build`, `bin`, `vendor` and `coverage` stay out as ambiguous. |
| 2.3 Rules as data | Not done. Rules are still compiled-in constants (`STATIC_JUNK`, `ARTIFACTS`). |

Also shipped, beyond the plan:

- Sizes are allocated bytes; hard links count only when every link is inside
  the item (the rest is reported as `sharedBytes`).
- Documents, Desktop and Downloads are read only after the user turns that on,
  so opening the screen never triggers macOS folder-access prompts.
- The project walk never descends into a registered library folder.
- The overview shows Finder-style free space (important-usage capacity) before
  and after cleaning, the photo library's footprint, and recent runs.

---

---

## Plan

### Phase 1 — make the list trustworthy

Small, independent changes in `junk.rs` and `CleanupScreen.tsx`.

**1.1 Busy detection.** A fixed map from category to process names, checked with
`pgrep -x` (and an anchored `pgrep -f` fallback only where needed):

| Group | Processes |
|---|---|
| Xcode | `Xcode`, `xcodebuild`, `Simulator`, `CoreSimulatorService` |
| npm/yarn/pnpm | `node`, `npm`, `yarn`, `pnpm` |
| Cargo | `cargo`, `rustc` |
| Homebrew | `brew` |
| CocoaPods/SwiftPM | `pod`, `swift`, `xcodebuild` |

A busy group is not offered; it becomes a skip with a reason. This is the single
highest-value change: it prevents losing work, not just disk space.

**1.2 Skips as data.** Add to the report:

```rust
pub enum SkipReason {
    AppRunning, RecentActivity, Unreadable, TimedOut, GitTracked, Whitelisted, NotPresent,
}
pub struct JunkSkip { id: String, label: String, path: String, reason: SkipReason }
```

Render skips collapsed under their group ("2 skipped · Xcode is running"), so an
empty category is explainable.

**1.3 Completeness.** `stats()` must distinguish empty from unreadable:

```rust
pub enum ScanStatus { Complete, Partial, Unavailable }
pub struct CategoryStatus { category: JunkCategory, status: ScanStatus, reason: Option<String> }
```

An unreadable directory becomes `Partial`, not zero bytes. The heading shows
"Some folders could not be read — grant Full Disk Access" when any category is
partial. For a cleaner, silently reporting zero is the worst failure mode.

**1.4 Whitelist.** A `cleanup_whitelist(path TEXT PRIMARY KEY, created_at INTEGER)`
table. Applied at scan (never offered) and re-checked at clean (a stale id is a
failure, not a deletion). **If the table cannot be read, refuse the clean** —
fail closed, like Mole's whitelist file. UI: "Never clean" on each row, managed
in the same screen.

**1.5 Operation log.** A `cleanup_operations` table: `started_at`, `finished_at`,
`item_ids` (JSON), `removed`, `bytes`, `failed`, `skipped`. A History section at
the bottom of the screen showing the last runs and actual freed bytes. Note that
estimated bytes and freed bytes differ once Trash and APFS are involved; do not
present one as the other.

Acceptance: `cargo test --lib` covers busy detection with a fake process table,
unreadable-directory status, whitelist refusal, stale-id refusal, and log
recording. The screen tests cover the skip section and the partial banner.

**1.6 Enforce the single sink.** Add a CI grep (or a small test) that fails if
`std::fs::remove_` appears in `commands/junk.rs` without a `# SAFE:` comment.
This is Mole's audit idea reduced to one file, and it keeps a future contributor
from adding a direct delete.

### Phase 2 — the actual space

**2.1 Three recovery-cost tiers.** Replace `JunkSafety` with:

```rust
pub enum JunkTier { Regenerable, Rebuildable } // Irreplaceable is never listed
```

`Regenerable`: DerivedData, simulator caches, package manager caches, logs.
`Rebuildable`: Archives, device support, `node_modules`, project artifacts,
installers. Only `Regenerable` is pre-checked by "Select safe items"; the label
becomes "Select regenerable". Keep the recovery story in the row detail
("re-downloads on next build", "needs `npm install`").

**2.2 Project-aware purge.** Replace the eight folder names with manifest
detection, and the one artifact name with the full list:

- Indicators: `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`,
  `requirements.txt`, `pom.xml`, `build.gradle`, `Gemfile`, `composer.json`,
  `pubspec.yaml`, `Package.swift`, `Makefile`, `build.zig`, `.git`.
- Artifacts: the 33 names listed under Mole above, minus anything ambiguous.
  Keep `bin` and `vendor` out of the default set, as Mole does.
- Default-unselect any artifact with file activity in the last 7 days, and show
  the reason.
- Refuse a candidate when any of these hold: it is inside a Git repository that
  tracks files below it; it contains a nested `.git`; it contains a deployment
  keypair (`id_rsa`, `id_ed25519`, `.pem`, `deploy_key*`); the repository root
  cannot be resolved.
- Honour `CACHEDIR.TAG` with the standard signature as positive evidence.

The Git probe must be bounded and hermetic: `git -c core.fsmonitor=false
--git-dir=<root>/.git --work-tree=<root> -C <dir> ls-files
':(top,literal,icase)<rel>'`, with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
`GIT_COMMON_DIR`, and the pathspec glob switches removed from the environment,
`GIT_OPTIONAL_LOCKS=0`, and a timeout. A timeout is "unknown", which means skip.

**2.3 Rules as data.** Move `STATIC_JUNK` into a JSON file shipped inside the
binary with `include_str!`:

```json
{
  "id": "docker-image-cache",
  "category": "packages",
  "label": "Docker image cache",
  "tier": "rebuildable",
  "targets": ["Library/Containers/com.docker.docker/Data/vms/0/data"],
  "skip_if": ["docker-running"]
}
```

Rules ship inside the signed binary, so the text cannot be swapped on disk; the
allowlist stays a compile-time property of the released app. Adding an entry then
needs a code review of data, not of `unsafe` or deletion logic.

### Phase 3 — later, and probably a different feature

- **Disk map** over library sources, reusing the catalog rather than walking the
  whole disk. DaisyDisk-grade full-disk scanning means TCC prompts and a
  privileged helper; that is a different product.
- **APFS awareness**: local snapshot listing (`tmutil listlocalsnapshots`), clone
  deduplication in size totals, purgeable space. High value for "why is my disk
  full?", high complexity.
- **Uninstall / leftover matching** by bundle ID. Needs admin rights for half the
  paths and is outside a gallery app's remit.

## Non-goals

- Permanent deletion as a default. Trash-only stays.
- Full-disk scanning, privileged helpers, or TCC prompts on first launch.
- "Optimize" tasks (DNS flush, LaunchServices rebuild, `periodic`). Separate axis,
  negative value for a photo app.
- Shredding or free-space wiping.
- Malware scanning.
- Deleting anything the user did not explicitly select.

## Design rules

Derived from the tools above, in priority order:

1. **Never list what you cannot explain.** A row needs path, owner, size, and what
   it costs to get back.
2. **Uncertainty is a skip, and skips are visible.** Silence is indistinguishable
   from "nothing there".
3. **Re-validate at the boundary.** Scan-time trust expires.
4. **Symlink resolution is deny-only.** Resolving may reject, never grant.
5. **Fail closed.** If the whitelist or rules cannot be read, do not clean.
6. **Trash by default.** The only irreversible action is emptying the Trash, which
   the user does elsewhere.
7. **Rules are data; code is the engine.**
8. **Every destructive bypass carries a written reason.**

## Sources

- `tw93/Mole` — `lib/core/file_ops.sh`, `lib/core/app_protection*.sh`,
  `lib/clean/purge_shared.sh`, `bin/purge.sh`, `docs/SECURITY_DESIGN.md`,
  `.github/workflows/bundle_audit.yml`, `README.md`.
- `mole.fit` — Clean, Docs, `llms-full.txt`, and the "AI Mac Cleaners" post.
- MacPaw — "Safety Database" and "Safety and reliability" support articles.
- FreeMacSoft — AppCleaner 3.7 release notes; Cindori and Softpedia reviews for
  observed search locations and failure modes.
- `alienator88/Pearcleaner` — README, issue #312 on the search algorithm.
- DaisyDisk — tech specs, APFS guide, and the developer's answers on
  Stack Exchange about catalog-only scanning and administrator scans.
- `bleachbit/cleanerml` — `release/*.xml`.
- Titanium Software — OnyX product page.
