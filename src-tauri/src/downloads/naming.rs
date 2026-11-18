//! Naming masks: where a download is saved and what it is called.
//!
//! A mask is text with `{tokens}`; a `/` in it starts a subfolder. Everything a token expands to
//! comes from the page or the server, so every piece is cleaned until it can only name one file or
//! folder inside the download folder: no separators, no `..`, no characters a file system refuses.

use std::path::{Path, PathBuf};

use url::Url;

use super::kind::Kind;
use crate::error::{Error, Result};

const MAX_COMPONENT_CHARS: usize = 120;
const MAX_MASK_CHARS: usize = 200;
const FALLBACK_NAME: &str = "download";
const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// What the tokens stand for.
pub struct NameContext<'a> {
    pub url: &'a Url,
    /// The file name the server or the address gives, with its extension.
    pub file_name: &'a str,
    /// The text of the link or the alt text of the image.
    pub label: Option<&'a str>,
    pub page_title: Option<&'a str>,
    pub kind: Kind,
    /// Position in a batch, from 1.
    pub index: usize,
    /// Seconds since the Unix epoch.
    pub now: i64,
}

const TOKENS: &[&str] = &[
    "filename", "name", "ext", "title", "page", "site", "host", "date", "time", "kind", "n",
];

/// Whether `mask` can be saved: bounded, with only known tokens, and balanced braces.
pub fn validate_mask(mask: &str) -> Result<()> {
    if mask.chars().count() > MAX_MASK_CHARS {
        return Err(Error::Download(format!(
            "a naming mask can be at most {MAX_MASK_CHARS} characters"
        )));
    }
    let mut rest = mask;
    while let Some(open) = rest.find(['{', '}']) {
        if !rest[open..].starts_with('{') {
            return Err(Error::Download("a naming mask has a stray }".to_owned()));
        }
        let Some(close) = rest[open..].find('}') else {
            return Err(Error::Download(
                "a naming mask has an unclosed {".to_owned(),
            ));
        };
        let token = &rest[open + 1..open + close];
        let (name, width) = token.split_once(':').unwrap_or((token, ""));
        let width_ok =
            width.is_empty() || (name == "n" && width.parse::<usize>().is_ok_and(|w| w <= 9));
        if !TOKENS.contains(&name) || !width_ok {
            return Err(Error::Download(format!("unknown naming token {{{token}}}")));
        }
        rest = &rest[open + close + 1..];
    }
    Ok(())
}

/// Turns text from outside into one safe path component.
pub fn sanitize_component(text: &str) -> String {
    let mut cleaned = String::with_capacity(text.len());
    for c in text.chars() {
        let refused = c.is_control()
            || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200b}'..='\u{200f}');
        cleaned.push(if refused { '_' } else { c });
    }
    let trimmed = cleaned.trim_matches(|c: char| c.is_whitespace() || c == '.');
    let mut name: String = trimmed.chars().take(MAX_COMPONENT_CHARS).collect();
    name = name
        .trim_end_matches(|c: char| c.is_whitespace() || c == '.')
        .to_owned();
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name.is_empty() || RESERVED.contains(&stem.as_str()) {
        return if name.is_empty() {
            String::new()
        } else {
            format!("_{name}")
        };
    }
    name
}

/// Splits `path` at `/` and cleans each piece; empty pieces vanish.
fn components(path: &str) -> Vec<String> {
    path.split('/')
        .map(sanitize_component)
        .filter(|piece| !piece.is_empty())
        .collect()
}

fn civil(now: i64) -> (i64, i64, i64, i64, i64, i64) {
    let days = now.div_euclid(86_400);
    let seconds = now.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (
        year,
        month,
        day,
        seconds / 3600,
        seconds % 3600 / 60,
        seconds % 60,
    )
}

fn split_extension(file_name: &str) -> (&str, Option<&str>) {
    match super::kind::extension_of(file_name) {
        Some(extension) => (
            &file_name[..file_name.len() - extension.len() - 1],
            Some(extension),
        ),
        None => (file_name, None),
    }
}

fn expand_token(token: &str, context: &NameContext<'_>) -> String {
    let (name, width) = token.split_once(':').unwrap_or((token, ""));
    let (stem, extension) = split_extension(context.file_name);
    let (year, month, day, hour, minute, second) = civil(context.now);
    match name {
        "filename" => context.file_name.to_owned(),
        "name" => stem.to_owned(),
        "ext" => extension.unwrap_or_default().to_owned(),
        "title" => context.label.unwrap_or(stem).to_owned(),
        "page" => context.page_title.unwrap_or_default().to_owned(),
        "site" => context
            .url
            .host_str()
            .unwrap_or_default()
            .trim_start_matches("www.")
            .to_owned(),
        "host" => context.url.host_str().unwrap_or_default().to_owned(),
        "date" => format!("{year:04}-{month:02}-{day:02}"),
        "time" => format!("{hour:02}{minute:02}{second:02}"),
        "kind" => context.kind.token().to_owned(),
        "n" => {
            let width = width.parse::<usize>().unwrap_or(0);
            format!("{:0width$}", context.index)
        }
        _ => String::new(),
    }
}

