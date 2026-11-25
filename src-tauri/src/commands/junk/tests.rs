use super::*;

struct TempHome(PathBuf);

impl TempHome {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("visto-junk-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("Downloads")).unwrap();
        // Canonical, so ids built from it match what the scan reports
        // (`/var` vs `/private/var` on macOS).
        Self(dir.canonicalize().unwrap())
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, relative: &str, bytes: usize) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, vec![1u8; bytes]).unwrap();
        path
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Fixture {
    running: HashSet<String>,
    ignored: HashSet<String>,
    protected: Vec<PathBuf>,
    git: Option<PathBuf>,
    personal_folders: bool,
}

impl Fixture {
    fn new() -> Self {
        Self {
            running: HashSet::new(),
            ignored: HashSet::new(),
            protected: Vec::new(),
            git: None,
            personal_folders: true,
        }
    }

    fn env<'a>(&'a self, home: &'a TempHome) -> ScanEnv<'a> {
        ScanEnv {
            home: home.path(),
            protected: &self.protected,
            running: Some(&self.running),
            ignored: &self.ignored,
            git: self.git.as_deref(),
            deadline: None,
            personal_folders: self.personal_folders,
        }
    }
}

fn on_disk(paths: &[&PathBuf]) -> u64 {
    paths
        .iter()
        .map(|path| physical(&std::fs::metadata(path).unwrap()).0)
        .sum()
}

fn age(path: &Path, by: Duration) {
    let when = SystemTime::now() - by;
    std::fs::set_times(path, std::fs::FileTimes::new().set_modified(when)).unwrap();
}

const OLD: Duration = Duration::from_secs(2 * 60 * 60);

fn scan(env: &ScanEnv, category: JunkCategory) -> JunkCategoryReport {
    scan_category(env, category)
}

#[test]
fn static_items_report_allocated_bytes_and_group_targets() {
    let home = TempHome::new("static");
    let a = home.write("Library/Developer/Xcode/DerivedData/a/build.o", 40);
    let b = home.write("Library/Developer/Xcode/DerivedData/b/build.o", 9000);
    let c = home.write("Library/Developer/Xcode/iOS DeviceSupport/17.0/symbols", 25);
    let d = home.write(
        "Library/Developer/Xcode/watchOS DeviceSupport/10.0/symbols",
        15,
    );
    let fixture = Fixture::new();

    let report = scan(&fixture.env(&home), JunkCategory::Xcode);
    assert_eq!(report.status, ScanStatus::Complete);
    let derived = report
        .items
        .iter()
        .find(|item| item.id == "xcode-derived-data")
        .expect("DerivedData is offered");
    assert_eq!(derived.file_count, 2);
    assert_eq!(derived.bytes, on_disk(&[&a, &b]));
    assert!(derived.bytes >= 9000, "allocated, not logical, bytes");
    assert_eq!(derived.tier, JunkTier::Regenerable);
    let support = report
        .items
        .iter()
        .find(|item| item.id == "xcode-device-support")
        .expect("device support is offered");
    assert_eq!(support.bytes, on_disk(&[&c, &d]));
    assert_eq!(report.total_bytes, derived.bytes + support.bytes);
}

#[cfg(unix)]
#[test]
fn hard_links_shared_outside_an_item_free_nothing() {
    let home = TempHome::new("links");
    let store = home.write("Library/pnpm/store/v3/files/aa", 8192);
    let inside = home.write("Library/Caches/Yarn/inside-a", 8192);
    std::fs::hard_link(&inside, home.path().join("Library/Caches/Yarn/inside-b")).unwrap();
    std::fs::create_dir_all(home.path().join("elsewhere")).unwrap();
    std::fs::hard_link(&store, home.path().join("elsewhere/linked")).unwrap();
    let fixture = Fixture::new();

    let report = scan(&fixture.env(&home), JunkCategory::Packages);
    let pnpm = report
        .items
        .iter()
        .find(|item| item.id == "pnpm-store")
        .unwrap();
    assert_eq!(pnpm.bytes, 0);
    assert_eq!(pnpm.shared_bytes, on_disk(&[&store]));
    let yarn = report
        .items
        .iter()
        .find(|item| item.id == "yarn-cache")
        .unwrap();
    assert_eq!(
        yarn.bytes,
        on_disk(&[&inside]),
        "both links inside: counted once"
    );
    assert_eq!(yarn.shared_bytes, 0);
}

