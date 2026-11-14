use std::{collections::HashMap, env, fs, path::Path};

const BUILD_KEYS: [&str; 5] = [
    "OPENMEDIA_SHARE_URL",
    "OPENMEDIA_RC_KEY_IOS",
    "OPENMEDIA_RC_KEY_MACOS",
    "OPENMEDIA_RC_KEY_ANDROID",
    "OPENMEDIA_DEV_ENTITLEMENT",
];

fn main() {
    forward_build_keys();
    embed_recipes();
    link_swift_runtime();
    align_android_pages();
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

/// Lists the bundled recipe files for `src/recipes/bundled.rs`: every `recipes/official/*.json`
/// and `recipes/community/*.json`, in name order. An empty directory gives an empty list.
fn embed_recipes() {
    let root = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap_or_default()).join("../recipes");
    let mut entries = String::from("pub const FILES: &[File] = &[\n");
    for (directory, channel) in [("official", "Official"), ("community", "Community")] {
        let dir = root.join(directory);
        println!("cargo:rerun-if-changed={}", dir.display());
        let mut files: Vec<_> = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        files.sort();
        for path in files {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let absolute = fs::canonicalize(&path).unwrap_or(path);
            entries.push_str(&format!(
                "    File {{ channel: Channel::{channel}, name: {name:?}, text: include_str!({:?}) }},\n",
                absolute.to_string_lossy()
            ));
        }
    }
    entries.push_str("];\n");
    let out = Path::new(&env::var("OUT_DIR").unwrap_or_default()).join("bundled_recipes.rs");
    if let Err(error) = fs::write(&out, entries) {
        panic!("could not write {}: {error}", out.display());
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

/// Google Play requires 64-bit Android libraries to be aligned for 16 KB memory pages, and the NDK
/// links with a 4 KB maximum page size by default. 32-bit ABIs are exempt.
fn align_android_pages() {
    let is_android = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android");
    let is_64_bit = matches!(
        env::var("CARGO_CFG_TARGET_ARCH").as_deref(),
        Ok("aarch64" | "x86_64")
    );
    if is_android && is_64_bit {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
    }
}
