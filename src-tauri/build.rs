use std::{collections::HashMap, env, path::Path};

const BUILD_KEYS: [&str; 5] = [
    "OPENMEDIA_RC_KEY_IOS",
    "OPENMEDIA_RC_KEY_MACOS",
    "OPENMEDIA_RC_KEY_ANDROID",
    "OPENMEDIA_DEV_ENTITLEMENT",
    "EXPO_PUBLIC_FORCE_ENABLE_PRO_ON_SIMULATOR",
];

fn main() {
    forward_build_keys();
    link_swift_runtime();
    tauri_build::build()
}

/// The process environment wins over `../.env`. Missing keys are forwarded empty, which the app
/// reads as "not configured".
fn forward_build_keys() {
    let env_file = Path::new("..").join(".env");
    println!("cargo:rerun-if-changed={}", env_file.display());
    let file: HashMap<String, String> = dotenvy::from_path_iter(&env_file)
        .map(|entries| entries.flatten().collect())
        .unwrap_or_default();
    let read = |name: &str| {
        env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| file.get(name).cloned())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    for name in BUILD_KEYS {
        println!("cargo:rerun-if-env-changed={name}");
        let mut value = read(name);
        if name == "OPENMEDIA_RC_KEY_MACOS" {
            value = value.or_else(|| read("OPENMEDIA_RC_KEY_IOS"));
        }
        println!("cargo:rustc-env={name}={}", value.unwrap_or_default());
    }
}

/// The macOS store layer is Swift (see `plugins/tauri-plugin-billing/macos`). Swift's runtime
/// ships with macOS, and a library crate's link arguments do not reach the app, so the app says
/// where to find it.
fn link_swift_runtime() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
