//! Chromium-based browsers (Chrome, Edge, Brave, Vivaldi, Arc, Chromium): a user-data folder with
//! one folder per profile, each holding a `Bookmarks` JSON, a `Preferences` JSON, a `History`
//! database and a `Login Data` database whose passwords are sealed by the OS (`os_key.rs`).

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use zeroize::Zeroizing;

use super::{Profile, Roots, read_text, sqlite::Snapshot};
use crate::error::Result;
use crate::import::{
    Found,
    parse::{self, Credential, Link},
};

/// How many of the most visited addresses are read; the import keeps 100.
const HISTORY_ROWS: usize = 5000;
const LOGIN_ROWS: usize = 20_000;

/// Where one Chromium browser keeps its data on each system, and what guards its passwords.
pub struct Def {
    pub id: &'static str,
    pub name: &'static str,
    /// Under `~/Library/Application Support`.
    pub mac: Option<&'static str>,
    /// Under `%LOCALAPPDATA%`.
    pub windows: Option<&'static str>,
    /// Under `~/.config`.
    pub linux: Option<&'static str>,
    /// The macOS Keychain item: service and account.
    pub keychain: (&'static str, &'static str),
    /// The `application` attribute of its Secret Service item on Linux.
    #[cfg(target_os = "linux")]
    pub secret_app: &'static str,
}

pub const BROWSERS: [Def; 6] = [
    Def {
        id: "chrome",
        name: "Google Chrome",
        mac: Some("Google/Chrome"),
        windows: Some(r"Google\Chrome\User Data"),
        linux: Some("google-chrome"),
        keychain: ("Chrome Safe Storage", "Chrome"),
        #[cfg(target_os = "linux")]
        secret_app: "chrome",
    },
    Def {
        id: "edge",
        name: "Microsoft Edge",
        mac: Some("Microsoft Edge"),
        windows: Some(r"Microsoft\Edge\User Data"),
        linux: Some("microsoft-edge"),
        keychain: ("Microsoft Edge Safe Storage", "Microsoft Edge"),
        #[cfg(target_os = "linux")]
        secret_app: "chromium",
    },
    Def {
        id: "brave",
        name: "Brave",
        mac: Some("BraveSoftware/Brave-Browser"),
        windows: Some(r"BraveSoftware\Brave-Browser\User Data"),
        linux: Some("BraveSoftware/Brave-Browser"),
        keychain: ("Brave Safe Storage", "Brave"),
        #[cfg(target_os = "linux")]
        secret_app: "brave",
    },
    Def {
        id: "vivaldi",
        name: "Vivaldi",
        mac: Some("Vivaldi"),
        windows: Some(r"Vivaldi\User Data"),
        linux: Some("vivaldi"),
        keychain: ("Vivaldi Safe Storage", "Vivaldi"),
        #[cfg(target_os = "linux")]
        secret_app: "chromium",
    },
    Def {
        id: "arc",
        name: "Arc",
        mac: Some("Arc/User Data"),
        windows: None,
        linux: None,
        keychain: ("Arc Safe Storage", "Arc"),
        #[cfg(target_os = "linux")]
        secret_app: "chromium",
    },
    Def {
        id: "chromium",
        name: "Chromium",
        mac: Some("Chromium"),
        windows: Some(r"Chromium\User Data"),
        linux: Some("chromium"),
        keychain: ("Chromium Safe Storage", "Chromium"),
        #[cfg(target_os = "linux")]
        secret_app: "chromium",
    },
];

/// Reads one password blob; the key behind it is fetched the first time one is asked for, so a
/// profile without saved logins never makes the OS ask for access.
pub trait Opener {
    fn open(&self, sealed: &[u8]) -> Option<Zeroizing<String>>;
}

impl Def {
    /// The user-data folder on this system, when this browser exists on it.
    pub fn user_data(&self, roots: &Roots) -> Option<PathBuf> {
        let (relative, base) = if cfg!(target_os = "macos") {
            (self.mac, roots.home.join("Library/Application Support"))
        } else if cfg!(target_os = "windows") {
            (self.windows, roots.local_app_data.clone()?)
        } else {
            (self.linux, roots.config.clone())
        };
        let folder = base.join(relative?);
        folder.is_dir().then_some(folder)
    }
}

/// The profile folders in a user-data folder, named as the browser names them.
pub fn profiles(user_data: &Path) -> Vec<Profile> {
    let names = profile_names(user_data);
    let Ok(entries) = fs::read_dir(user_data) else {
        return Vec::new();
    };
    let mut found: Vec<Profile> = entries
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().to_str()?.to_owned();
            let is_profile = id == "Default" || id.starts_with("Profile ");
            let has_data = ["Bookmarks", "History", "Login Data", "Preferences"]
                .iter()
                .any(|file| entry.path().join(file).is_file());
            (is_profile && has_data).then(|| Profile {
                name: names.get(&id).cloned().unwrap_or_else(|| id.clone()),
                id,
            })
        })
        .collect();
    found.sort_by(|a, b| {
        (b.id == "Default")
            .cmp(&(a.id == "Default"))
            .then(a.id.cmp(&b.id))
    });
    found
}

fn profile_names(user_data: &Path) -> std::collections::HashMap<String, String> {
    let Some(state) = read_text(&user_data.join("Local State"))
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return Default::default();
    };
    state["profile"]["info_cache"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(id, info)| Some((id.clone(), info["name"].as_str()?.to_owned())))
        .collect()
}