#[test]
fn empty_folders_are_not_offered() {
    let home = TempHome::new("empty");
    std::fs::create_dir_all(home.path().join("Library/Developer/Xcode/DerivedData")).unwrap();
    let fixture = Fixture::new();
    let report = scan(&fixture.env(&home), JunkCategory::Xcode);
    assert!(report.items.is_empty() && report.skips.is_empty());
    assert_eq!(report.total_bytes, 0);
}

#[test]
fn a_running_tool_turns_its_rules_into_skips() {
    let home = TempHome::new("busy");
    home.write("Library/Developer/Xcode/DerivedData/a/build.o", 40);
    home.write(".npm/_cacache/index", 40);
    let mut fixture = Fixture::new();
    fixture.running.insert("xcodebuild".to_string());

    let xcode = scan(&fixture.env(&home), JunkCategory::Xcode);
    assert!(xcode.items.is_empty());
    assert_eq!(xcode.skips.len(), 1);
    assert_eq!(xcode.skips[0].reason, SkipReason::AppRunning);
    assert_eq!(xcode.skips[0].message, "xcodebuild is running");
    assert!(
        xcode.skips[0].bytes > 0,
        "the skip still says what it holds"
    );

    let env = fixture.env(&home);
    let (plan, failed) = plan_clean(&env, &["xcode-derived-data".to_string()], &HashSet::new());
    assert!(plan.is_empty());
    assert!(failed[0].message.contains("xcodebuild is running"));

    let packages = scan(&env, JunkCategory::Packages);
    assert_eq!(packages.items.len(), 1, "npm is not busy");
}

#[test]
fn a_running_tools_rule_can_be_forced_by_id() {
    let home = TempHome::new("force-busy");
    home.write(".cargo/registry/cache/serde-1.0.0.crate", 40);
    let mut fixture = Fixture::new();
    fixture.running.insert("cargo".to_string());
    let env = fixture.env(&home);
    let id = "cargo-cache".to_string();

    let (plan, failed) = plan_clean(&env, std::slice::from_ref(&id), &HashSet::new());
    assert!(plan.is_empty());
    assert!(failed[0].message.contains("cargo is running"));

    // Only the id named in the request is waived; the ScanEnv itself is
    // unchanged, so the next selection is checked as usual.
    let forced: HashSet<String> = [id.clone()].into_iter().collect();
    let (plan, failed) = plan_clean(&env, std::slice::from_ref(&id), &forced);
    assert!(failed.is_empty(), "{:?}", failed);
    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].id, id);
}

#[test]
fn an_unknown_process_list_fails_closed() {
    let home = TempHome::new("no-ps");
    home.write("Library/Developer/Xcode/DerivedData/a/build.o", 40);
    let fixture = Fixture::new();
    let mut env = fixture.env(&home);
    env.running = None;
    let report = scan(&env, JunkCategory::Xcode);
    assert!(report.items.is_empty());
    assert_eq!(report.skips[0].reason, SkipReason::AppRunning);
}

#[test]
fn never_clean_is_honoured_at_scan_and_at_clean() {
    let home = TempHome::new("ignored");
    home.write("Library/Caches/Homebrew/bottle.tar.gz", 40);
    let mut fixture = Fixture::new();
    fixture.ignored.insert("homebrew-cache".to_string());
    let env = fixture.env(&home);

    let report = scan(&env, JunkCategory::Packages);
    assert!(report.items.is_empty());
    assert_eq!(report.skips[0].reason, SkipReason::NeverClean);

    let (plan, failed) = plan_clean(&env, &["homebrew-cache".to_string()], &HashSet::new());
    assert!(plan.is_empty());
    assert!(failed[0].message.contains("Never clean"));
    assert!(
        resolve_selection(&env, "homebrew-cache", false, false).is_ok(),
        "reveal still works"
    );
}

