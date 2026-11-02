# Vendored `wry` (patch for macOS 27)

This directory is a copy of `wry 0.57.0` (the version locked by `Cargo.lock`) with
a single behavioural change, wired in through `[patch.crates-io]` in
`src-tauri/Cargo.toml`.

## Why

On macOS 27, WKWebView kills its web content process (`EXC_BREAKPOINT` in
`WebCore::SharedBuffer::SharedBuffer`, during
`Messages::WebPage::URLSchemeTaskDidReceiveData`) while it decodes a custom
protocol response whose body was handed to `NSData` without copying. Tauri uses
custom protocol responses for both app assets (`tauri://localhost`) and IPC
(`ipc://localhost`), so the app either went blank on launch or died after the
first large response (thumbnails, image previews).

Upstream wry added the no-copy fast path in 0.56.0
(`5bdda32`, "avoid an extra copy for owned custom protocol response bodies"),
which is what triggers the crash on macOS 27.

## What changed

`src/wkwebview/class/url_scheme_handler.rs`:

```diff
-              let data = match sent_response.into_body() {
-                Cow::Owned(content) => NSData::from_vec(content),
-                Cow::Borrowed(content) => NSData::with_bytes(content),
-              };
+              let body = sent_response.into_body();
+              let data = NSData::with_bytes(body.as_ref());
```

The body is always copied into `NSData`, which is what wry did before 0.56.0.

## Removing this

Drop the `[patch.crates-io]` entry and this directory once a `wry` release no
longer crashes on macOS 27 with the no-copy path (check the wry changelog for
macOS custom protocol fixes before upgrading).
