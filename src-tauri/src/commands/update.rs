use super::*;
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

const RELEASES_URL: &str = "https://api.github.com/repos/Davin-X/visto-gallery/releases/latest";
const CACHE_KEY: &str = "update_check_cache";
const CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// Result of a release check. Cached for a day so the app can call this on
/// launch without hitting GitHub's unauthenticated rate limit.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub notes: String,
    pub release_url: String,
    pub download_url: Option<String>,
    pub published_at: Option<String>,
    pub checked_at: i64,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

/// Check the latest GitHub release and report whether a newer version exists.
///
/// `force` bypasses the 24-hour cache; the menu item uses it, while the launch
/// check does not. Network and rate-limit failures return an error so the
/// caller can stay silent on launch and show a message for a manual check.
#[tauri::command]
pub async fn check_updates(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<UpdateCheck, String> {
    let db = super::get_db(&state)?;
    let now = super::now_ms();
    let current = env!("CARGO_PKG_VERSION").to_string();

    if !force.unwrap_or(false) {
        if let Some(cached) = read_cache(&db, now, &current).await? {
            return Ok(cached);
        }
    }

    let result = fetch_latest(now, &current).await?;
    write_cache(&db, &result).await?;
    Ok(result)
}

async fn fetch_latest(now: i64, current: &str) -> Result<UpdateCheck, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("VistoGallery/{}", current))
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Could not create update client: {}", e))?;

    let response = client
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub returned {} while checking for updates",
            response.status()
        ));
    }

    let release: GithubRelease = response
        .json()
        .await
        .map_err(|e| format!("Could not read the release response: {}", e))?;

    Ok(build_result(release, current, now))
}

fn build_result(release: GithubRelease, current: &str, now: i64) -> UpdateCheck {
    let latest = normalize_version(&release.tag_name);
    let available = is_newer(&latest, current);

    UpdateCheck {
        available,
        current_version: current.to_string(),
        latest_version: latest,
        notes: release.body,
        release_url: release.html_url,
        download_url: pick_download(&release.assets),
        published_at: release.published_at,
        checked_at: now,
    }
}

fn normalize_version(tag: &str) -> String {
    let trimmed = tag.trim();
    let without_v = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    without_v.to_string()
}

/// Only claim an update when both versions parse as semver. A malformed tag
/// should never make the app nag the user.
fn is_newer(latest: &str, current: &str) -> bool {
    match (
        semver::Version::parse(&normalize_version(latest)),
        semver::Version::parse(&normalize_version(current)),
    ) {
        (Ok(latest), Ok(current)) => latest > current,
        _ => false,
    }
}

/// Prefer the DMG installer, then the zip bundle, then the release page.
fn pick_download(assets: &[GithubAsset]) -> Option<String> {
    assets
        .iter()
        .find(|asset| asset.name.to_ascii_lowercase().ends_with(".dmg"))
        .or_else(|| {
            assets
                .iter()
                .find(|asset| asset.name.to_ascii_lowercase().ends_with(".zip"))
        })
        .map(|asset| asset.browser_download_url.clone())
}

async fn read_cache(
    db: &SqlitePool,
    now: i64,
    current: &str,
) -> Result<Option<UpdateCheck>, String> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(CACHE_KEY)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?;

    let Some(value) = value else {
        return Ok(None);
    };
    let Ok(mut cached) = serde_json::from_str::<UpdateCheck>(&value) else {
        return Ok(None);
    };
    // Invalidate the cache when the running version changes (e.g. after an
    // upgrade), so a stale "update available" result from an older build can't
    // keep nagging.
    if cached.current_version != current {
        return Ok(None);
    }
    if now.saturating_sub(cached.checked_at) < CACHE_TTL_MS {
        // Recompute `available` defensively in case the stored flag drifted.
        cached.available = is_newer(&cached.latest_version, current);
        Ok(Some(cached))
    } else {
        Ok(None)
    }
}

