use super::*;

fn parse_rules(json: &str) -> CleanupRules {
    serde_json::from_str(json).expect("test rules parse")
}

/// The names the fence must keep: as often source or release output as a
/// build cache. The shipped file carries all nine, checked below.
const AMBIGUOUS: &str = r#""dist","build","bin","obj","out","vendor","coverage","lib","src""#;

fn one_static(target: &str) -> String {
    format!(
        r#"{{"static":[{{"key":"k","category":"packages","label":"L","detail":"D","tier":"regenerable","targets":["{target}"],"busyIf":[]}}],"artifacts":[],"ambiguousArtifacts":[{AMBIGUOUS}]}}"#
    )
}

fn one_artifact(name: &str, manifest: &str) -> String {
    format!(
        r#"{{"static":[],"artifacts":[{{"name":"{name}","manifests":["{manifest}"],"marker":null,"tool":"T","recover":"R","busyIf":[]}}],"ambiguousArtifacts":[{AMBIGUOUS}]}}"#
    )
}

#[test]
fn shipped_rules_load_and_validate() {
    let rules = rules();
    assert_eq!(rules.static_junk.len(), 21);
    assert_eq!(rules.artifacts.len(), 20);
    let keys: Vec<&str> = rules.static_junk.iter().map(|d| d.key.as_str()).collect();
    // Keys are stored by Clean and Never clean; these must keep working.
    for key in [
        "xcode-derived-data",
        "npm-cache",
        "homebrew-cache",
        "maven-repository",
    ] {
        assert!(keys.contains(&key), "missing {key}");
    }
    let venv = artifact_named("venv").expect("venv rule");
    assert_eq!(venv.marker.as_deref(), Some("pyvenv.cfg"));
    assert!(artifact_named("dist").is_none());
}

#[test]
fn a_valid_rule_passes() {
    assert!(validate_rules(&parse_rules(&one_static("Library/Caches/foo"))).is_ok());
    assert!(validate_rules(&parse_rules(&one_static(".cache/foo"))).is_ok());
    assert!(validate_rules(&parse_rules(&one_static(".pnpm-store"))).is_ok());
    assert!(validate_rules(&parse_rules(&one_artifact("target", "Cargo.toml"))).is_ok());
}

#[test]
fn rules_that_reach_outside_a_cache_are_rejected() {
    for target in [
        "",
        "/Library/Caches/foo",
        "Library/Caches/../../Documents",
        ".cache",
        ".cargo",
        "Projects",
        ".ssh/old_keys",
        "Documents/old",
        "Pictures/Photos Library.photoslibrary",
        "Library/Mail/V10",
        "Library/Mobile Documents/x",
        "Library/Caches",
        "Library/Caches//x",
        "Library/Caches/*",
    ] {
        let rules = parse_rules(&one_static(target));
        assert!(validate_rules(&rules).is_err(), "{target:?} was accepted");
    }
}

#[test]
fn ambiguous_or_nested_artifacts_are_rejected() {
    for name in ["dist", "Build", "vendor", "bin", "a/b", "..", ""] {
        let rules = parse_rules(&one_artifact(name, "package.json"));
        assert!(validate_rules(&rules).is_err(), "{name:?} was accepted");
    }
    let rules = parse_rules(&one_artifact("target", "../Cargo.toml"));
    assert!(validate_rules(&rules).is_err());
}

#[test]
fn duplicate_keys_and_bad_categories_are_rejected() {
    let rule = r#"{"key":"k","category":"packages","label":"L","detail":"D","tier":"regenerable","targets":[".cache/x"],"busyIf":[]}"#;
    let twice = parse_rules(&format!(
        r#"{{"static":[{rule},{rule}],"artifacts":[],"ambiguousArtifacts":[{AMBIGUOUS}]}}"#
    ));
    assert!(validate_rules(&twice).unwrap_err().contains("duplicate"));
    let projects = parse_rules(&one_static(".cache/x").replace("packages", "projects"));
    assert!(validate_rules(&projects).is_err());
    let bad_key = parse_rules(&one_static(".cache/x").replace(r#""key":"k""#, r#""key":"K k""#));
    assert!(validate_rules(&bad_key).is_err());
}

/// The fence used to be a Rust `const`. Now that it is data, this is what
/// stops a JSON-only edit from quietly unfencing `src` or `vendor`.
#[test]
fn the_shipped_fence_covers_every_ambiguous_name() {
    let shipped: Vec<String> = rules()
        .ambiguous_artifacts
        .iter()
        .map(|name| name.to_ascii_lowercase())
        .collect();
    for name in [
        "dist", "build", "bin", "obj", "out", "vendor", "coverage", "lib", "src",
    ] {
        assert!(
            shipped.contains(&name.to_string()),
            "{name:?} is no longer fenced"
        );
    }
}

#[test]
fn the_fence_itself_must_be_plain_and_unique() {
    for list in [r#""a/b""#, r#""""#, r#""*""#, r#""dup","dup""#] {
        let json = format!(r#"{{"static":[],"artifacts":[],"ambiguousArtifacts":[{list}]}}"#);
        assert!(
            validate_rules(&parse_rules(&json)).is_err(),
            "{list} was accepted"
        );
    }
}

#[test]
fn unknown_fields_do_not_parse() {
    let json = one_static(".cache/x").replace(r#""busyIf":[]"#, r#""busyIf":[],"recursive":true"#);
    assert!(serde_json::from_str::<CleanupRules>(&json).is_err());
}
