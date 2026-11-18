//! Reading the files another browser exports: bookmarks (HTML or JSON), history (JSON or CSV)
//! and passwords (CSV). Every parser is tolerant and bounded: the file is the user's own, but it
//! comes from another program, so nothing in it is trusted to be well formed.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::library::SearchEngine;

/// The largest file accepted, in bytes. A year of history is a few megabytes.
pub const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;

/// An address with the name it was saved or visited under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub url: String,
    pub title: String,
    /// How many times it was visited; 1 for a bookmark.
    pub visits: u32,
}

/// One saved login. The password lives only in memory and in the vault.
pub struct Credential {
    pub name: String,
    pub url: String,
    pub username: String,
    pub password: zeroize::Zeroizing<String>,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("url", &self.url)
            .field("username", &self.username)
            .finish_non_exhaustive()
    }
}

/// What one file held.
#[derive(Debug, Default)]
pub struct Parsed {
    pub links: Vec<Link>,
    /// True when the links are visits, not bookmarks.
    pub is_history: bool,
    pub credentials: Vec<Credential>,
    pub search_engine: Option<SearchEngine>,
}

static ANCHOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#)
        .unwrap_or_else(|_| unreachable!("the pattern is a constant"))
});
static TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)<[^>]*>").unwrap_or_else(|_| unreachable!("the pattern is a constant"))
});

const URL_KEYS: [&str; 4] = ["url", "URL", "uri", "href"];
const TITLE_KEYS: [&str; 4] = ["name", "title", "Title", "label"];
const VISIT_KEYS: [&str; 4] = ["visit_count", "visitCount", "visits", "Visits"];

/// Reads one exported file, whatever it is. Unknown text is an empty result, not an error.
pub fn parse(text: &str) -> Parsed {
    let text = text.trim_start_matches('\u{feff}').trim();
    if text.starts_with('<') || text.to_ascii_lowercase().contains("<a href") {
        return links(parse_html(text), false);
    }
    if text.starts_with('{') || text.starts_with('[') {
        return parse_json(text);
    }
    parse_csv(text)
}

fn links(links: Vec<Link>, is_history: bool) -> Parsed {
    Parsed {
        links,
        is_history,
        ..Parsed::default()
    }
}

/// A web address with a host, or nothing. Other schemes (`place:`, `feed:`, `javascript:`,
/// `chrome://`) are not sites.
pub fn web_url(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim()).ok()?;
    matches!(url.scheme(), "http" | "https")
        .then_some(())
        .and(url.host_str().filter(|host| host.contains('.')))?;
    Some(url.to_string())
}

fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&amp;", "&")
}

fn parse_html(text: &str) -> Vec<Link> {
    ANCHOR
        .captures_iter(text)
        .filter_map(|found| {
            let url = web_url(&decode_entities(&found[1]))?;
            let title = decode_entities(&TAG.replace_all(&found[2], ""));
            Some(Link {
                url,
                title: title.trim().to_owned(),
                visits: 1,
            })
        })
        .collect()
}

fn text_field<'a>(object: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
}

fn collect_links(value: &Value, out: &mut Vec<Link>, history: &mut bool, depth: usize) {
    if depth > 64 || out.len() >= 200_000 {
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                collect_links(item, out, history, depth + 1);
            }
        }
        Value::Object(object) => {
            if object.contains_key("password") {
                return;
            }
            if let Some(url) = text_field(object, &URL_KEYS).and_then(web_url) {
                let visits = VISIT_KEYS
                    .iter()
                    .find_map(|key| object.get(*key).and_then(Value::as_u64))
                    .map(|visits| visits.clamp(1, u64::from(u32::MAX)) as u32);
                *history |= visits.is_some();
                out.push(Link {
                    url,
                    title: text_field(object, &TITLE_KEYS)
                        .unwrap_or_default()
                        .trim()
                        .to_owned(),
                    visits: visits.unwrap_or(1),
                });
            }
            for child in object.values() {
                if child.is_array() || child.is_object() {
                    collect_links(child, out, history, depth + 1);
                }
            }
        }
        _ => {}
    }
}