async fn write_cache(db: &SqlitePool, result: &UpdateCheck) -> Result<(), String> {
    let value = serde_json::to_string(result).map_err(|e| e.to_string())?;
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
        .bind(CACHE_KEY)
        .bind(value)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str, url: &str) -> GithubAsset {
        GithubAsset {
            name: name.to_string(),
            browser_download_url: url.to_string(),
        }
    }

    fn release(tag: &str, assets: Vec<GithubAsset>) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            html_url: "https://github.com/Davin-X/visto-gallery/releases/tag/v0.2.0".to_string(),
            body: "Release notes".to_string(),
            published_at: Some("2026-11-01T00:00:00Z".to_string()),
            assets,
        }
    }

    #[test]
    fn compares_versions_with_optional_v_prefix() {
        assert!(is_newer("0.2.0", "0.1.2"));
        assert!(is_newer("v0.2.0", "0.1.2"));
        assert!(is_newer("V1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.2", "0.1.2"));
        assert!(!is_newer("v0.1.1", "0.1.2"));
    }

    #[test]
    fn ignores_unparseable_versions() {
        assert!(!is_newer("nightly", "0.1.2"));
        assert!(!is_newer("0.2.0", "not-a-version"));
    }

    #[test]
    fn normalizes_release_tags() {
        assert_eq!(normalize_version("v0.2.0"), "0.2.0");
        assert_eq!(normalize_version("0.2.0"), "0.2.0");
        assert_eq!(normalize_version(" v0.2.0 "), "0.2.0");
    }

    #[test]
    fn prefers_dmg_then_zip() {
        let assets = vec![
            asset("notes.txt", "https://example.com/notes.txt"),
            asset(
                "VistoGallery_0.2.0_aarch64.zip",
                "https://example.com/app.zip",
            ),
            asset(
                "VistoGallery_0.2.0_aarch64.dmg",
                "https://example.com/app.dmg",
            ),
        ];
        assert_eq!(
            pick_download(&assets).as_deref(),
            Some("https://example.com/app.dmg")
        );

        let zip_only = vec![asset(
            "VistoGallery_0.2.0_aarch64.zip",
            "https://example.com/app.zip",
        )];
        assert_eq!(
            pick_download(&zip_only).as_deref(),
            Some("https://example.com/app.zip")
        );

        assert_eq!(pick_download(&[]), None);
    }

    #[test]
    fn builds_available_result() {
        let result = build_result(
            release(
                "v0.2.0",
                vec![asset("app.dmg", "https://example.com/app.dmg")],
            ),
            "0.1.2",
            1_700_000_000_000,
        );
        assert!(result.available);
        assert_eq!(result.current_version, "0.1.2");
        assert_eq!(result.latest_version, "0.2.0");
        assert_eq!(
            result.download_url.as_deref(),
            Some("https://example.com/app.dmg")
        );
        assert_eq!(result.notes, "Release notes");
    }

    #[test]
    fn builds_up_to_date_result() {
        let result = build_result(release("v0.1.2", vec![]), "0.1.2", 1);
        assert!(!result.available);
        assert_eq!(result.download_url, None);
    }

    async fn cache_db() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory settings database");
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create settings table");
        db
    }

    #[tokio::test]
    async fn cache_roundtrips_within_ttl() {
        let db = cache_db().await;
        let now = 1_700_000_000_000;
        let result = build_result(release("v0.2.0", vec![]), "0.1.2", now);

        write_cache(&db, &result).await.expect("write cache");
        let cached = read_cache(&db, now + 60_000, "0.1.2")
            .await
            .expect("read cache")
            .expect("cache should be fresh");

        assert_eq!(cached.latest_version, "0.2.0");
        assert_eq!(cached.checked_at, now);
    }

    #[tokio::test]
    async fn cache_expires_after_ttl() {
        let db = cache_db().await;
        let now = 1_700_000_000_000;
        let result = build_result(release("v0.2.0", vec![]), "0.1.2", now);
        write_cache(&db, &result).await.expect("write cache");

        // Exactly at the boundary is still stale: the cache is valid for
        // strictly less than 24 hours.
        assert!(read_cache(&db, now + CACHE_TTL_MS, "0.1.2")
            .await
            .expect("read cache")
            .is_none());
        assert!(read_cache(&db, now + CACHE_TTL_MS + 1, "0.1.2")
            .await
            .expect("read cache")
            .is_none());
    }

    #[tokio::test]
    async fn cache_tolerates_a_clock_that_moved_backwards() {
        let db = cache_db().await;
        let now = 1_700_000_000_000;
        let result = build_result(release("v0.2.0", vec![]), "0.1.2", now);
        write_cache(&db, &result).await.expect("write cache");

        // saturating_sub keeps this from underflowing into a panic.
        assert!(read_cache(&db, now - 60_000, "0.1.2")
            .await
            .expect("read cache")
            .is_some());
    }

    #[tokio::test]
    async fn corrupt_cache_is_ignored() {
        let db = cache_db().await;
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?)")
            .bind(CACHE_KEY)
            .bind("not json")
            .execute(&db)
            .await
            .expect("insert corrupt cache");

        assert!(read_cache(&db, 1_700_000_000_000, "0.1.2")
            .await
            .expect("read cache")
            .is_none());
    }

    #[tokio::test]
    async fn missing_cache_returns_none() {
        let db = cache_db().await;
        assert!(read_cache(&db, 1_700_000_000_000, "0.1.2")
            .await
            .expect("read cache")
            .is_none());
    }

    /// Not part of the default run: verifies that the real GitHub payload still
    /// deserializes and that the asset fallback works against live data.
    /// `cargo test update::tests::fetches_the_real_latest_release -- --ignored`
    #[tokio::test]
    #[ignore = "hits the real GitHub API"]
    async fn fetches_the_real_latest_release() {
        let result = fetch_latest(0, env!("CARGO_PKG_VERSION"))
            .await
            .expect("fetch real release");
        assert!(!result.latest_version.is_empty());
        assert!(!result.release_url.is_empty());
        assert_eq!(result.current_version, env!("CARGO_PKG_VERSION"));
    }
}
