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

## Scope

In scope, for the desktop app and the catalog it maintains:

- The boundary between the web-based interface and the Rust backend: commands that should refuse untrusted paths from the webview but do not.
- Bypasses of the rules that limit reading, importing, opening, revealing or trashing to files the user picked, dropped or already registered as a source.
- Catalog corruption or data loss caused by a malicious file, a crafted catalog backup, or a symlink or hard link.
- Escapes of the Content Security Policy, or ways to make the app run remote code.
- Path traversal, unsafe deserialization, or SQL injection in the catalog layer.

Out of scope:

- Gatekeeper or "unidentified developer" warnings on the unsigned build. See [Install](./README.md#install); signing and notarization are known work.
- Anything that requires an attacker to already have full control of your macOS account, your Administrator password, or physical access to an unlocked Mac.
- The fact that Hidden items are not encrypted. That is documented behaviour, not a vulnerability.
- Vulnerabilities in third-party dependencies, unless this project ships a vulnerable version and the issue is reachable through VistoGallery. Report those upstream; Dependabot and `cargo audit` track them here.
- Denial of service against your own machine, or findings from automated scanners with no demonstrated impact.

## Safe harbour

We will not pursue or support legal action against researchers who look for issues in good faith and follow this policy. That means: only testing against your own installation and your own files, not accessing anyone else's data, not disrupting the service, not publicly disclosing before a fix ships, and giving us reasonable time to respond.

## What we don't offer

There is no bug bounty or payment for reports. Credit in the release notes and the security advisory is offered where the reporter wants it.

## Security model

VistoGallery runs entirely on your Mac. The things it protects are your files and its catalog, and the main boundary is between the app's web-based interface and its Rust backend.

- **No network by default.** No telemetry, analytics or remote code. The only request the app can make is the optional update check against GitHub Releases, which is off unless you turn it on.
- **You choose what it reads.** The backend only scans or imports folders and files you picked in a macOS dialog, dropped on the window, or added as a source earlier.
- **Catalog-only file actions.** Opening, revealing and trashing only work on files that are in the catalog. Trash takes catalog ids, never paths.
- **Backend-owned dialogs.** When the app writes a file — an export, a catalog backup, an edited original — the Rust backend shows the dialog and records the destination; the webview cannot name an arbitrary output path.
- **Recoverable deletes.** Deleted files go to the macOS Trash (with Put Back where Finder allows). Removing a source or resetting the catalog never deletes your files.
- **Originals kept on edit.** Replacing a file with an edited version first stores the original in the app's data folder so it can be restored.
- **Locked-down web view.** A strict Content Security Policy, no developer tools in release builds, and an asset scope limited to the thumbnail cache and your sources. Removed or remapped sources are revoked when the change happens, and a restored catalog cannot widen the scope beyond real folders under your home folder or a mounted volume.

Data lives in `~/Library/Application Support/com.vistogallery.desktop/` (catalog, edit originals, backups) and `~/Library/Caches/com.vistogallery.desktop/` (thumbnails).

## Known limitations

- Release builds are not yet signed or notarized by Apple.
- Hidden items are hidden in the app only. They are not encrypted, and the files stay readable on disk.
