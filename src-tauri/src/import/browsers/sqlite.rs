//! Opening another browser's database. The browser may be running and holds the file open, so the
//! database (and its write-ahead log, which holds the newest rows) is copied to a private folder
//! and read from there; the original is never opened, and the copy is deleted afterwards.

use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, OpenFlags};
use uuid::Uuid;

use crate::error::{Error, Result};

/// Larger databases are not copied; a history this large is not worth the wait.
const MAX_DATABASE_BYTES: u64 = 1024 * 1024 * 1024;

/// A private copy of one database, deleted when dropped.
pub struct Snapshot {
    folder: PathBuf,
    database: PathBuf,
}

impl Snapshot {
    /// Copies `source` (and `source-wal` when there is one). `Ok(None)` when it does not exist.
    pub fn of(source: &Path) -> Result<Option<Self>> {
        let Ok(meta) = fs::metadata(source) else {
            return Ok(None);
        };
        if meta.len() > MAX_DATABASE_BYTES {
            return Err(Error::Import(
                "that browser's data is too large to read".into(),
            ));
        }
        let folder = std::env::temp_dir().join(format!("openmedia-import-{}", Uuid::new_v4()));
        private_folder(&folder)?;
        let snapshot = Self {
            database: folder.join("data.sqlite"),
            folder,
        };
        copy(source, &snapshot.database)?;
        let mut wal = source.as_os_str().to_owned();
        wal.push("-wal");
        let wal = PathBuf::from(wal);
        if wal.is_file() {
            copy(&wal, &snapshot.folder.join("data.sqlite-wal"))?;
        }
        Ok(Some(snapshot))
    }

    pub fn open(&self) -> Result<Connection> {
        Connection::open_with_flags(&self.database, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| Error::Import("could not read that browser's data".into()))
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.folder);
    }
}

fn copy(from: &Path, to: &Path) -> Result<()> {
    fs::copy(from, to).map(drop).map_err(|error| denied(&error))
}

/// What the person can do about a file that cannot be read.
pub fn denied(error: &std::io::Error) -> Error {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        Error::Import(
            "this app is not allowed to read that browser's files. On a Mac, allow it under System Settings > Privacy & Security > Full Disk Access, or use the exported files instead".into(),
        )
    } else {
        Error::Import("could not read that browser's files".into())
    }
}

#[cfg(unix)]
fn private_folder(folder: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(folder)
        .map_err(|error| denied(&error))
}

#[cfg(not(unix))]
fn private_folder(folder: &Path) -> Result<()> {
    fs::create_dir(folder).map_err(|error| denied(&error))
}