#[cfg(unix)]
#[test]
fn an_unreadable_folder_is_partial_not_empty() {
    use std::os::unix::fs::PermissionsExt;
    let home = TempHome::new("unreadable");
    home.write("Library/Caches/Homebrew/ok", 40);
    let locked = home.path().join("Library/Caches/Homebrew/locked");
    std::fs::create_dir_all(&locked).unwrap();
    std::fs::write(locked.join("secret"), b"x").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let fixture = Fixture::new();

    let report = scan(&fixture.env(&home), JunkCategory::Packages);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Root ignores permissions; only assert when the lock took effect.
    if report.status == ScanStatus::Complete {
        return;
    }
    assert_eq!(report.status, ScanStatus::Partial);
    assert!(report.status_message.unwrap().contains("could not be read"));
    assert_eq!(report.items.len(), 1);
}

#[test]
fn project_artifacts_need_their_manifest() {
    let home = TempHome::new("manifest");
    home.write("Code/web/package.json", 2);
    let modules = home.write("Code/web/node_modules/pkg/index.js", 20);
    home.write("Code/rust/Cargo.toml", 2);
    let target = home.write("Code/rust/target/debug/app", 20);
    // No manifests: an ordinary folder that happens to be called target.
    home.write("Code/notes/target/plan.txt", 20);
    // A venv without pyvenv.cfg is not a virtual environment.
    home.write("Code/py/requirements.txt", 2);
    home.write("Code/py/venv/lib/x.py", 20);
    for path in [&modules, &target] {
        age(path, OLD);
    }
    let fixture = Fixture::new();

    let report = scan(&fixture.env(&home), JunkCategory::Projects);
    let mut labels: Vec<&str> = report
        .items
        .iter()
        .map(|item| item.label.as_str())
        .collect();
    labels.sort();
    assert_eq!(labels, ["rust/target", "web/node_modules"]);
    assert!(report
        .items
        .iter()
        .all(|item| item.tier == JunkTier::Rebuildable));
    let web = report
        .items
        .iter()
        .find(|item| item.label == "web/node_modules")
        .unwrap();
    assert!(web.detail.contains("npm"));
}

#[test]
fn recently_changed_or_sensitive_artifacts_are_skipped() {
    let home = TempHome::new("recent");
    home.write("Projects/live/package.json", 2);
    home.write("Projects/live/node_modules/.vite/deps", 20);
    home.write("Projects/keys/package.json", 2);
    let key = home.write("Projects/keys/node_modules/id_ed25519", 20);
    age(&key, OLD);
    home.write("Projects/nested/package.json", 2);
    let nested = home.write("Projects/nested/node_modules/dep/.git/HEAD", 20);
    age(&nested, OLD);
    let fixture = Fixture::new();

    let report = scan(&fixture.env(&home), JunkCategory::Projects);
    assert!(report.items.is_empty(), "{:?}", report.items);
    let reason = |label: &str| {
        report
            .skips
            .iter()
            .find(|skip| skip.label == label)
            .map(|skip| skip.reason)
    };
    assert_eq!(
        reason("live/node_modules"),
        Some(SkipReason::RecentActivity)
    );
    assert_eq!(reason("keys/node_modules"), Some(SkipReason::Sensitive));
    assert_eq!(reason("nested/node_modules"), Some(SkipReason::Sensitive));
}

