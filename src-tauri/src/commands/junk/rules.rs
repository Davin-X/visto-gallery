use std::collections::HashSet;
use std::sync::LazyLock;

use serde::Deserialize;

use super::{JunkCategory, JunkTier};

/// A fixed junk location. Keys are stable ids: they are what the Clean button
/// and the Never clean list store, so renaming one is a breaking change.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StaticJunk {
    pub(super) key: String,
    pub(super) category: JunkCategory,
    pub(super) label: String,
    pub(super) detail: String,
    /// Paths relative to the user's home folder.
    pub(super) targets: Vec<String>,
    pub(super) tier: JunkTier,
    /// Process names that mean the tool is in use right now.
    pub(super) busy_if: Vec<String>,
}

/// A build artifact inside a project. It is only recognised next to one of
/// its `manifests`, and, when `marker` is set, only when that file exists
/// inside it (a `venv` without `pyvenv.cfg` is not a virtual environment).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Artifact {
    name: String,
    pub(super) manifests: Vec<String>,
    pub(super) marker: Option<String>,
    pub(super) tool: String,
    pub(super) recover: String,
    pub(super) busy_if: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupRules {
    #[serde(rename = "static")]
    static_junk: Vec<StaticJunk>,
    artifacts: Vec<Artifact>,
    #[serde(rename = "ambiguousArtifacts")]
    ambiguous_artifacts: Vec<String>,
    /// An editor-only pointer at the schema file. `deny_unknown_fields` means
    /// it has to be declared here, or the shipped JSON will not parse at all.
    #[serde(rename = "$schema", default)]
    #[allow(dead_code)]
    schema: Option<String>,
}

/// The complete allowlist: every fixed junk location and every project
/// artifact name. It is data, but it ships inside the signed binary, so it
/// cannot be changed on disk, and [`validate_rules`] rejects any rule that
/// could reach outside a tool's own cache.
const RULES_JSON: &str = include_str!("../cleanup_rules.json");

/// Top-level home folders that hold the user's own files. No fixed rule may
/// point into them.
const PERSONAL_HOME_FOLDERS: &[&str] = &[
    "Documents",
    "Desktop",
    "Downloads",
    "Pictures",
    "Movies",
    "Music",
    "Applications",
    "Public",
];

/// Home folders holding keys and credentials. No rule may point into them.
const SECRET_HOME_FOLDERS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".password-store",
    ".Trash",
];

/// Hidden home folders shared by many tools. A rule may point inside one
/// (`.cache/uv`), never at the whole folder.
const SHARED_DOT_FOLDERS: &[&str] = &[
    ".cache", ".config", ".local", ".npm", ".cargo", ".rustup", ".gradle", ".m2", ".bun",
];

/// Folders under `~/Library` a rule may point into. Everything else there
/// (Mail, Messages, Photos, Mobile Documents, Keychains…) is personal data.
const LIBRARY_ALLOWED: &[&str] = &["Caches", "Developer", "pnpm"];

fn rules() -> &'static CleanupRules {
    static RULES: LazyLock<CleanupRules> = LazyLock::new(|| {
        let rules: CleanupRules =
            serde_json::from_str(RULES_JSON).expect("cleanup_rules.json does not parse");
        if let Err(problem) = validate_rules(&rules) {
            panic!("cleanup_rules.json is invalid: {problem}");
        }
        rules
    });
    &RULES
}

pub(super) fn static_junk() -> &'static [StaticJunk] {
    &rules().static_junk
}

pub(super) fn artifact_named(name: &str) -> Option<&'static Artifact> {
    rules()
        .artifacts
        .iter()
        .find(|artifact| artifact.name == name)
}

/// A single plain file or folder name: no separators, no `.`/`..`, nothing
/// hidden in whitespace.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0', '*', '?'])
        && name.trim() == name
}

