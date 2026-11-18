//! What a file is, from its extension or its content type.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Image,
    Video,
    Audio,
    Document,
    Archive,
    Other,
}

const IMAGE: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "ico", "tif", "tiff", "heic",
];
const VIDEO: &[&str] = &[
    "mp4", "m4v", "webm", "mkv", "mov", "avi", "flv", "wmv", "ogv", "3gp", "mpg", "mpeg",
];
const AUDIO: &[&str] = &[
    "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma", "aiff",
];
const DOCUMENT: &[&str] = &[
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv", "odt", "ods", "odp",
    "epub",
];
const ARCHIVE: &[&str] = &[
    "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso", "dmg",
];
const INSTALLER: &[&str] = &["exe", "msi", "pkg", "deb", "apk"];

const MIME_EXTENSIONS: &[(&str, &str)] = &[
    ("image/jpeg", "jpg"),
    ("image/png", "png"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/avif", "avif"),
    ("image/svg+xml", "svg"),
    ("image/bmp", "bmp"),
    ("video/mp4", "mp4"),
    ("video/webm", "webm"),
    ("video/quicktime", "mov"),
    ("video/x-matroska", "mkv"),
    ("audio/mpeg", "mp3"),
    ("audio/mp4", "m4a"),
    ("audio/aac", "aac"),
    ("audio/ogg", "ogg"),
    ("audio/wav", "wav"),
    ("audio/x-wav", "wav"),
    ("audio/flac", "flac"),
    ("audio/webm", "weba"),
    ("application/pdf", "pdf"),
    ("application/zip", "zip"),
    ("application/gzip", "gz"),
    ("text/plain", "txt"),
    ("text/csv", "csv"),
];

impl Kind {
    /// The kind a file extension names, or `None` when it is not one the app knows. Installers are
    /// known but have no kind of their own: they are [`Kind::Other`].
    pub fn from_extension(extension: &str) -> Option<Self> {
        let extension = extension.to_ascii_lowercase();
        let extension = extension.as_str();
        [
            (IMAGE, Self::Image),
            (VIDEO, Self::Video),
            (AUDIO, Self::Audio),
            (DOCUMENT, Self::Document),
            (ARCHIVE, Self::Archive),
            (INSTALLER, Self::Other),
        ]
        .into_iter()
        .find(|(list, _)| list.contains(&extension))
        .map(|(_, kind)| kind)
    }

    pub fn from_mime(mime: &str) -> Self {
        let mime = mime.split(';').next().unwrap_or_default().trim();
        let mime = mime.to_ascii_lowercase();
        match mime.split('/').next() {
            Some("image") => Self::Image,
            Some("video") => Self::Video,
            Some("audio") => Self::Audio,
            _ if matches!(mime.as_str(), "application/pdf" | "text/plain" | "text/csv") => {
                Self::Document
            }
            _ if matches!(mime.as_str(), "application/zip" | "application/gzip") => Self::Archive,
            _ => Self::Other,
        }
    }

    /// The word the naming masks use for it.
    pub fn token(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
            Self::Audio => "audio",
            Self::Document => "document",
            Self::Archive => "archive",
            Self::Other => "file",
        }
    }
}

/// The extension a content type usually has.
pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
    let mime = mime.split(';').next().unwrap_or_default().trim();
    MIME_EXTENSIONS
        .iter()
        .find(|(known, _)| known.eq_ignore_ascii_case(mime))
        .map(|(_, extension)| *extension)
}

/// The text after the last dot of a file name, when it looks like an extension (1 to 8 letters or
/// digits) and the name has something before the dot.
pub fn extension_of(name: &str) -> Option<&str> {
    let (stem, extension) = name.rsplit_once('.')?;
    let plausible = !stem.is_empty()
        && (1..=8).contains(&extension.len())
        && extension.chars().all(|c| c.is_ascii_alphanumeric());
    plausible.then_some(extension)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_map_to_kinds_ignoring_case() {
        assert_eq!(Kind::from_extension("JPG"), Some(Kind::Image));
        assert_eq!(Kind::from_extension("mp4"), Some(Kind::Video));
        assert_eq!(Kind::from_extension("exe"), Some(Kind::Other));
        assert_eq!(Kind::from_extension("html"), None);
    }

    #[test]
    fn content_types_map_to_kinds() {
        assert_eq!(Kind::from_mime("video/mp4; codecs=avc1"), Kind::Video);
        assert_eq!(Kind::from_mime("application/pdf"), Kind::Document);
        assert_eq!(Kind::from_mime("application/octet-stream"), Kind::Other);
        assert_eq!(extension_for_mime("Image/PNG; charset=x"), Some("png"));
    }

    #[test]
    fn extension_needs_a_stem_and_a_plausible_suffix() {
        assert_eq!(extension_of("a.tar.gz"), Some("gz"));
        assert_eq!(extension_of(".hidden"), None);
        assert_eq!(extension_of("noext"), None);
        assert_eq!(extension_of("file.this-is-not"), None);
    }
}