/// Everything one profile holds.
pub fn read(profile: &Path, opener: &dyn Opener) -> Result<Found> {
    let mut found = Found::default();
    if let Some(text) = read_text(&profile.join("Bookmarks")) {
        found.bookmarks = parse::parse(&text).links;
    }
    if let Some(text) = read_text(&profile.join("Preferences")) {
        found.search_engine = parse::parse(&text).search_engine;
    }
    if let Some(snapshot) = Snapshot::of(&profile.join("History"))? {
        found.history = history(&snapshot).unwrap_or_default();
    }
    if let Some(snapshot) = Snapshot::of(&profile.join("Login Data"))? {
        logins(&snapshot, opener, &mut found).unwrap_or_default();
    }
    Ok(found)
}

fn history(snapshot: &Snapshot) -> rusqlite::Result<Vec<Link>> {
    let connection = snapshot.open().map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut statement = connection.prepare(
        "SELECT url, title, visit_count FROM urls WHERE visit_count > 0 \
         ORDER BY visit_count DESC LIMIT ?1",
    )?;
    let rows = statement.query_map([HISTORY_ROWS], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, u32>(2)?,
        ))
    })?;
    Ok(rows
        .flatten()
        .filter_map(|(url, title, visits)| {
            Some(Link {
                url: parse::web_url(&url)?,
                title: title.unwrap_or_default(),
                visits: visits.max(1),
            })
        })
        .collect())
}

fn logins(snapshot: &Snapshot, opener: &dyn Opener, found: &mut Found) -> rusqlite::Result<()> {
    let connection = snapshot.open().map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut statement = connection.prepare(
        "SELECT origin_url, username_value, password_value FROM logins \
         WHERE blacklisted_by_user = 0 AND length(password_value) > 0 LIMIT ?1",
    )?;
    let rows = statement.query_map([LOGIN_ROWS], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;
    for (origin, username, sealed) in rows.flatten() {
        let Some(url) = parse::web_url(&origin) else {
            continue;
        };
        match opener.open(&sealed) {
            Some(password) => found.credentials.push(Credential {
                name: url::Url::parse(&url)
                    .ok()
                    .and_then(|parsed| parsed.host_str().map(str::to_owned))
                    .unwrap_or_default(),
                url,
                username,
                password,
            }),
            None => found.unreadable_passwords += 1,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::browsers::crypto::{Key, tests::seal_cbc};

    struct TestKey(Key);

    impl Opener for TestKey {
        fn open(&self, sealed: &[u8]) -> Option<Zeroizing<String>> {
            let plain = self.0.open(sealed.strip_prefix(b"v10")?)?;
            Some(Zeroizing::new(String::from_utf8(plain.to_vec()).ok()?))
        }
    }

    fn profile_with_data(key: &Key) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        fs::write(
            path.join("Bookmarks"),
            r#"{"roots":{"bookmark_bar":{"children":[{"type":"url","name":"Rust","url":"https://www.rust-lang.org/"}]}}}"#,
        )
        .unwrap();
        fs::write(
            path.join("Preferences"),
            r#"{"default_search_provider_data":{"template_url_data":{"short_name":"DuckDuckGo","keyword":"duckduckgo.com","url":"https://duckduckgo.com/?q={searchTerms}"}}}"#,
        )
        .unwrap();
        let history = rusqlite::Connection::open(path.join("History")).unwrap();
        history
            .execute_batch(
                "CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER);
                 INSERT INTO urls VALUES ('https://www.reddit.com/', 'Reddit', 40);
                 INSERT INTO urls VALUES ('chrome://settings/', 'Settings', 9);
                 INSERT INTO urls VALUES ('https://never.example.org/', 'Never', 0);",
            )
            .unwrap();
        let mut good = b"v10".to_vec();
        good.extend(seal_cbc(key, b"hunter2"));
        let mut foreign = b"v20".to_vec();
        foreign.extend([1u8; 40]);
        let logins = rusqlite::Connection::open(path.join("Login Data")).unwrap();
        logins
            .execute_batch(
                "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER);",
            )
            .unwrap();
        for (url, user, blob, blocked) in [
            ("https://accounts.example.com/login", "ana", good, 0),
            ("https://sealed.example.com/", "bo", foreign, 0),
            ("https://never.example.com/", "", vec![1u8], 1),
        ] {
            logins
                .execute(
                    "INSERT INTO logins VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![url, user, blob, blocked],
                )
                .unwrap();
        }
        dir
    }

    #[test]
    fn a_profile_gives_bookmarks_history_engine_and_readable_logins() {
        let key = Key::cbc_from_secret(b"secret", 1003).unwrap();
        let dir = profile_with_data(&key);
        let found = read(dir.path(), &TestKey(key)).unwrap();
        assert_eq!(found.bookmarks.len(), 1);
        assert_eq!(found.history.len(), 1);
        assert_eq!(found.history[0].url, "https://www.reddit.com/");
        assert_eq!(found.history[0].visits, 40);
        assert!(found.search_engine.is_some());
        assert_eq!(found.credentials.len(), 1);
        assert_eq!(found.credentials[0].username, "ana");
        assert_eq!(found.credentials[0].password.as_str(), "hunter2");
        assert_eq!(found.unreadable_passwords, 1);
    }

    #[test]
    fn profiles_are_named_by_the_browser() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        for name in ["Default", "Profile 2", "System Profile", "Crashpad"] {
            fs::create_dir(path.join(name)).unwrap();
            fs::write(path.join(name).join("History"), b"").unwrap();
        }
        fs::write(
            path.join("Local State"),
            r#"{"profile":{"info_cache":{"Profile 2":{"name":"Work"}}}}"#,
        )
        .unwrap();
        let found = profiles(path);
        let listed: Vec<(&str, &str)> = found
            .iter()
            .map(|profile| (profile.id.as_str(), profile.name.as_str()))
            .collect();
        assert_eq!(listed, [("Default", "Default"), ("Profile 2", "Work")]);
    }
}
