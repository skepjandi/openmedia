//! Firefox: one folder per profile with a `places.sqlite` (bookmarks and history). Its saved logins
//! are sealed with a key only Firefox's own security library opens, so they are counted, not read:
//! the person is pointed at Firefox's own password export.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::{Profile, Roots, read_text, sqlite::Snapshot};
use crate::error::Result;
use crate::import::{
    Found,
    parse::{self, Link},
};

const HISTORY_ROWS: usize = 5000;
const BOOKMARK_ROWS: usize = 20_000;

/// The folders that hold Firefox profiles, one per way of installing it.
pub fn profile_folders(roots: &Roots) -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        vec![
            roots
                .home
                .join("Library/Application Support/Firefox/Profiles"),
        ]
    } else if cfg!(target_os = "windows") {
        roots
            .app_data
            .iter()
            .map(|base| base.join(r"Mozilla\Firefox\Profiles"))
            .collect()
    } else {
        vec![
            roots.home.join(".mozilla/firefox"),
            roots.home.join("snap/firefox/common/.mozilla/firefox"),
            roots
                .home
                .join(".var/app/org.mozilla.firefox/.mozilla/firefox"),
        ]
    }
}

/// The profile folders that hold data. A folder `abcd1234.default-release` is shown as
/// `default-release`.
pub fn profiles(folder: &Path) -> Vec<Profile> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut found: Vec<Profile> = entries
        .flatten()
        .filter(|entry| entry.path().join("places.sqlite").is_file())
        .filter_map(|entry| {
            let id = entry.file_name().to_str()?.to_owned();
            let name = id.split_once('.').map_or(id.as_str(), |(_, name)| name);
            Some(Profile {
                name: name.to_owned(),
                id,
            })
        })
        .collect();
    found.sort_by(|a, b| {
        a.name
            .contains("release")
            .cmp(&b.name.contains("release"))
            .reverse()
            .then(a.id.cmp(&b.id))
    });
    found
}

pub fn read(profile: &Path) -> Result<Found> {
    let mut found = Found::default();
    if let Some(snapshot) = Snapshot::of(&profile.join("places.sqlite"))? {
        found.bookmarks = bookmarks(&snapshot).unwrap_or_default();
        found.history = history(&snapshot).unwrap_or_default();
    }
    found.unreadable_passwords = read_text(&profile.join("logins.json"))
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|json| json["logins"].as_array().map(Vec::len))
        .unwrap_or(0);
    Ok(found)
}

fn bookmarks(snapshot: &Snapshot) -> rusqlite::Result<Vec<Link>> {
    let connection = snapshot.open().map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut statement = connection.prepare(
        "SELECT p.url, b.title FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id \
         WHERE b.type = 1 LIMIT ?1",
    )?;
    let rows = statement.query_map([BOOKMARK_ROWS], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    Ok(rows
        .flatten()
        .filter_map(|(url, title)| {
            Some(Link {
                url: parse::web_url(&url)?,
                title: title.unwrap_or_default(),
                visits: 1,
            })
        })
        .collect())
}

fn history(snapshot: &Snapshot) -> rusqlite::Result<Vec<Link>> {
    let connection = snapshot.open().map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut statement = connection.prepare(
        "SELECT url, title, visit_count FROM moz_places WHERE visit_count > 0 \
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_gives_bookmarks_history_and_a_count_of_sealed_logins() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ab12cd34.default-release");
        fs::create_dir(&path).unwrap();
        let places = rusqlite::Connection::open(path.join("places.sqlite")).unwrap();
        places
            .execute_batch(
                "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER);
                 CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, title TEXT);
                 INSERT INTO moz_places VALUES (1, 'https://www.reddit.com/', 'Reddit', 12);
                 INSERT INTO moz_places VALUES (2, 'place:sort=8', '', 0);
                 INSERT INTO moz_bookmarks VALUES (1, 1, 1, 'Reddit');
                 INSERT INTO moz_bookmarks VALUES (2, 1, 2, 'Recent');
                 INSERT INTO moz_bookmarks VALUES (3, 2, NULL, 'A folder');",
            )
            .unwrap();
        drop(places);
        fs::write(
            path.join("logins.json"),
            r#"{"logins":[{"id":1},{"id":2}]}"#,
        )
        .unwrap();

        let listed = profiles(dir.path());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "default-release");

        let found = read(&path).unwrap();
        assert_eq!(found.bookmarks.len(), 1);
        assert_eq!(found.history.len(), 1);
        assert_eq!(found.history[0].visits, 12);
        assert_eq!(found.unreadable_passwords, 2);
        assert!(found.credentials.is_empty());
    }
}
