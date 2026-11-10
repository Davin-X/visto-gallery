//! Typed IPC errors.
//!
//! Commands return [`CommandError`], which serializes as `{ code, message }`.
//! The frontend branches on `code`; `message` is display copy and may change
//! without altering behavior. Codes are stable identifiers, so adding a new
//! failure class means adding a variant here and handling it in the UI.

use serde::Serialize;
use ts_rs::TS;

/// Stable, machine-readable failure classes.
///
/// Ordering and spelling matter: the frontend switches on these strings, and
/// they cross the IPC boundary as camelCase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// The catalog could not be opened (locked, damaged, or still starting).
    CatalogUnavailable,
    /// SQLite rejected a query or migration.
    Database,
    /// A file system operation failed.
    Io,
    /// A path was outside the folders the user granted.
    PathNotAllowed,
    /// The requested item, folder, album, or recipe does not exist.
    NotFound,
    /// A library source is missing from disk (unmounted or deleted).
    MissingSource,
    /// A folder or selection contained no supported media.
    NoMediaFiles,
    /// The media type or output format is not supported.
    UnsupportedFormat,
    /// A request failed validation.
    InvalidInput,
    /// A native dialog or picker failed.
    Dialog,
    /// A network request failed.
    Network,
    /// The user dismissed a picker or cancelled the operation.
    Cancelled,
    /// A payload could not be encoded or decoded.
    Serialization,
    /// Anything without a more specific class.
    Internal,
}

/// A command failure with a stable code and a user-facing message.
///
/// `message` always matches what the previous `Result<_, String>` commands
/// returned, so existing copy and tests keep working.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct CommandError {
    pub code: ErrorCode,
    pub message: String,
}

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn database(error: impl std::fmt::Display) -> Self {
        Self::new(ErrorCode::Database, error.to_string())
    }

    pub fn io(error: impl std::fmt::Display) -> Self {
        Self::new(ErrorCode::Io, error.to_string())
    }

    pub fn path(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PathNotAllowed, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn catalog_unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::CatalogUnavailable, message)
    }
}

impl From<String> for CommandError {
    /// Helper functions still produce plain strings; they keep their text and
    /// land in the catch-all class until they are given a specific code.
    fn from(message: String) -> Self {
        Self::internal(message)
    }
}

impl From<&str> for CommandError {
    fn from(message: &str) -> Self {
        Self::internal(message)
    }
}

impl From<sqlx::Error> for CommandError {
    fn from(error: sqlx::Error) -> Self {
        Self::database(error)
    }
}

impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        Self::io(error)
    }
}

impl From<serde_json::Error> for CommandError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(ErrorCode::Serialization, error.to_string())
    }
}

impl From<anyhow::Error> for CommandError {
    /// The top-level context only; the alternate `{error:#}` form appends the
    /// whole source chain, which reads badly in a toast.
    fn from(error: anyhow::Error) -> Self {
        Self::internal(error.to_string())
    }
}

impl From<tauri::Error> for CommandError {
    fn from(error: tauri::Error) -> Self {
        Self::new(ErrorCode::Internal, error.to_string())
    }
}

impl<T> From<std::sync::PoisonError<T>> for CommandError {
    fn from(error: std::sync::PoisonError<T>) -> Self {
        Self::internal(error.to_string())
    }
}

impl From<tokio::task::JoinError> for CommandError {
    fn from(error: tokio::task::JoinError) -> Self {
        Self::internal(error.to_string())
    }
}

impl From<image::ImageError> for CommandError {
    fn from(error: image::ImageError) -> Self {
        Self::new(ErrorCode::UnsupportedFormat, error.to_string())
    }
}

impl From<trash::Error> for CommandError {
    fn from(error: trash::Error) -> Self {
        Self::io(error)
    }
}

impl From<plist::Error> for CommandError {
    fn from(error: plist::Error) -> Self {
        Self::new(ErrorCode::Serialization, error.to_string())
    }
}

impl From<notify::Error> for CommandError {
    fn from(error: notify::Error) -> Self {
        Self::io(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_and_message() {
        let error = CommandError::database("database is locked");
        let json = serde_json::to_value(&error).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({ "code": "database", "message": "database is locked" })
        );
    }

    #[test]
    fn display_is_the_message_only() {
        let error = CommandError::path("That folder is not part of the library.");
        assert_eq!(error.to_string(), "That folder is not part of the library.");
    }

    #[test]
    fn source_errors_keep_their_class() {
        let database: CommandError = sqlx::Error::RowNotFound.into();
        assert_eq!(database.code, ErrorCode::Database);

        let io: CommandError = std::io::Error::new(std::io::ErrorKind::NotFound, "gone").into();
        assert_eq!(io.code, ErrorCode::Io);

        let serialization: CommandError = serde_json::from_str::<serde_json::Value>("{")
            .unwrap_err()
            .into();
        assert_eq!(serialization.code, ErrorCode::Serialization);

        let join: CommandError = tokio::runtime::Runtime::new().unwrap().block_on(async {
            tokio::spawn(async { panic!("boom") })
                .await
                .unwrap_err()
                .into()
        });
        assert_eq!(join.code, ErrorCode::Internal);
    }

    #[test]
    fn dialogue_and_network_codes_are_stable() {
        let cancelled = CommandError::new(ErrorCode::Cancelled, "Export cancelled by user");
        let json = serde_json::to_value(&cancelled).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({ "code": "cancelled", "message": "Export cancelled by user" })
        );

        let network = CommandError::new(ErrorCode::Network, "Could not reach GitHub");
        let json = serde_json::to_value(&network).expect("serialize");
        assert_eq!(json["code"], "network");

        let missing = CommandError::new(ErrorCode::MissingSource, "The source is gone");
        assert_eq!(
            serde_json::to_value(&missing).unwrap()["code"],
            "missingSource"
        );
    }

    #[test]
    fn error_codes_are_camel_case() {
        let json = serde_json::to_value(ErrorCode::PathNotAllowed).expect("serialize");
        assert_eq!(json, serde_json::json!("pathNotAllowed"));
    }
}