#[test]
fn an_in_use_artifact_can_be_forced_but_never_a_sensitive_or_ignored_one() {
    let home = TempHome::new("force-artifact");
    // Changed minutes ago: skippable as Active, and the user may override.
    home.write("Projects/live/package.json", 2);
    home.write("Projects/live/node_modules/.vite/deps", 20);
    // A nested repository: refused whatever the user asks for.
    home.write("Projects/nested/package.json", 2);
    let nested = home.write("Projects/nested/node_modules/dep/.git/HEAD", 20);
    age(&nested, OLD);
    // Never clean: also refused when forced.
    home.write("Projects/kept/package.json", 2);
    let kept = home.write("Projects/kept/node_modules/pkg/index.js", 20);
    age(&kept, OLD);
    let mut fixture = Fixture::new();

    let id = |project: &str| format!("projects:{}", home.path().join(project).to_string_lossy());
    let live = id("Projects/live/node_modules");
    let nested = id("Projects/nested/node_modules");
    let kept = id("Projects/kept/node_modules");
    fixture.ignored.insert(kept.clone());
    let env = fixture.env(&home);

    let report = scan(&env, JunkCategory::Projects);
    assert!(report.items.is_empty(), "{:?}", report.items);

    // Without the override the in-use folder is refused.
    let (plan, failed) = plan_clean(&env, std::slice::from_ref(&live), &HashSet::new());
    assert!(plan.is_empty());
    assert!(failed[0]
        .message
        .contains("Changed in the last few minutes"));

    // With it, the same id resolves: the user named it.
    let forced: HashSet<String> = [live.clone()].into_iter().collect();
    let (plan, failed) = plan_clean(&env, std::slice::from_ref(&live), &forced);
    assert!(failed.is_empty(), "{:?}", failed);
    assert_eq!(plan.len(), 1);

    // Forcing a sensitive folder changes nothing.
    let forced: HashSet<String> = [nested.clone()].into_iter().collect();
    let (plan, failed) = plan_clean(&env, std::slice::from_ref(&nested), &forced);
    assert!(plan.is_empty());
    assert!(failed[0].message.contains("Contains a Git repository"));

    // Nor a folder the user marked Never clean.
    let forced: HashSet<String> = [kept.clone()].into_iter().collect();
    let (plan, failed) = plan_clean(&env, std::slice::from_ref(&kept), &forced);
    assert!(plan.is_empty());
    assert!(failed[0].message.contains("Never clean"));
}

#[test]
fn a_repository_without_git_available_is_skipped() {
    let home = TempHome::new("nogit");
    std::fs::create_dir_all(home.path().join("Code/app/.git")).unwrap();
    home.write("Code/app/package.json", 2);
    let file = home.write("Code/app/node_modules/pkg/index.js", 20);
    age(&file, OLD);
    let fixture = Fixture::new();

    let report = scan(&fixture.env(&home), JunkCategory::Projects);
    assert!(report.items.is_empty());
    assert_eq!(report.skips[0].reason, SkipReason::GitTracked);
}

#[test]
fn git_tracked_artifacts_are_refused_and_ignored_ones_offered() {
    let Some(git) = find_git() else {
        return;
    };
    let home = TempHome::new("git");
    let run = |dir: &Path, args: &[&str]| {
        let status = Command::new(&git)
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    };
    let tracked = home.path().join("Code/tracked");
    home.write("Code/tracked/package.json", 2);
    let fixture_file = home.write("Code/tracked/node_modules/fixture.js", 20);
    run(&tracked, &["init", "-q"]);
    run(
        &tracked,
        &["add", "-f", "package.json", "node_modules/fixture.js"],
    );
    run(&tracked, &["commit", "-qm", "init"]);
    age(&fixture_file, OLD);

    let ignored = home.path().join("Code/ignored");
    home.write("Code/ignored/package.json", 2);
    home.write("Code/ignored/.gitignore", 0);
    std::fs::write(ignored.join(".gitignore"), "node_modules\n").unwrap();
    let dep = home.write("Code/ignored/node_modules/dep/index.js", 20);
    run(&ignored, &["init", "-q"]);
    run(&ignored, &["add", "."]);
    run(&ignored, &["commit", "-qm", "init"]);
    age(&dep, OLD);

    let mut fixture = Fixture::new();
    fixture.git = Some(git.clone());
    let report = scan(&fixture.env(&home), JunkCategory::Projects);
    assert_eq!(
        report.items.len(),
        1,
        "{:?} {:?}",
        report.items,
        report.skips
    );
    assert_eq!(report.items[0].label, "ignored/node_modules");
    assert_eq!(report.skips.len(), 1);
    assert_eq!(report.skips[0].reason, SkipReason::GitTracked);
}

#[test]
fn scan_skips_protected_library_roots() {
    let home = TempHome::new("protected");
    home.write("Documents/Photos/package.json", 2);
    let a = home.write("Documents/Photos/node_modules/pkg/index.js", 10);
    home.write("Documents/App/package.json", 2);
    let b = home.write("Documents/App/node_modules/pkg/index.js", 20);
    age(&a, OLD);
    age(&b, OLD);
    let mut fixture = Fixture::new();
    fixture.protected = vec![home.path().join("Documents/Photos")];

    let report = scan(&fixture.env(&home), JunkCategory::Projects);
    assert_eq!(
        report.items.len(),
        1,
        "only the non-library project is listed"
    );
    assert!(report.items[0].path.contains("Documents/App"));
}

