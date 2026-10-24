# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |

## Reporting a Vulnerability

VistoGallery is designed to be **local-first** — it makes no network requests by default and stores all data in a local SQLite database on your Mac. Because of this, the attack surface is intentionally small.

If you discover a security issue (for example, in the Vault encryption, SQLite handling, or Tauri command surface), please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities.
2. Email the maintainer with details, steps to reproduce, and (if available) a suggested fix.
3. We will acknowledge receipt within 7 business days and provide an initial assessment within 14 business days.

## Security Design

- **Local-first:** No telemetry, no analytics, no remote code loading
- **Vault:** Password-protected items; planned native backing via macOS Secure Enclave / Keychain
- **SQLite:** Single-file catalog with WAL mode; migrations run at startup
- **Tauri commands:** Explicit allow-list; no arbitrary shell execution exposed to the frontend
- **File access:** Only folders you explicitly grant via the native file picker

## Disclosure Policy

We follow coordinated disclosure. We will not publicize a vulnerability until a fix is available or a reasonable remediation period has passed.