fn validate_target(key: &str, target: &str) -> Result<(), String> {
    let parts: Vec<&str> = target.split('/').collect();
    if parts.iter().any(|part| !plain_name(part)) {
        return Err(format!(
            "{key}: target {target:?} must be a relative path of plain names"
        ));
    }
    if SECRET_HOME_FOLDERS.contains(&parts[0]) {
        return Err(format!(
            "{key}: target {target:?} is inside a credentials folder"
        ));
    }
    if PERSONAL_HOME_FOLDERS.contains(&parts[0]) {
        return Err(format!(
            "{key}: target {target:?} is inside a personal folder"
        ));
    }
    if parts.len() == 1 {
        // A whole home-level folder only when it is a tool's own hidden
        // store (`~/.pnpm-store`), never a shared root many tools use.
        if !parts[0].starts_with('.') || SHARED_DOT_FOLDERS.contains(&parts[0]) {
            return Err(format!("{key}: target {target:?} is a whole home folder"));
        }
    }
    if parts[0] == "Library" {
        if parts.len() < 3 {
            return Err(format!(
                "{key}: target {target:?} is a whole Library folder"
            ));
        }
        if !LIBRARY_ALLOWED.contains(&parts[1]) {
            return Err(format!(
                "{key}: target {target:?} is outside Library/{{{}}}",
                LIBRARY_ALLOWED.join(",")
            ));
        }
    }
    Ok(())
}

/// Checks the invariants the scan and clean code relies on. A rule that
/// fails here would widen what Cleanup can move to the Trash, so the app
/// refuses to start with it (and `cargo test` catches it first).
fn validate_rules(rules: &CleanupRules) -> Result<(), String> {
    let mut keys = HashSet::new();
    for def in &rules.static_junk {
        let key_ok = !def.key.is_empty()
            && def
                .key
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !key_ok {
            return Err(format!(
                "key {:?} must be lowercase letters, digits and dashes",
                def.key
            ));
        }
        if !keys.insert(def.key.as_str()) {
            return Err(format!("duplicate key {:?}", def.key));
        }
        if !matches!(def.category, JunkCategory::Xcode | JunkCategory::Packages) {
            return Err(format!(
                "{}: fixed rules belong to xcode or packages",
                def.key
            ));
        }
        if def.label.trim().is_empty() || def.detail.trim().is_empty() {
            return Err(format!("{}: label and detail are required", def.key));
        }
        if def.targets.is_empty() {
            return Err(format!("{}: at least one target is required", def.key));
        }
        for target in &def.targets {
            validate_target(&def.key, target)?;
        }
        if def.busy_if.iter().any(|name| !plain_name(name)) {
            return Err(format!(
                "{}: busyIf entries must be plain process names",
                def.key
            ));
        }
    }

    let mut ambiguous_set = HashSet::new();
    for name in &rules.ambiguous_artifacts {
        if !plain_name(name) {
            return Err(format!(
                "ambiguous artifact {name:?} must be a plain folder name"
            ));
        }
        if !ambiguous_set.insert(name.to_ascii_lowercase()) {
            return Err(format!("duplicate ambiguous artifact {name:?}"));
        }
    }
    let mut names = HashSet::new();
    for artifact in &rules.artifacts {
        let name = artifact.name.as_str();
        if !plain_name(name) {
            return Err(format!("artifact {name:?} must be a single folder name"));
        }
        if rules
            .ambiguous_artifacts
            .contains(&name.to_ascii_lowercase())
        {
            return Err(format!("artifact {name:?} is too ambiguous to clean"));
        }
        if !names.insert(name) {
            return Err(format!("duplicate artifact {name:?}"));
        }
        if artifact.manifests.is_empty() || artifact.manifests.iter().any(|m| !plain_name(m)) {
            return Err(format!("artifact {name:?} needs plain manifest file names"));
        }
        if artifact
            .marker
            .as_deref()
            .is_some_and(|marker| !plain_name(marker))
        {
            return Err(format!(
                "artifact {name:?}: marker must be a plain file name"
            ));
        }
        if artifact.tool.trim().is_empty() || artifact.recover.trim().is_empty() {
            return Err(format!("artifact {name:?}: tool and recover are required"));
        }
        if artifact.busy_if.iter().any(|p| !plain_name(p)) {
            return Err(format!(
                "artifact {name:?}: busyIf entries must be plain process names"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
