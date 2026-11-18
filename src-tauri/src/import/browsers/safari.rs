//! Safari on macOS: `~/Library/Safari/Bookmarks.plist` and `History.db`. macOS keeps that folder
//! behind Full Disk Access, so a refusal is reported as what to allow. Its passwords live in the
//! system Keychain and are not read; Safari's own export (File > Export > Passwords) covers them.

use std::{fs, path::Path};

use plist::Value;

use super::sqlite::{Snapshot, denied};
use crate::error::Result;
use crate::import::{
    Found,
    parse::{self, Link},
};

const HISTORY_ROWS: usize = 5000;
const MAX_DEPTH: usize = 32;

pub fn read(folder: &Path) -> Result<Found> {
    let mut found = Found::default();
    match fs::read(folder.join("Bookmarks.plist")) {
        Ok(bytes) => {
            if let Ok(root) = Value::from_reader(std::io::Cursor::new(bytes)) {
                bookmarks(&root, &mut found.bookmarks, 0);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(denied(&error)),
    }
    if let Some(snapshot) = Snapshot::of(&folder.join("History.db"))? {
        found.history = history(&snapshot).unwrap_or_default();
    }
    Ok(found)
}

fn bookmarks(node: &Value, out: &mut Vec<Link>, depth: usize) {
    let Some(dict) = node.as_dictionary() else {
        return;
    };
    if let Some(url) = dict.get("URLString").and_then(Value::as_string)
        && let Some(url) = parse::web_url(url)
    {
        let title = dict
            .get("URIDictionary")
            .and_then(Value::as_dictionary)
            .and_then(|uri| uri.get("title"))
            .and_then(Value::as_string)
            .unwrap_or_default();
        out.push(Link {
            url,
            title: title.to_owned(),
            visits: 1,
        });
    }
    if depth < MAX_DEPTH
        && let Some(children) = dict.get("Children").and_then(Value::as_array)
    {
        for child in children {
            bookmarks(child, out, depth + 1);
        }
    }
}

fn history(snapshot: &Snapshot) -> rusqlite::Result<Vec<Link>> {
    let connection = snapshot.open().map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut statement = connection.prepare(
        "SELECT url, visit_count FROM history_items WHERE visit_count > 0 \
         ORDER BY visit_count DESC LIMIT ?1",
    )?;
    let rows = statement.query_map([HISTORY_ROWS], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
    })?;
    Ok(rows
        .flatten()
        .filter_map(|(url, visits)| {
            Some(Link {
                url: parse::web_url(&url)?,
                title: String::new(),
                visits: visits.max(1),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bookmarks_are_found_in_nested_folders() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Children</key><array>
<dict><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Children</key><array>
<dict><key>URLString</key><string>https://www.rust-lang.org/</string>
<key>URIDictionary</key><dict><key>title</key><string>Rust</string></dict></dict>
</array></dict>
<dict><key>URLString</key><string>javascript:void(0)</string></dict>
</array></dict></plist>"#;
        let root = Value::from_reader_xml(xml.as_bytes()).unwrap();
        let mut found = Vec::new();
        bookmarks(&root, &mut found, 0);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Rust");
    }
}
