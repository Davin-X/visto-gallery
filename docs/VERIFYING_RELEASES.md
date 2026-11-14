# Verifying a release

Every release attaches three things next to the `.dmg`:

| File | What it proves |
|---|---|
| `VistoGallery_<version>_aarch64.dmg` | the build itself |
| `SHA256SUMS.txt` | the download arrived unmodified |
| `VistoGallery_<version>_aarch64.dmg.asc` | the DMG was signed with the project's GPG key |
| the GitHub provenance attestation | the DMG was built by this repository's release workflow, from that tag, not on someone else's machine |

The tag and the commits behind it are GPG-signed, so GitHub shows them as **Verified**.

## 1. Checksum

```bash
shasum -a 256 -c SHA256SUMS.txt
```

`VistoGallery_0.4.0_aarch64.dmg: OK` means the file matches what was published.

## 2. GPG signature

Import the release key once:

```bash
gpg --recv-keys 08927A313C150351DBC5BF647B53E554392899D0
```

Then:

```bash
gpg --verify VistoGallery_0.4.0_aarch64.dmg.asc VistoGallery_0.4.0_aarch64.dmg
```

The expected key is `Devendra Kumar <davink.in1@gmail.com>`, fingerprint:

```
08927A313C150351DBC5BF647B53E554392899D0
```

A signature made by any other key is not ours, whatever the filename says.

## 3. Build provenance

With the [GitHub CLI](https://cli.github.com) installed:

```bash
gh attestation verify VistoGallery_0.4.0_aarch64.dmg --repo Davin-X/visto-gallery
```

This checks the attestation the release workflow produced: the artifact came from a run of `.github/workflows/release.yml` on a tag in this repository.

## 4. macOS Gatekeeper

`spctl` answers a different question — whether Apple has checked the app — and it is honest about the current state:

```bash
spctl -a -vvv -t install /Applications/VistoGallery.app
```

VistoGallery ships without an Apple Developer ID certificate, so Gatekeeper refuses it on first launch and the app must be opened with **right-click → Open** (or `xattr -dr com.apple.quarantine`, see the README). That is the macOS trust chain, and checksums, GPG signatures and attestations do not substitute for it: they prove *what* you downloaded, not that Apple has reviewed it. Once a Developer ID certificate is enrolled, the DMG is signed and notarized in the same workflow and this section will say *accepted, source=Notarized Developer ID*.

## What each layer does not cover

- **Checksums** are only as trustworthy as the page you got them from. Compare against the release page, not a mirror.
- **The GPG key** proves authorship of the artifact, not that the code is safe. Read the source if that matters.
- **Provenance** proves the build was reproducible-by-workflow, not that the workflow was trustworthy at that moment — for that, check the workflow file at the tag.