#[test]
fn stale_installers_are_offered_and_recent_ones_are_not() {
    let home = TempHome::new("downloads");
    let old = home.write("Downloads/old.dmg", 30);
    age(&old, INSTALLER_MIN_AGE + Duration::from_secs(60));
    let xip = home.write("Downloads/Xcode.xip", 30);
    age(&xip, INSTALLER_MIN_AGE + Duration::from_secs(60));
    home.write("Downloads/new.dmg", 10);
    home.write("Downloads/notes.txt", 5);
    let fixture = Fixture::new();

    let report = scan(&fixture.env(&home), JunkCategory::Downloads);
    let mut labels: Vec<&str> = report
        .items
        .iter()
        .map(|item| item.label.as_str())
        .collect();
    labels.sort();
    assert_eq!(labels, ["Xcode.xip", "old.dmg"]);
    assert!(report.items[0].detail.contains("days ago"));
}

#[test]
fn cleaning_rejects_paths_outside_the_allowlist() {
    let home = TempHome::new("reject");
    let victim = home.write("Documents/secret/notes.txt", 10);
    home.write("Documents/notes/target/plan.txt", 10);
    let fixture = Fixture::new();
    let env = fixture.env(&home);

    for id in [
        "projects:/etc/node_modules".to_string(),
        "projects:/tmp/node_modules".to_string(),
        format!("downloads:{}", victim.to_string_lossy()),
        format!(
            "projects:{}",
            home.path().join("Documents").to_string_lossy()
        ),
        format!(
            "projects:{}",
            home.path().join("Documents/notes/target").to_string_lossy()
        ),
        format!(
            "projects:{}/Documents/x/../secret",
            home.path().to_string_lossy()
        ),
        "unknown:whatever".to_string(),
        "npm-cache-typo".to_string(),
    ] {
        let (plan, failed) = plan_clean(&env, std::slice::from_ref(&id), &HashSet::new());
        assert!(plan.is_empty(), "{id} must not resolve");
        assert_eq!(failed.len(), 1);
    }
}

#[test]
fn cleaning_rejects_a_library_source_even_when_the_id_is_valid() {
    let home = TempHome::new("library");
    home.write("Documents/Photos/package.json", 2);
    let node_modules = home.path().join("Documents/Photos/node_modules");
    home.write("Documents/Photos/node_modules/pkg/index.js", 1);
    let mut fixture = Fixture::new();
    fixture.protected = vec![home.path().join("Documents/Photos")];
    let id = format!("projects:{}", node_modules.to_string_lossy());

    let (plan, failed) = plan_clean(&fixture.env(&home), &[id], &HashSet::new());
    assert!(plan.is_empty());
    assert!(failed[0].message.contains("library source"));
}

#[test]
fn cleaning_resolves_a_valid_artifact_and_installer() {
    let home = TempHome::new("valid");
    home.write("Documents/App/package.json", 2);
    let node_modules = home.path().join("Documents/App/node_modules");
    let file = home.write("Documents/App/node_modules/pkg/index.js", 12);
    age(&file, OLD);
    let installer = home.write("Downloads/old.pkg", 40);
    age(&installer, INSTALLER_MIN_AGE + Duration::from_secs(60));
    let fixture = Fixture::new();

    let ids = vec![
        format!("projects:{}", node_modules.to_string_lossy()),
        format!("downloads:{}", installer.to_string_lossy()),
        format!("downloads:{}", installer.to_string_lossy()),
    ];
    let (plan, failed) = plan_clean(&fixture.env(&home), &ids, &HashSet::new());
    assert!(
        failed.is_empty(),
        "{:?}",
        failed.iter().map(|f| &f.message).collect::<Vec<_>>()
    );
    assert_eq!(plan.len(), 2, "duplicates collapse");
    assert_eq!(
        plan.iter().map(|entry| entry.bytes).sum::<u64>(),
        on_disk(&[&file, &installer])
    );
}

