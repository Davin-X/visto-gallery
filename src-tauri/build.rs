fn main() {
    // The runtime looks for a sidecar stored as `ffmpeg-<triple>`, which is how
    // the bundler names it before stripping the suffix. Record the triple so the
    // lookup does not have to guess it from a directory listing.
    println!(
        "cargo:rustc-env=VISTO_TARGET={}",
        std::env::var("TARGET").expect("cargo sets TARGET for build scripts")
    );
    tauri_build::build()
}