fn parse_json(text: &str) -> Parsed {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Parsed::default();
    };
    let mut parsed = Parsed {
        search_engine: search_engine_of(&value),
        ..Parsed::default()
    };
    collect_links(&value, &mut parsed.links, &mut parsed.is_history, 0);
    parsed
}

/// The default search engine a Chromium browser's `Preferences` file names.
fn search_engine_of(value: &Value) -> Option<SearchEngine> {
    let template = value
        .pointer("/default_search_provider_data/template_url_data/url")?
        .as_str()?;
    let host = url::Url::parse(&template.replace("{searchTerms}", "x"))
        .ok()?
        .host_str()?
        .to_ascii_lowercase();
    engine_for_host(&host)
}

fn engine_for_host(host: &str) -> Option<SearchEngine> {
    let has = |name: &str| host.contains(name);
    if has("duckduckgo") {
        Some(SearchEngine::DuckDuckGo)
    } else if has("brave") {
        Some(SearchEngine::Brave)
    } else if has("ecosia") {
        Some(SearchEngine::Ecosia)
    } else if has("startpage") {
        Some(SearchEngine::Startpage)
    } else if has("yahoo") {
        Some(SearchEngine::Yahoo)
    } else if has("bing") {
        Some(SearchEngine::Bing)
    } else if has("google") {
        Some(SearchEngine::Google)
    } else {
        None
    }
}

