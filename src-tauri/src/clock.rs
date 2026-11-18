//! Wall-clock timestamps for the catalog.
//!
//! The database stores Unix milliseconds. This module keeps the format in one
//! place, so call sites do not each grow their own date crate. `time` is
//! already in the dependency graph through sqlx's `time` feature, which is why
//! it replaces `chrono` here instead of adding anything new.

use time::OffsetDateTime;

/// Milliseconds since the Unix epoch, as stored in the catalog.
pub(crate) fn now_millis() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

#[cfg(test)]
mod tests {
    use super::now_millis;

    #[test]
    fn now_millis_is_a_plausible_epoch_millis_value() {
        // 2020-01-01 .. 2200-01-01, wide enough to catch seconds-vs-millis
        // mistakes without pinning the test to a clock.
        let now = now_millis();
        assert!(now > 1_577_836_800_000, "{now} is before 2020");
        assert!(now < 7_258_118_400_000, "{now} is after 2200");
    }
}