#[test]
fn a_fresh_installer_is_rejected_on_a_stale_row() {
    let home = TempHome::new("fresh-row");
    let installer = home.write("Downloads/fresh.dmg", 40);
    let id = format!("downloads:{}", installer.to_string_lossy());
    let fixture = Fixture::new();
    let (plan, failed) = plan_clean(&fixture.env(&home), &[id], &HashSet::new());
    assert!(plan.is_empty());
    assert!(failed[0].message.contains("newer than 30 days"));
}

#[test]
fn personal_folders_stay_unread_until_turned_on() {
    let home = TempHome::new("personal");
    home.write("Documents/App/package.json", 2);
    let doc = home.write("Documents/App/node_modules/pkg/index.js", 20);
    home.write("Code/Tool/package.json", 2);
    let code = home.write("Code/Tool/node_modules/pkg/index.js", 20);
    let installer = home.write("Downloads/old.dmg", 30);
    for path in [&doc, &code] {
        age(path, OLD);
    }
    age(&installer, INSTALLER_MIN_AGE + Duration::from_secs(60));
    let mut fixture = Fixture::new();
    fixture.personal_folders = false;
    let env = fixture.env(&home);

    let projects = scan(&env, JunkCategory::Projects);
    let labels: Vec<&str> = projects
        .items
        .iter()
        .map(|item| item.label.as_str())
        .collect();
    assert_eq!(labels, ["Tool/node_modules"]);

    let downloads = scan(&env, JunkCategory::Downloads);
    assert_eq!(downloads.status, ScanStatus::Off);
    assert!(downloads.items.is_empty());

    // Rows from an earlier scan with the switch on are refused now.
    let ids = vec![
        format!(
            "projects:{}",
            home.path()
                .join("Documents/App/node_modules")
                .to_string_lossy()
        ),
        format!("downloads:{}", installer.to_string_lossy()),
    ];
    let (plan, failed) = plan_clean(&env, &ids, &HashSet::new());
    assert!(plan.is_empty());
    assert_eq!(failed.len(), 2);
}