fn expand_text(mask: &str, context: &NameContext<'_>) -> String {
    let mut expanded = String::new();
    let mut rest = mask;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else {
            break;
        };
        expanded.push_str(&rest[..open]);
        let value = expand_token(&rest[open + 1..open + close], context);
        // A token's own text is one piece, never a way to start a folder.
        expanded.push_str(&value.replace('/', "_"));
        rest = &rest[open + close + 1..];
    }
    expanded.push_str(rest);
    expanded
}

/// The folders a rule's folder text makes.
pub fn expand_folder(folder: &str, context: &NameContext<'_>) -> Vec<String> {
    components(&expand_text(folder, context))
}

/// The relative path a mask makes: folders, then the file name. The extension is appended when the
/// mask names neither `{filename}` nor `{ext}` and the file has one.
pub fn expand_mask(mask: &str, context: &NameContext<'_>) -> Vec<String> {
    let mut parts = components(&expand_text(mask, context));
    let names_extension = mask.contains("{filename}") || mask.contains("{ext}");
    let (_, extension) = split_extension(context.file_name);
    if let (false, Some(extension)) = (names_extension, extension)
        && let Some(last) = parts.last_mut()
        && !last
            .to_ascii_lowercase()
            .ends_with(&format!(".{}", extension.to_ascii_lowercase()))
    {
        last.push('.');
        last.push_str(extension);
    }
    if parts.is_empty() {
        parts.push(sanitize_component(context.file_name));
    }
    if parts.last().is_none_or(String::is_empty) {
        parts.push(FALLBACK_NAME.to_owned());
    }
    parts
}

/// Joins `parts` under `root` and finds a name nothing uses yet: `name (1).ext`, `name (2).ext`.
pub fn unique_path(root: &Path, parts: &[String], taken: impl Fn(&Path) -> bool) -> PathBuf {
    let mut base = root.to_path_buf();
    base.extend(parts);
    if !taken(&base) {
        return base;
    }
    let file_name = parts.last().map(String::as_str).unwrap_or(FALLBACK_NAME);
    let (stem, extension) = split_extension(file_name);
    for n in 1..10_000 {
        let candidate = match extension {
            Some(extension) => format!("{stem} ({n}).{extension}"),
            None => format!("{stem} ({n})"),
        };
        let path = base.with_file_name(candidate);
        if !taken(&path) {
            return path;
        }
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context<'a>(url: &'a Url, file_name: &'a str) -> NameContext<'a> {
        NameContext {
            url,
            file_name,
            label: None,
            page_title: Some("A / Page"),
            kind: Kind::Image,
            index: 7,
            now: 1_700_000_000,
        }
    }

    #[test]
    fn civil_dates_are_right() {
        assert_eq!(civil(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(civil(1_700_000_000), (2023, 11, 14, 22, 13, 20));
        assert_eq!(civil(951_782_400), (2000, 2, 29, 0, 0, 0));
    }

    #[test]
    fn tokens_expand_and_folders_come_from_slashes() {
        let url = Url::parse("https://www.example.com/a/cat.jpg").unwrap();
        let parts = expand_mask(
            "{site}/{date}/{n:3}-{name}.{ext}",
            &context(&url, "cat.jpg"),
        );
        assert_eq!(parts, ["example.com", "2023-11-14", "007-cat.jpg"]);
    }

    #[test]
    fn the_extension_is_kept_when_the_mask_leaves_it_out() {
        let url = Url::parse("https://example.com/cat.jpg").unwrap();
        assert_eq!(
            expand_mask("{page} - {title}", &context(&url, "cat.jpg")),
            ["A _ Page - cat.jpg"]
        );
    }

    #[test]
    fn hostile_text_cannot_leave_the_folder() {
        let url = Url::parse("https://example.com/x").unwrap();
        let mut hostile = context(&url, "..%2f..%2fx");
        hostile.page_title = Some("../../etc/passwd");
        let parts = expand_mask("{page}/{filename}", &hostile);
        assert!(parts.iter().all(|p| p != ".." && !p.contains('/')));
        let parts = expand_mask("../a/./{filename}", &hostile);
        assert!(parts.iter().all(|p| p != ".." && p != "."));
        assert_eq!(sanitize_component("a\u{202e}b:c*"), "a_b_c_");
        assert_eq!(sanitize_component("NUL.txt"), "_NUL.txt");
        assert_eq!(sanitize_component(" ... "), "");
    }

    #[test]
    fn masks_are_validated() {
        assert!(validate_mask("{site}/{n:3}-{filename}").is_ok());
        assert!(validate_mask("{nope}").is_err());
        assert!(validate_mask("{filename").is_err());
        assert!(validate_mask("a}b").is_err());
        assert!(validate_mask("{date:3}").is_err());
        assert!(validate_mask(&"a".repeat(300)).is_err());
    }

    #[test]
    fn a_taken_name_gets_a_number() {
        let root = Path::new("/d");
        let taken = |p: &Path| p == Path::new("/d/a.txt") || p == Path::new("/d/a (1).txt");
        let path = unique_path(root, &["a.txt".to_owned()], taken);
        assert_eq!(path, Path::new("/d/a (2).txt"));
    }
}
