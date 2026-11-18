//! A site's icon, fetched from the site itself and returned as a small PNG `data:` URL. Nothing
//! goes through a third-party icon service: the only host contacted is the page's own domain,
//! including after a redirect.

use std::{io::Cursor, time::Duration};

use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader, imageops::FilterType};
use url::Url;

use crate::site::site_of_host;

const MAX_BYTES: u64 = 400_000;
const MAX_CANDIDATES: usize = 6;
const MAX_REDIRECTS: usize = 3;
const MAX_SIDE: u32 = 4096;
const OUTPUT_SIDE: u32 = 96;
const TIMEOUT: Duration = Duration::from_secs(8);

fn scope_of(url: &Url) -> Option<String> {
    url.host_str().map(site_of_host)
}

/// The icon for `page`, or `None` when the site offers none that decodes.
pub fn fetch(page: &Url) -> Option<String> {
    let scope = scope_of(page)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    let mut candidates = Vec::new();
    if let Some(html) = get(&agent, page, &scope) {
        candidates.extend(icon_links(&String::from_utf8_lossy(&html), page));
    }
    for path in ["/apple-touch-icon.png", "/favicon.ico"] {
        candidates.extend(page.join(path).ok());
    }
    let mut tried = Vec::new();
    for url in candidates {
        if tried.len() >= MAX_CANDIDATES || tried.contains(&url) {
            continue;
        }
        tried.push(url.clone());
        if let Some(png) = get(&agent, &url, &scope).and_then(|bytes| to_png(&bytes)) {
            return Some(format!("data:image/png;base64,{}", STANDARD.encode(png)));
        }
    }
    None
}

/// A GET that stays on the page's domain, follows a few redirects and refuses large bodies.
fn get(agent: &ureq::Agent, url: &Url, scope: &str) -> Option<Vec<u8>> {
    let mut url = url.clone();
    for _ in 0..=MAX_REDIRECTS {
        if !matches!(url.scheme(), "http" | "https") || scope_of(&url).as_deref() != Some(scope) {
            return None;
        }
        let mut response = agent.get(url.as_str()).call().ok()?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            let location = response.headers().get("location")?.to_str().ok()?;
            url = url.join(location).ok()?;
            continue;
        }
        if status != 200 {
            return None;
        }
        return response
            .body_mut()
            .with_config()
            .limit(MAX_BYTES)
            .read_to_vec()
            .ok();
    }
    None
}

/// Decodes any common icon format and redraws it as a square PNG.
fn to_png(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() <= 100 {
        return None;
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let (width, height) = reader.into_dimensions().ok()?;
    if width > MAX_SIDE || height > MAX_SIDE {
        return None;
    }
    let image = image::load_from_memory(bytes).ok()?;
    let resized = image.resize_exact(OUTPUT_SIDE, OUTPUT_SIDE, FilterType::Lanczos3);
    let mut png = Vec::new();
    resized
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .ok()?;
    Some(png)
}

/// `<link rel="...icon..." href="...">` targets, touch icons first (they are larger).
fn icon_links(html: &str, base: &Url) -> Vec<Url> {
    let lower = html.to_ascii_lowercase();
    let (mut touch, mut plain) = (Vec::new(), Vec::new());
    let mut from = 0;
    while let Some(start) = lower[from..].find("<link") {
        let start = from + start;
        let end = lower[start..]
            .find('>')
            .map_or(lower.len(), |end| start + end);
        from = end.max(start + 1);
        let tag = &html[start..end];
        let (Some(rel), Some(href)) = (attribute(tag, "rel"), attribute(tag, "href")) else {
            continue;
        };
        let rel = rel.to_ascii_lowercase();
        let Ok(url) = base.join(&href) else { continue };
        if rel.contains("apple-touch-icon") {
            touch.push(url);
        } else if rel.contains("icon") {
            plain.push(url);
        }
    }
    touch.extend(plain);
    touch
}

/// The value of `name="..."` (or single-quoted) in a tag, matched on a word boundary.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let at = from + found;
        from = at + name.len();
        let boundary = lower[..at]
            .chars()
            .next_back()
            .is_none_or(|c| c.is_whitespace() || c == '<' || c == '"' || c == '\'');
        let rest = lower[from..].trim_start();
        if !boundary || !rest.starts_with('=') {
            continue;
        }
        let value_at = tag.len() - lower[from..].trim_start()[1..].trim_start().len();
        let quote = tag[value_at..].chars().next()?;
        if quote != '"' && quote != '\'' {
            continue;
        }
        let value = &tag[value_at + 1..];
        return value.find(quote).map(|end| value[..end].to_owned());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://www.example.com/a/b").unwrap()
    }

    #[test]
    fn touch_icons_come_before_plain_ones_and_urls_resolve() {
        let html = r#"<head><LINK rel="shortcut icon" href="/f.ico">
            <link href='/touch.png' rel='apple-touch-icon'><link rel="stylesheet" href="/s.css"></head>"#;
        let links: Vec<String> = icon_links(html, &base())
            .iter()
            .map(Url::to_string)
            .collect();
        assert_eq!(
            links,
            [
                "https://www.example.com/touch.png",
                "https://www.example.com/f.ico"
            ]
        );
    }

    #[test]
    fn an_attribute_is_matched_whole() {
        assert_eq!(
            attribute(r#"<link data-rel="x" rel="icon">"#, "rel").as_deref(),
            Some("icon")
        );
        assert_eq!(attribute(r#"<link rel=icon>"#, "rel"), None);
    }

    #[test]
    fn a_picture_becomes_a_square_png() {
        let source = image::RgbaImage::from_pixel(30, 20, image::Rgba([200, 30, 30, 255]));
        let mut encoded = Vec::new();
        image::DynamicImage::ImageRgba8(source)
            .write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)
            .unwrap();
        let png = to_png(&encoded).unwrap();
        let decoded = image::load_from_memory(&png).unwrap();
        assert_eq!(
            (decoded.width(), decoded.height()),
            (OUTPUT_SIDE, OUTPUT_SIDE)
        );
        assert_eq!(to_png(b"not an image, but long enough to pass the size check ........................................................................"), None);
    }
}
