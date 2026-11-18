//! The media sniffer: lists the links, images, videos and audio on the page in front.
//!
//! The script runs through the plugin's Rust-only `evaluate`, so the page is handed no channel to
//! the app, and it only reads the document. What comes back is hostile page data: [`parse`] keeps
//! `http` and `https` addresses of bounded length, a kind from a closed set, and a label with its
//! control characters removed, and drops the rest. A page can at worst fill the list with things
//! the user does not pick.

use serde::Serialize;
use serde_json::Value;
use url::Url;

use super::kind::{Kind, extension_of};

pub const SCRIPT: &str = include_str!("sniff.js");

const MAX_ITEMS: usize = 1000;
const MAX_URL_CHARS: usize = 2048;
const MAX_LABEL_CHARS: usize = 200;
const MAX_TITLE_CHARS: usize = 300;

/// Where the list came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub url: String,
    pub kind: Kind,
    pub label: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sniffed {
    pub page: Page,
    pub items: Vec<Found>,
}

fn clean(text: &str, limit: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn url_extension(url: &Url) -> Option<String> {
    let name = url.path_segments()?.next_back()?;
    extension_of(name).map(str::to_ascii_lowercase)
}

/// What the entry is, or `None` when it is neither a media element's source nor a link to a file
/// the app knows (a link to another web page is not a download).
fn classify(hint: &str, url: &Url) -> Option<Kind> {
    let by_extension = url_extension(url).and_then(|e| Kind::from_extension(&e));
    match hint {
        "image" => Some(by_extension.unwrap_or(Kind::Image)),
        "video" => Some(by_extension.unwrap_or(Kind::Video)),
        "audio" => Some(by_extension.unwrap_or(Kind::Audio)),
        "link" | "resource" => by_extension,
        _ => None,
    }
}

fn dimension(value: Option<&Value>) -> u32 {
    value
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

fn parse_item(item: &Value) -> Option<Found> {
    let url = Url::parse(item.get("u")?.as_str()?).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.as_str().chars().count() > MAX_URL_CHARS {
        return None;
    }
    let kind = classify(item.get("k")?.as_str()?, &url)?;
    Some(Found {
        url: url.into(),
        kind,
        label: clean(
            item.get("t").and_then(Value::as_str).unwrap_or_default(),
            MAX_LABEL_CHARS,
        ),
        width: dimension(item.get("w")),
        height: dimension(item.get("h")),
    })
}

/// Reads what the script returned. Anything unexpected is an empty list.
pub fn parse(json: &str) -> Sniffed {
    let empty = Sniffed {
        page: Page {
            url: String::new(),
            title: String::new(),
        },
        items: Vec::new(),
    };
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(json) else {
        return empty;
    };
    let page_text = |key: &str, limit: usize| {
        root.get("page")
            .and_then(|page| page.get(key))
            .and_then(Value::as_str)
            .map(|text| clean(text, limit))
            .unwrap_or_default()
    };
    let page = Page {
        url: Url::parse(&page_text("url", MAX_URL_CHARS))
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https"))
            .map(String::from)
            .unwrap_or_default(),
        title: page_text("title", MAX_TITLE_CHARS),
    };
    let mut items: Vec<Found> = Vec::new();
    for found in root
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_item)
    {
        // An image the page lists twice (as a tag and as a request) keeps its first, labelled entry.
        match items.iter_mut().find(|known| known.url == found.url) {
            Some(known) => {
                if known.label.is_empty() {
                    known.label = found.label;
                }
                known.width = known.width.max(found.width);
                known.height = known.height.max(found.height);
            }
            None => items.push(found),
        }
        if items.len() >= MAX_ITEMS {
            break;
        }
    }
    Sniffed { page, items }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(items: Value) -> Sniffed {
        parse(
            &json!({"page": {"url": "https://p.example/x", "title": "T"}, "items": items})
                .to_string(),
        )
    }

    #[test]
    fn media_elements_keep_their_kind_and_links_need_a_known_file() {
        let sniffed = run(json!([
            {"u": "https://c.example/image?id=3", "k": "image", "t": " cat ", "w": 640, "h": 480},
            {"u": "https://c.example/page.html", "k": "link", "t": "next"},
            {"u": "https://c.example/report.pdf", "k": "link", "t": "Report"},
            {"u": "https://c.example/blob", "k": "resource"},
            {"u": "https://c.example/clip.webm", "k": "resource"}
        ]));
        let kinds: Vec<_> = sniffed
            .items
            .iter()
            .map(|f| (f.url.as_str(), f.kind))
            .collect();
        assert_eq!(
            kinds,
            [
                ("https://c.example/image?id=3", Kind::Image),
                ("https://c.example/report.pdf", Kind::Document),
                ("https://c.example/clip.webm", Kind::Video),
            ]
        );
        assert_eq!(sniffed.items[0].label, "cat");
        assert_eq!(
            (sniffed.items[0].width, sniffed.items[0].height),
            (640, 480)
        );
    }

    #[test]
    fn hostile_entries_are_dropped() {
        let long = format!("https://a.example/{}.png", "x".repeat(3000));
        let sniffed = run(json!([
            {"u": "javascript:alert(1)", "k": "image"},
            {"u": "file:///etc/passwd", "k": "image"},
            {"u": "data:image/png;base64,AAAA", "k": "image"},
            {"u": long, "k": "image"},
            {"u": "https://a.example/a.png", "k": "script"},
            {"u": 5, "k": "image"},
            {"u": "https://a.example/ok.png", "k": "image", "t": "a\u{0}b\nc", "w": -4, "h": "x"}
        ]));
        assert_eq!(sniffed.items.len(), 1);
        assert_eq!(sniffed.items[0].label, "abc");
        assert_eq!((sniffed.items[0].width, sniffed.items[0].height), (0, 0));
    }

    #[test]
    fn duplicates_merge_and_garbage_is_empty() {
        let sniffed = run(json!([
            {"u": "https://a.example/a.png", "k": "resource"},
            {"u": "https://a.example/a.png", "k": "image", "t": "A", "w": 10, "h": 20}
        ]));
        assert_eq!(sniffed.items.len(), 1);
        assert_eq!(sniffed.items[0].label, "A");
        assert!(parse("not json").items.is_empty());
        assert!(parse("[1,2]").items.is_empty());
    }

    #[test]
    fn a_page_address_that_is_not_http_is_dropped() {
        let sniffed = parse(r#"{"page":{"url":"javascript:1","title":"T"},"items":[]}"#);
        assert_eq!(sniffed.page.url, "");
        assert_eq!(sniffed.page.title, "T");
    }
}
