const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .android_path("android")
        .build();
    link_macos_store();
}

/// macOS has no Tauri Swift plugin, so its store layer is a plain Swift package linked into the
/// app (see `macos/Sources/Billing.swift`). Rebuilt whenever its sources change. Compiled only on
/// a macOS host, the one that has the Swift toolchain.
fn link_macos_store() {
    println!("cargo:rerun-if-changed=macos/Package.swift");
    println!("cargo:rerun-if-changed=macos/Sources");
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        swift_rs::SwiftLinker::new("14.0")
            .with_package("om-billing-macos", "macos")
            .link();
    }
}
