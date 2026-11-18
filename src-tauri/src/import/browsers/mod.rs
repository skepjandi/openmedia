//! Importing straight from a browser installed on this computer: no export, no files to choose.
//! [`detect`] lists the browsers and profiles found; [`read`] reads one profile's bookmarks,
//! history, search engine and, where the OS lets it, saved passwords, into the same pending state
//! the exported files feed (`ImportState`). Desktop only: iOS and the sandboxed stores cannot read
//! another app's folders, so they keep the exported-file path.

mod chromium;
mod crypto;
mod firefox;
mod os_key;
#[cfg(target_os = "macos")]
mod safari;
mod sqlite;

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

use super::{Found, parse::MAX_FILE_BYTES};
use crate::error::{Error, Result};

const FIREFOX: (&str, &str) = ("firefox", "Firefox");
#[cfg(target_os = "macos")]
const SAFARI: (&str, &str) = ("safari", "Safari");

/// The folders browsers keep their data in, resolved from the environment once.
pub struct Roots {
    pub home: PathBuf,
    pub config: PathBuf,
    pub local_app_data: Option<PathBuf>,
    pub app_data: Option<PathBuf>,
}

impl Roots {
    pub fn from_env() -> Option<Self> {
        let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
        let home = var("HOME").or_else(|| var("USERPROFILE"))?;
        Some(Self {
            config: var("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")),
            local_app_data: var("LOCALAPPDATA"),
            app_data: var("APPDATA"),
            home,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
}

/// A browser found on this computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Detected {
    pub id: String,
    pub name: String,
    pub profiles: Vec<Profile>,
}

/// Reads a small text file; `None` when it is absent, unreadable or larger than an import takes.
fn read_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if usize::try_from(meta.len()).ok()? > MAX_FILE_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// The browsers on this computer that have a profile to read, the most used first.
pub fn detect(roots: &Roots) -> Vec<Detected> {
    let mut found: Vec<Detected> = chromium::BROWSERS
        .iter()
        .filter_map(|def| {
            let profiles = chromium::profiles(&def.user_data(roots)?);
            (!profiles.is_empty()).then(|| Detected {
                id: def.id.into(),
                name: def.name.into(),
                profiles,
            })
        })
        .collect();
    let firefox: Vec<Profile> = firefox::profile_folders(roots)
        .iter()
        .flat_map(|folder| firefox::profiles(folder))
        .collect();
    if !firefox.is_empty() {
        found.push(Detected {
            id: FIREFOX.0.into(),
            name: FIREFOX.1.into(),
            profiles: firefox,
        });
    }
    #[cfg(target_os = "macos")]
    if roots.home.join("Library/Safari").is_dir() {
        found.push(Detected {
            id: SAFARI.0.into(),
            name: SAFARI.1.into(),
            profiles: vec![Profile {
                id: "default".into(),
                name: SAFARI.1.into(),
            }],
        });
    }
    found
}

/// Reads one profile of one detected browser. Both ids must be ones [`detect`] lists: nothing the
/// shell sends is used as a path.
pub fn read(roots: &Roots, browser: &str, profile: &str) -> Result<Found> {
    let detected = detect(roots);
    let known = detected
        .iter()
        .find(|entry| entry.id == browser)
        .and_then(|entry| entry.profiles.iter().find(|item| item.id == profile));
    if known.is_none() {
        return Err(Error::Import("that browser was not found".into()));
    }
    if let Some(def) = chromium::BROWSERS.iter().find(|def| def.id == browser) {
        let user_data = def
            .user_data(roots)
            .ok_or_else(|| Error::Import("that browser was not found".into()))?;
        let opener = os_key::OsOpener::new(def, &user_data);
        return chromium::read(&user_data.join(profile), &opener);
    }
    if browser == FIREFOX.0 {
        let folder = firefox::profile_folders(roots)
            .into_iter()
            .map(|folder| folder.join(profile))
            .find(|path| path.join("places.sqlite").is_file())
            .ok_or_else(|| Error::Import("that browser was not found".into()))?;
        return firefox::read(&folder);
    }
    #[cfg(target_os = "macos")]
    if browser == SAFARI.0 {
        return safari::read(&roots.home.join("Library/Safari"));
    }
    Err(Error::Import("that browser was not found".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_browser_or_profile_that_was_not_detected_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let roots = Roots {
            home: home.path().to_path_buf(),
            config: home.path().join(".config"),
            local_app_data: Some(home.path().join("Local")),
            app_data: Some(home.path().join("Roaming")),
        };
        assert!(detect(&roots).is_empty());
        assert!(read(&roots, "chrome", "Default").is_err());
        assert!(read(&roots, "chrome", "../../etc").is_err());
    }
}