/// Splits CSV text into rows of fields: quoted fields may hold commas, quotes (doubled) and line
/// breaks.
fn csv_rows(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, quoted) {
            ('"', true) if chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            ('"', true) => quoted = false,
            ('"', false) if field.is_empty() => quoted = true,
            (',', false) => row.push(std::mem::take(&mut field)),
            ('\r', false) => {}
            ('\n', false) => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn column(header: &[String], names: &[&str]) -> Option<usize> {
    header.iter().position(|cell| {
        let cell = cell.trim().to_ascii_lowercase();
        names.contains(&cell.as_str())
    })
}

fn parse_csv(text: &str) -> Parsed {
    let mut rows = csv_rows(text).into_iter();
    let Some(header) = rows.next() else {
        return Parsed::default();
    };
    let url = column(
        &header,
        &["url", "login_uri", "website", "web site", "origin", "uri"],
    );
    let Some(url) = url else {
        return Parsed::default();
    };
    let title = column(&header, &["name", "title"]);
    let username = column(&header, &["username", "login_username", "login", "user"]);
    let password = column(&header, &["password", "login_password"]);
    let visits = column(&header, &["visit_count", "visitcount", "visits"]);
    let cell = |row: &[String], index: Option<usize>| {
        index
            .and_then(|index| row.get(index))
            .map(|cell| cell.trim().to_owned())
            .unwrap_or_default()
    };
    let mut parsed = Parsed::default();
    for row in rows {
        let Some(address) = web_url(&cell(&row, Some(url))) else {
            continue;
        };
        if let Some(password_column) = password {
            let secret = row.get(password_column).cloned().unwrap_or_default();
            let user = cell(&row, username);
            if secret.is_empty() || user.chars().count() > 500 || secret.chars().count() > 2000 {
                continue;
            }
            parsed.credentials.push(Credential {
                name: cell(&row, title),
                url: address,
                username: user,
                password: zeroize::Zeroizing::new(secret),
            });
        } else {
            let count = cell(&row, visits).parse::<u32>().unwrap_or(1).max(1);
            parsed.is_history |= visits.is_some();
            parsed.links.push(Link {
                url: address,
                title: cell(&row, title),
                visits: count,
            });
        }
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    const NETSCAPE: &str = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><H3>Bar</H3>
<DL><p>
<DT><A HREF="https://www.reddit.com/r/rust/?a=1&amp;b=2" ADD_DATE="1">Rust &amp; <b>things</b></A>
<DT><A HREF="https://news.ycombinator.com/" ADD_DATE="2">Hacker News</A>
<DT><A HREF="place:sort=8">Recent</A>
<DT><A HREF="javascript:alert(1)">x</A>
<DT><A HREF="chrome://settings">Settings</A>
</DL><p>
</DL>"#;

    #[test]
    fn bookmarks_html_gives_web_addresses_with_decoded_names() {
        let parsed = parse(NETSCAPE);
        assert!(!parsed.is_history);
        assert_eq!(parsed.links.len(), 2);
        assert_eq!(
            parsed.links[0].url,
            "https://www.reddit.com/r/rust/?a=1&b=2"
        );
        assert_eq!(parsed.links[0].title, "Rust & things");
    }

    #[test]
    fn chromium_bookmarks_json_is_walked_to_any_depth() {
        let json = r#"{"roots":{"bookmark_bar":{"children":[
            {"type":"folder","name":"f","children":[
              {"type":"url","name":"Wiki","url":"https://en.wikipedia.org/wiki/Rust"}]},
            {"type":"url","name":"Local","url":"http://localhost:3000/"}]}}}"#;
        let parsed = parse(json);
        assert_eq!(parsed.links.len(), 1);
        assert_eq!(parsed.links[0].title, "Wiki");
    }

    #[test]
    fn history_json_carries_visit_counts() {
        let json = r#"{"history":[{"url":"https://github.com/","title":"GitHub","visit_count":40},
            {"url":"https://example.org/x","visitCount":2}]}"#;
        let parsed = parse(json);
        assert!(parsed.is_history);
        assert_eq!(parsed.links[0].visits, 40);
        assert_eq!(parsed.links[1].visits, 2);
    }

    #[test]
    fn a_chromium_preferences_file_names_the_search_engine() {
        let json = r#"{"default_search_provider_data":{"template_url_data":{
            "url":"https://duckduckgo.com/?q={searchTerms}"}}}"#;
        assert_eq!(parse(json).search_engine, Some(SearchEngine::DuckDuckGo));
        assert_eq!(
            engine_for_host("www.google.co.uk"),
            Some(SearchEngine::Google)
        );
        assert_eq!(
            engine_for_host("search.brave.com"),
            Some(SearchEngine::Brave)
        );
        assert_eq!(engine_for_host("kagi.com"), None);
    }

    #[test]
    fn a_passwords_csv_keeps_logins_and_skips_the_rest() {
        let csv = "name,url,username,password,note\n\
            Example,https://example.com/login,me@x.org,\"pa,ss\"\"word\",secret note\n\
            App,android://abc,me,pw,\n\
            Empty,https://empty.example.com,me,,\n";
        let parsed = parse(csv);
        assert!(parsed.links.is_empty());
        assert_eq!(parsed.credentials.len(), 1);
        assert_eq!(parsed.credentials[0].username, "me@x.org");
        assert_eq!(parsed.credentials[0].password.as_str(), "pa,ss\"word");
    }

    #[test]
    fn firefox_safari_and_bitwarden_headers_are_recognized() {
        let firefox = "url,username,password,httpRealm\nhttps://a.example.com,u,p,\n";
        let safari = "Title,URL,Username,Password,Notes,OTPAuth\nA,https://a.example.com,u,p,,\n";
        let bitwarden =
            "folder,login_uri,login_username,login_password\n,https://a.example.com,u,p\n";
        for text in [firefox, safari, bitwarden] {
            assert_eq!(parse(text).credentials.len(), 1, "{text}");
        }
    }

    #[test]
    fn a_quoted_field_may_hold_a_line_break() {
        let csv = "url,username,password\nhttps://a.example.com,u,\"line1\nline2\"\n";
        assert_eq!(parse(csv).credentials[0].password.as_str(), "line1\nline2");
    }

    #[test]
    fn credentials_never_print_their_password() {
        let parsed = parse("url,username,password\nhttps://a.example.com,u,hunter2\n");
        assert!(!format!("{:?}", parsed.credentials).contains("hunter2"));
    }

    #[test]
    fn garbage_is_an_empty_result() {
        for text in ["", "{", "hello world", "\u{feff}", "a,b\n1,2"] {
            let parsed = parse(text);
            assert!(
                parsed.links.is_empty() && parsed.credentials.is_empty(),
                "{text}"
            );
        }
    }

    #[test]
    fn a_password_inside_a_json_object_is_never_read_as_a_link() {
        let json = r#"[{"url":"https://a.example.com","password":"x"}]"#;
        assert!(parse(json).links.is_empty());
    }
}
