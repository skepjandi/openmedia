//! Pictures for the page media picker. The shell may not load remote images, so Rust fetches one,
//! checks that it really is an image of a kind an `<img>` shows safely, and hands back a data address.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use reqwest::header;
use url::Url;

use crate::error::Result;

/// Larger pictures are not previewed: the list would fill with megabytes.
pub const MAX_BYTES: usize = 2 << 20;
const TIMEOUT: Duration = Duration::from_secs(15);
const MIMES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "image/svg+xml",
];

fn allowed_mime(content_type: &str) -> Option<&'static str> {
    let essence = content_type.split(';').next().unwrap_or_default().trim();
    MIMES
        .iter()
        .copied()
        .find(|m| m.eq_ignore_ascii_case(essence))
}

/// `Ok(None)` for anything that is not a small, allowed image; a connection failure is also `None`,
/// since a missing preview is not an error worth showing.
pub async fn fetch(
    client: &reqwest::Client,
    url: &str,
    page: Option<&str>,
) -> Result<Option<String>> {
    let Some(url) = Url::parse(url)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
    else {
        return Ok(None);
    };
    let mut request = client.get(url).timeout(TIMEOUT);
    if let Some(origin) = page
        .and_then(|p| Url::parse(p).ok())
        .map(|p| format!("{}/", p.origin().ascii_serialization()))
    {
        request = request.header(header::REFERER, origin);
    }
    let Ok(mut response) = request.send().await else {
        return Ok(None);
    };
    let mime = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(allowed_mime);
    let (true, Some(mime)) = (response.status().is_success(), mime) else {
        return Ok(None);
    };
    if response
        .content_length()
        .is_some_and(|len| len > MAX_BYTES as u64)
    {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(bytes)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_image_types_an_img_tag_shows_are_allowed() {
        assert_eq!(allowed_mime("Image/PNG; charset=x"), Some("image/png"));
        assert_eq!(allowed_mime("image/svg+xml"), Some("image/svg+xml"));
        assert_eq!(allowed_mime("text/html"), None);
        assert_eq!(allowed_mime("image/x-icon"), None);
    }
}