#[test]
fn the_project_walk_never_enters_a_library_folder() {
    let home = TempHome::new("walk-library");
    // A project nested inside the library would only be found by walking it.
    home.write("Code/Photos/2024/shoot/package.json", 2);
    let file = home.write("Code/Photos/2024/shoot/node_modules/x.js", 20);
    age(&file, OLD);
    let mut fixture = Fixture::new();
    fixture.protected = vec![home.path().join("Code/Photos")];
    let report = scan(&fixture.env(&home), JunkCategory::Projects);
    assert!(report.items.is_empty() && report.skips.is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn disk_space_reports_a_sane_volume() {
    let disk = disk_space(Path::new("/")).expect("the boot volume has a size");
    assert!(disk.total_bytes > 0);
    assert!(disk.available_bytes <= disk.total_bytes);
    assert!(
        important_available_bytes(Path::new("/")).is_some(),
        "Foundation reports important-usage capacity for the boot volume"
    );
}

/// Every deletion must go through the Trash sink. A direct unlink in the
/// cleanup code (outside these tests) fails the build's test run.
#[test]
fn cleanup_code_never_deletes_directly() {
    for (file, source) in [
        ("junk.rs", include_str!("../junk.rs")),
        ("junk/rules.rs", include_str!("rules.rs")),
    ] {
        // Bare names, so `use std::fs::remove_file;` cannot slip past.
        for sink in ["remove_file", "remove_dir", "unlink"] {
            assert!(
                !source
                    .lines()
                    .any(|line| { !line.trim_start().starts_with("//") && line.contains(sink) }),
                "{file} must not call {sink}; use the Trash"
            );
        }
    }
}

#[test]
fn project_roots_are_discovered_but_never_system_cloud_or_linked() {
    let home = TempHome::new("roots");
    for dir in [
        "development",
        "IdeaProjects",
        "Library",
        "Pictures",
        "OrbStack",
        "Dropbox (Personal)",
        ".config",
        "Documents",
    ] {
        std::fs::create_dir_all(home.path().join(dir)).unwrap();
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(home.path().join("development"), home.path().join("linked"))
        .unwrap();
    let names = |personal| {
        project_roots(home.path(), personal)
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
    };
    // TempHome always creates Downloads.
    assert_eq!(names(false), ["IdeaProjects", "development"]);
    assert_eq!(
        names(true),
        ["Documents", "Downloads", "IdeaProjects", "development"]
    );
}

#[test]
fn script_runners_do_not_count_as_busy() {
    let comm = "  10 /usr/local/bin/node\n  11 /Users/me/.cargo/bin/cargo\n  12 /usr/local/bin/node\n  13 /opt/homebrew/bin/cargo\n  14 /Applications/Xcode.app/Contents/MacOS/Xcode\n  15 /bin/bash\n";
    let args = "  10 npm run dev\n  11 cargo run --no-default-features\n  12 npm install\n  13 cargo build\n  14 /Applications/Xcode.app/Contents/MacOS/Xcode\n  15 /bin/bash /opt/homebrew/Library/Homebrew/brew.sh update\n";
    let names = names_from_ps(comm, args);
    assert!(names.contains("npm"), "npm install is busy");
    assert!(names.contains("cargo"), "cargo build is busy");
    assert!(names.contains("Xcode"));
    assert!(names.contains("brew.sh"));
    let only_scripts = names_from_ps(
        "  10 /usr/local/bin/node\n  11 /Users/me/.cargo/bin/cargo\n",
        "  10 npm run dev\n  11 cargo run\n",
    );
    assert!(!only_scripts.contains("npm") && !only_scripts.contains("cargo"));
}

/// A Trash stand-in that behaves like Finder: it moves paths in order
/// and stops with an error at the first refused one.
fn finder_like<'a>(
    home: &'a TempHome,
    refuse: &'static str,
) -> impl Fn(&[String]) -> Result<(), CommandError> + 'a {
    move |paths: &[String]| {
        let bin = home.path().join(".Trash");
        std::fs::create_dir_all(&bin).unwrap();
        for path in paths {
            if path.ends_with(refuse) {
                return Err(CommandError::io("Finder got an error: refused."));
            }
            let name = uuid::Uuid::new_v4().to_string();
            std::fs::rename(path, bin.join(name)).unwrap();
        }
        Ok(())
    }
}

fn entry(home: &TempHome, name: &str) -> CleanPlanEntry {
    let path = home.write(&format!("junk/{name}/file"), 10);
    CleanPlanEntry {
        id: name.to_string(),
        paths: vec![path.parent().unwrap().to_path_buf()],
        bytes: 10,
    }
}

#[test]
fn a_partly_failed_trash_reports_exactly_what_moved() {
    let home = TempHome::new("partial-trash");
    let plan: Vec<CleanPlanEntry> = ["a", "b", "refused", "c", "d"]
        .into_iter()
        .map(|name| entry(&home, name))
        .collect();

    let (moved, failed) = trash_entries(plan, finder_like(&home, "refused"));
    let mut moved: Vec<String> = moved.into_iter().map(|entry| entry.id).collect();
    moved.sort();
    assert_eq!(
        moved,
        ["a", "b", "c", "d"],
        "everything but the refused item"
    );
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].id, "refused");
    assert!(failed[0].message.contains("refused"));
    assert!(home.path().join("junk/refused").exists());
}

#[test]
fn a_trash_that_moves_nothing_reports_nothing_moved() {
    let home = TempHome::new("dead-trash");
    let plan: Vec<CleanPlanEntry> = ["a", "b", "c"]
        .into_iter()
        .map(|n| entry(&home, n))
        .collect();
    let (moved, failed) = trash_entries(plan, |_: &[String]| {
        Err(CommandError::io("Finder is not running"))
    });
    assert!(moved.is_empty());
    assert_eq!(failed.len(), 3, "each entry is reported once");
}

#[test]
fn an_unverified_recheck_is_refused_not_trashed() {
    let home = TempHome::new("deadline");
    home.write("Library/Caches/Homebrew/bottle", 10);
    home.write("Code/app/package.json", 2);
    let file = home.write("Code/app/node_modules/pkg/index.js", 10);
    age(&file, OLD);
    let fixture = Fixture::new();
    let mut env = fixture.env(&home);
    env.deadline = Some(Instant::now() - Duration::from_secs(1));
    let ids = vec![
        "homebrew-cache".to_string(),
        format!(
            "projects:{}",
            home.path().join("Code/app/node_modules").to_string_lossy()
        ),
    ];
    let (plan, failed) = plan_clean(&env, &ids, &HashSet::new());
    assert!(plan.is_empty());
    assert!(failed
        .iter()
        .all(|failure| failure.message.contains("Ran out of time")));
}

