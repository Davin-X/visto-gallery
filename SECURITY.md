# Security Policy

## Supported versions

Security fixes go into the latest release only.

| Version | Supported |
|---------|-----------|
| 0.3.x   | ✅        |
| < 0.3   | ❌        |

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/Davin-X/visto-gallery/security/advisories/new)). Include what you found, steps to reproduce, the version and macOS version, and a suggested fix if you have one.

We aim to acknowledge reports within 7 days and to share an initial assessment within 14 days. We follow coordinated disclosure: details stay private until a fix is released or a reasonable time has passed.

## Security model

VistoGallery runs entirely on your Mac. The things it protects are your files and its catalog, and the main boundary is between the app's web-based interface and its Rust backend.

- **No network by default.** No telemetry, analytics or remote code. The only request the app can make is the optional update check against GitHub Releases, which is off unless you turn it on.
- **You choose what it reads.** The backend only scans or imports folders and files you picked in a macOS dialog, dropped on the window, or added as a source earlier.
- **Catalog-only file actions.** Opening, revealing and trashing only work on files that are in the catalog. Trash takes catalog ids, never paths.
- **Backend-owned save dialogs.** When the app writes a file you exported, the Rust backend shows the save dialog and picks the destination.
- **Recoverable deletes.** Deleted files go to the macOS Trash (with Put Back where Finder allows). Removing a source or resetting the catalog never deletes your files.
- **Originals kept on edit.** Replacing a file with an edited version first stores the original in the app's data folder so it can be restored.
- **Locked-down web view.** A strict Content Security Policy, no developer tools in release builds, and an asset scope limited to the thumbnail cache and your sources.

Data lives in `~/Library/Application Support/com.vistogallery.desktop/` (catalog, edit originals, backups) and `~/Library/Caches/com.vistogallery.desktop/` (thumbnails).

## Known limitations

- Release builds are not yet signed or notarized by Apple.
- Hidden items are hidden in the app only. They are not encrypted, and the files stay readable on disk.
