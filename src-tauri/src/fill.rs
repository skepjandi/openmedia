//! Filling a saved login into the page in front, on the person's tap.
//!
//! The password is sent to one page only: [`allowed`] compares the login's origin with the page's
//! (a secure page of the same site, or the very same origin), and [`script`] makes the page's own
//! `location.origin` agree again at the moment of the fill, so a page that navigated away between
//! the tap and the fill gets nothing. The script fills two fields and submits nothing
//! (`AGENTS.md` invariant 7), and what it returns holds no value ([`parse_result`]).

use serde_json::Value;
use tauri_plugin_siteview::site::registrable_domain;
use zeroize::Zeroizing;

use crate::error::{Error, Result};

const SCRIPT: &str = include_str!("fill.js");

/// What a secure page's address says about where it is: `scheme://host[:port]` and its site.
pub struct PageOrigin {
    pub origin: String,
    pub site: String,
}

/// The origin of a page, only for a secure (`https`) page with a real host. Anything else gets no
/// password.
pub fn page_origin(address: &str) -> Option<PageOrigin> {
    let url = url::Url::parse(address).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?;
    let site = registrable_domain(host)?;
    Some(PageOrigin {
        origin: url.origin().ascii_serialization(),
        site,
    })
}

/// Whether a login saved for `entry_origin` (site `entry_site`) may be filled into `page`.
pub fn allowed(entry_origin: &str, entry_site: &str, page: &PageOrigin) -> bool {
    entry_origin == page.origin || (entry_origin.starts_with("https://") && entry_site == page.site)
}

/// The expression that fills the page. The values travel as JSON strings, never as code.
pub fn script(
    page: &PageOrigin,
    username: &str,
    password: &Zeroizing<String>,
) -> Result<Zeroizing<String>> {
    let encode = |text: &str| {
        serde_json::to_string(text)
            .map_err(|_| Error::Library("the login could not be filled".into()))
    };
    Ok(Zeroizing::new(format!(
        "({SCRIPT}\n)({},{},{})",
        encode(&page.origin)?,
        encode(username)?,
        Zeroizing::new(encode(password)?).as_str()
    )))
}

/// Which fields the page took.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Filled {
    pub username: bool,
    pub password: bool,
}

/// How many times a fill is tried, a moment apart, for fields a page builds late or shows only
/// after its first step.
pub const ATTEMPTS: u32 = 4;
/// The wait between two tries.
pub const RETRY_AFTER_MS: u64 = 500;

/// Reads the page's answer: which fields it took, and whether it was still on the checked origin.
/// Anything unexpected is "nothing filled, page moved".
pub fn parse_answer(json: &str) -> (Filled, bool) {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(json) else {
        return (Filled::default(), false);
    };
    let flag = |key: &str| map.get(key).and_then(Value::as_bool).unwrap_or(false);
    (
        Filled {
            username: flag("user"),
            password: flag("password"),
        },
        flag("origin"),
    )
}

/// Whether another try is worth making: the page is still where it was and has no password field
/// filled yet.
pub fn should_retry(filled: Filled, on_origin: bool) -> bool {
    on_origin && !filled.password
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(address: &str) -> PageOrigin {
        page_origin(address).unwrap()
    }

    #[test]
    fn only_secure_pages_have_an_origin() {
        assert!(page_origin("http://example.com/").is_none());
        assert!(page_origin("file:///etc/passwd").is_none());
        let p = page("https://accounts.example.com:8443/login?x=1");
        assert_eq!(p.origin, "https://accounts.example.com:8443");
        assert_eq!(p.site, "example.com");
    }

    #[test]
    fn a_login_fills_its_own_origin_or_a_secure_page_of_its_site() {
        let p = page("https://accounts.example.com/");
        assert!(allowed("https://accounts.example.com", "example.com", &p));
        assert!(allowed("https://example.com", "example.com", &p));
        assert!(!allowed("http://example.com", "example.com", &p));
        assert!(!allowed("https://example.org", "example.org", &p));
        assert!(!allowed(
            "https://example.com.evil.org",
            "example.com.evil.org",
            &p
        ));
    }

    #[test]
    fn values_travel_as_json_strings_never_as_code() {
        let p = page("https://example.com/");
        let text = script(&p, "me\"); alert(1); (\"", &Zeroizing::new("p\\w\n".into())).unwrap();
        assert!(text.ends_with(r#"("https://example.com","me\"); alert(1); (\"","p\\w\n")"#));
    }

    #[test]
    fn the_answer_is_flags_and_nothing_else() {
        assert_eq!(
            parse_answer(r#"{"user":true,"password":true,"origin":true}"#),
            (
                Filled {
                    username: true,
                    password: true
                },
                true
            )
        );
        for json in [
            "null",
            "[]",
            "{",
            r#"{"user":"yes","password":1,"origin":"x"}"#,
        ] {
            assert_eq!(parse_answer(json), (Filled::default(), false), "{json}");
        }
    }

    #[test]
    fn a_fill_is_retried_only_on_the_same_page_until_the_password_is_in() {
        let none = Filled::default();
        let user_only = Filled {
            username: true,
            password: false,
        };
        let both = Filled {
            username: true,
            password: true,
        };
        assert!(should_retry(none, true));
        assert!(should_retry(user_only, true));
        assert!(!should_retry(both, true));
        assert!(!should_retry(none, false));
    }
}