#[cfg(unix)]
#[test]
fn a_denied_parent_folder_makes_the_category_partial() {
    use std::os::unix::fs::PermissionsExt;
    let home = TempHome::new("denied-parent");
    home.write("Library/Caches/Homebrew/bottle", 10);
    let caches = home.path().join("Library/Caches");
    std::fs::set_permissions(&caches, std::fs::Permissions::from_mode(0o000)).unwrap();
    let fixture = Fixture::new();
    let report = scan(&fixture.env(&home), JunkCategory::Packages);
    std::fs::set_permissions(&caches, std::fs::Permissions::from_mode(0o755)).unwrap();
    if report.status == ScanStatus::Complete && report.items.len() == 1 {
        return; // running as root: permissions are not enforced
    }
    assert_eq!(report.status, ScanStatus::Partial);
    assert!(report.items.is_empty());
}

#[test]
fn rows_covering_several_folders_list_them_and_caps_are_announced() {
    let home = TempHome::new("multi");
    home.write("Library/Developer/Xcode/iOS DeviceSupport/17/a", 10);
    home.write("Library/Developer/Xcode/watchOS DeviceSupport/10/a", 10);
    let fixture = Fixture::new();
    let report = scan(&fixture.env(&home), JunkCategory::Xcode);
    let support = report
        .items
        .iter()
        .find(|item| item.id == "xcode-device-support")
        .unwrap();
    assert_eq!(support.extra_paths.len(), 1);
    assert!(support.extra_paths[0].contains("watchOS"));

    let mut out = Collector::default();
    let mut items: Vec<JunkItem> = (0..5).map(|_| support.clone()).collect();
    cap(&mut items, 3, &mut out);
    assert_eq!(items.len(), 3);
    assert!(out.note.unwrap().contains("3 largest of 5"));
}

#[test]
fn a_top_level_key_file_protects_an_artifact() {
    let home = TempHome::new("pem");
    home.write("Code/api/package.json", 2);
    let key = home.write("Code/api/.venv/server.pem", 10);
    home.write("Code/api/requirements.txt", 2);
    let cfg = home.write("Code/api/.venv/pyvenv.cfg", 2);
    home.write("Code/web/package.json", 2);
    let fixture_pem = home.write("Code/web/node_modules/tls/test/cert.pem", 10);
    for path in [&key, &cfg, &fixture_pem] {
        age(path, OLD);
    }
    let fixture = Fixture::new();
    let report = scan(&fixture.env(&home), JunkCategory::Projects);
    let labels: Vec<&str> = report
        .items
        .iter()
        .map(|item| item.label.as_str())
        .collect();
    assert_eq!(
        labels,
        ["web/node_modules"],
        "a deep test certificate is fine"
    );
    assert_eq!(report.skips[0].reason, SkipReason::Sensitive);
}

#[test]
fn only_known_shapes_can_be_marked_never_clean() {
    assert!(is_ignorable_id("xcode-derived-data"));
    assert!(is_ignorable_id("projects:/Users/me/Code/app/node_modules"));
    assert!(is_ignorable_id("downloads:/Users/me/Downloads/a.dmg"));
    assert!(!is_ignorable_id("projects:relative/node_modules"));
    assert!(!is_ignorable_id("other:/x"));
    assert!(!is_ignorable_id("xcode-derived-data-typo"));
    assert!(!is_ignorable_id("projects:/x\n/y"));
}

#[tokio::test]
async fn history_and_ignore_tables_round_trip() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    for _ in 0..(HISTORY_LIMIT + 3) {
        record_run(
            &pool,
            &JunkCleanResult {
                removed_items: 2,
                moved_bytes: 10,
                failed: vec![],
            },
        )
        .await
        .unwrap();
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cleanup_runs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, HISTORY_LIMIT);
    assert!(ignored_ids(&pool).await.unwrap().is_empty());
    let footprint = library_footprint(&pool).await.unwrap();
    assert_eq!(footprint.total_items, 0);
}
