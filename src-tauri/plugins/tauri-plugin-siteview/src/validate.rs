use std::path::Path;

use url::Url;
use uuid::Uuid;

use crate::{ContentRuleList, Error, Pane, Result};

pub const MAX_BRIDGE_MESSAGE_BYTES: usize = 64 * 1024;
/// The most windows one layout may hold; the shell's layout and the saved ones keep to the same.
pub const MAX_PANES: usize = 8;
pub const MAX_RULE_LISTS: usize = 8;
pub const MAX_EVALUATE_SCRIPT_BYTES: usize = 128 * 1024;
pub const MAX_EVALUATE_RESULT_BYTES: usize = 200_000;
const MAX_RULE_LIST_ID_CHARS: usize = 64;
pub const MAX_NOTIFICATION_TITLE_CHARS: usize = 40;
pub const MAX_NOTIFICATION_BODY_CHARS: usize = 120;
pub const MAX_AUTH_REASON_CHARS: usize = 120;
pub const MAX_SHARE_TITLE_CHARS: usize = 200;

pub fn parse_web_url(input: &str) -> Result<Url> {
    let url = Url::parse(input).map_err(|e| Error::InvalidUrl(e.to_string()))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err(Error::UnsupportedScheme),
    }
}

pub fn parse_profile_id(input: &str) -> Result<Uuid> {
    Uuid::parse_str(input).map_err(|_| Error::InvalidProfile)
}

/// Session ids come from the shell; they are UUIDs so they are safe to log and to use as map keys.
pub fn parse_session_id(input: &str) -> Result<Uuid> {
    Uuid::parse_str(input).map_err(|_| Error::InvalidSession)
}

/// Notification text comes from the shell, which builds it from a favorite's name and a fixed
/// phrase; the limits keep it to that and out of control characters.
pub fn validate_notification_text(title: &str, body: &str) -> Result<()> {
    let fits = |text: &str, max: usize| {
        let length = text.chars().count();
        (1..=max).contains(&length) && !text.chars().any(char::is_control)
    };
    if fits(title, MAX_NOTIFICATION_TITLE_CHARS) && fits(body, MAX_NOTIFICATION_BODY_CHARS) {
        Ok(())
    } else {
        Err(Error::InvalidNotification(MAX_NOTIFICATION_BODY_CHARS))
    }
}

pub fn parse_bridge_body(body: &str) -> Result<serde_json::Value> {
    if body.len() > MAX_BRIDGE_MESSAGE_BYTES {
        return Err(Error::BridgeMessageTooLarge(MAX_BRIDGE_MESSAGE_BYTES));
    }
    serde_json::from_str(body).map_err(|_| Error::BridgeMessageInvalid)
}

/// Wraps a script expression so the page side returns its value as JSON text. The newlines stop a
/// trailing `//` comment from swallowing the closing parenthesis; trailing semicolons are dropped.
pub fn wrap_evaluate_script(script: &str) -> Result<String> {
    let expression = script.trim().trim_end_matches(';').trim_end();
    if expression.is_empty() || expression.len() > MAX_EVALUATE_SCRIPT_BYTES {
        return Err(Error::InvalidScript(MAX_EVALUATE_SCRIPT_BYTES));
    }
    Ok(format!("JSON.stringify(\n{expression}\n)"))
}

/// The page's answer is hostile data: bounded in size here (the native side caps it too) and
/// required to be JSON, so callers only ever parse text that is well formed.
pub fn check_evaluate_result(json: String) -> Result<String> {
    if json.len() > MAX_EVALUATE_RESULT_BYTES {
        return Err(Error::EvaluateResultTooLarge(MAX_EVALUATE_RESULT_BYTES));
    }
    if serde_json::from_str::<serde::de::IgnoredAny>(&json).is_err() {
        return Err(Error::BridgeMessageInvalid);
    }
    Ok(json)
}

/// A color as `#rrggbb` in lowercase: the only shape a sampled or page-reported color may take.
pub fn is_color_hex(text: &str) -> bool {
    text.len() == 7
        && text.starts_with('#')
        && text[1..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The text of the system's authentication prompt: short, one line, and not blank.
pub fn check_auth_reason(reason: &str) -> Result<&str> {
    let reason = reason.trim();
    let length = reason.chars().count();
    if length == 0 || length > MAX_AUTH_REASON_CHARS || reason.chars().any(char::is_control) {
        return Err(Error::InvalidAuthReason(MAX_AUTH_REASON_CHARS));
    }
    Ok(reason)
}

/// The title offered with a shared address: short and one line, or none.
pub fn check_share_title(title: Option<&str>) -> Result<Option<&str>> {
    let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) else {
        return Ok(None);
    };
    if title.chars().count() > MAX_SHARE_TITLE_CHARS || title.chars().any(char::is_control) {
        return Err(Error::InvalidShareTitle(MAX_SHARE_TITLE_CHARS));
    }
    Ok(Some(title))
}

/// A registrable domain in lowercase: dot separated labels of letters, digits and hyphens.
pub fn check_site(site: &str) -> Result<&str> {
    let labels_ok = site.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    });
    if site.contains('.') && site.len() <= 253 && labels_ok {
        Ok(site)
    } else {
        Err(Error::InvalidSite)
    }
}

/// Rule lists come from Rust, never from a page, but the native side reads `path` and hands it to
/// WebKit, so the shape is checked here anyway: a short id from a safe alphabet and an absolute
/// path to a `.json` file.
pub fn validate_rule_lists(lists: &[ContentRuleList]) -> Result<()> {
    if lists.len() > MAX_RULE_LISTS {
        return Err(Error::InvalidRuleList);
    }
    for list in lists {
        let id_ok = !list.id.is_empty()
            && list.id.len() <= MAX_RULE_LIST_ID_CHARS
            && list
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.');
        let path = Path::new(&list.path);
        let path_ok = path.is_absolute() && path.extension().is_some_and(|e| e == "json");
        if !id_ok || !path_ok {
            return Err(Error::InvalidRuleList);
        }
    }
    Ok(())
}

/// A layout comes from the shell, and each window's session is a key into the open sessions, so
/// the shape is checked: a bounded number of windows, each of a known session, none twice, each
/// with a finite rectangle.
pub fn validate_layout(panes: &[Pane]) -> Result<()> {
    if panes.len() > MAX_PANES {
        return Err(Error::InvalidLayout);
    }
    for (index, pane) in panes.iter().enumerate() {
        parse_session_id(&pane.session)?;
        let rect = pane.rect;
        let finite = [rect.x, rect.y, rect.width, rect.height]
            .iter()
            .all(|value| value.is_finite());
        let repeated = panes[..index]
            .iter()
            .any(|earlier| earlier.session == pane.session);
        if !finite || repeated {
            return Err(Error::InvalidLayout);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Rect;

    #[test]
    fn notification_text_is_short_and_plain() {
        assert!(validate_notification_text("Messenger", "New activity").is_ok());
        assert!(validate_notification_text("", "New activity").is_err());
        assert!(validate_notification_text("Messenger", "").is_err());
        assert!(validate_notification_text(&"a".repeat(41), "New activity").is_err());
        assert!(validate_notification_text("Messenger", &"a".repeat(121)).is_err());
        assert!(validate_notification_text("Mess\nenger", "New activity").is_err());
        assert!(validate_notification_text("ماسنجر", "نشاط جديد").is_ok());
    }

    fn pane(session: &str, width: f64) -> Pane {
        Pane {
            session: session.to_owned(),
            rect: Rect {
                x: 0.0,
                y: 0.0,
                width,
                height: 100.0,
            },
        }
    }

    #[test]
    fn a_layout_holds_a_few_windows_of_known_sessions() {
        let a = "6f1e2d3c-1111-4222-8333-444455556666";
        let b = "6f1e2d3c-1111-4222-8333-444455556667";
        assert!(validate_layout(&[]).is_ok());
        assert!(validate_layout(&[pane(a, 100.0), pane(b, 200.0)]).is_ok());
    }

    #[test]
    fn a_layout_refuses_a_bad_session_a_repeat_or_a_rectangle_that_is_not_a_number() {
        let a = "6f1e2d3c-1111-4222-8333-444455556666";
        assert!(validate_layout(&[pane("not-a-session", 100.0)]).is_err());
        assert!(validate_layout(&[pane(a, 100.0), pane(a, 100.0)]).is_err());
        assert!(validate_layout(&[pane(a, f64::NAN)]).is_err());
        assert!(validate_layout(&[pane(a, f64::INFINITY)]).is_err());
    }

    #[test]
    fn a_layout_has_a_limit_on_windows() {
        let many: Vec<Pane> = (0..=MAX_PANES)
            .map(|n| pane(&format!("6f1e2d3c-1111-4222-8333-44445555666{n}"), 10.0))
            .collect();
        assert!(validate_layout(&many).is_err());
        assert!(validate_layout(&many[..MAX_PANES]).is_ok());
    }

    #[test]
    fn accepts_http_and_https() {
        assert!(parse_web_url("https://www.instagram.com/").is_ok());
        assert!(parse_web_url("http://example.com/a?b=1").is_ok());
    }

    #[test]
    fn rejects_non_web_schemes() {
        for input in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,hi",
            "ipc://localhost/x",
            "tauri://localhost",
        ] {
            assert!(
                matches!(parse_web_url(input), Err(Error::UnsupportedScheme)),
                "{input}"
            );
        }
    }

    #[test]
    fn rejects_garbage_and_empty_hosts() {
        for input in ["not a url", "http://", "https://:443/"] {
            assert!(
                matches!(parse_web_url(input), Err(Error::InvalidUrl(_))),
                "{input}"
            );
        }
    }

    #[test]
    fn profile_ids_must_be_uuids() {
        assert!(parse_profile_id("6f1a1c1e-0000-4000-8000-00000000000a").is_ok());
        assert!(matches!(
            parse_profile_id("../../etc"),
            Err(Error::InvalidProfile)
        ));
    }

    #[test]
    fn session_ids_must_be_uuids() {
        assert!(parse_session_id("6f1a1c1e-0000-4000-8000-00000000000a").is_ok());
        assert!(matches!(
            parse_session_id("main"),
            Err(Error::InvalidSession)
        ));
    }

    fn list(id: &str, path: &str) -> ContentRuleList {
        ContentRuleList {
            id: id.to_owned(),
            path: path.to_owned(),
        }
    }

    #[test]
    fn rule_lists_need_a_safe_id_and_an_absolute_json_path() {
        assert!(
            validate_rule_lists(&[list("openmedia-easylist-1a2b", "/data/x/easylist.json")])
                .is_ok()
        );
        assert!(validate_rule_lists(&[]).is_ok());
        for bad in [
            list("", "/data/x.json"),
            list("has space", "/data/x.json"),
            list("../escape", "/data/x.json"),
            list(&"a".repeat(65), "/data/x.json"),
            list("ok", "relative/x.json"),
            list("ok", "/data/x.txt"),
            list("ok", "/data/x"),
        ] {
            assert!(
                matches!(
                    validate_rule_lists(std::slice::from_ref(&bad)),
                    Err(Error::InvalidRuleList)
                ),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn rule_lists_are_capped() {
        let many = vec![list("ok", "/data/x.json"); MAX_RULE_LISTS + 1];
        assert!(matches!(
            validate_rule_lists(&many),
            Err(Error::InvalidRuleList)
        ));
    }

    #[test]
    fn bridge_body_is_size_capped_and_must_be_json() {
        assert_eq!(
            parse_bridge_body(r#"{"a":1}"#).unwrap(),
            serde_json::json!({"a": 1})
        );
        assert!(matches!(
            parse_bridge_body("{oops"),
            Err(Error::BridgeMessageInvalid)
        ));
        let huge = format!("\"{}\"", "x".repeat(MAX_BRIDGE_MESSAGE_BYTES));
        assert!(matches!(
            parse_bridge_body(&huge),
            Err(Error::BridgeMessageTooLarge(_))
        ));
    }

    #[test]
    fn evaluate_script_is_wrapped_as_json_stringify() {
        assert_eq!(
            wrap_evaluate_script(" 1 + 1 ;; ").unwrap(),
            "JSON.stringify(\n1 + 1\n)"
        );
        // a trailing line comment cannot swallow the closing parenthesis
        assert!(wrap_evaluate_script("x // note").unwrap().ends_with("\n)"));
        assert!(matches!(
            wrap_evaluate_script("  ; "),
            Err(Error::InvalidScript(_))
        ));
        let huge = "1".repeat(MAX_EVALUATE_SCRIPT_BYTES + 1);
        assert!(matches!(
            wrap_evaluate_script(&huge),
            Err(Error::InvalidScript(_))
        ));
    }

    #[test]
    fn the_prompt_reason_is_one_short_line() {
        assert_eq!(
            check_auth_reason("  Unlock incognito ").unwrap(),
            "Unlock incognito"
        );
        for bad in [
            "",
            "   ",
            "two\nlines",
            &"x".repeat(MAX_AUTH_REASON_CHARS + 1),
        ] {
            assert!(
                matches!(check_auth_reason(bad), Err(Error::InvalidAuthReason(_))),
                "{bad:?}"
            );
        }
        assert!(check_auth_reason(&"é".repeat(MAX_AUTH_REASON_CHARS)).is_ok());
    }

    #[test]
    fn a_color_is_seven_lowercase_hex_characters() {
        assert!(is_color_hex("#0a1b2c"));
        for bad in [
            "#0A1B2C", "#0a1b2", "#0a1b2c3", "0a1b2c1", "#0a1b2g", "", "#é12345",
        ] {
            assert!(!is_color_hex(bad), "{bad}");
        }
    }

    #[test]
    fn evaluate_result_is_capped_and_must_be_json() {
        assert_eq!(check_evaluate_result("[1,2]".into()).unwrap(), "[1,2]");
        assert!(matches!(
            check_evaluate_result("{nope".into()),
            Err(Error::BridgeMessageInvalid)
        ));
        let huge = format!("\"{}\"", "x".repeat(MAX_EVALUATE_RESULT_BYTES));
        assert!(matches!(
            check_evaluate_result(huge),
            Err(Error::EvaluateResultTooLarge(_))
        ));
        let edge = format!("\"{}\"", "x".repeat(MAX_EVALUATE_RESULT_BYTES - 2));
        assert!(check_evaluate_result(edge).is_ok());
    }

    #[test]
    fn a_share_title_is_optional_short_and_one_line() {
        assert_eq!(check_share_title(None).unwrap(), None);
        assert_eq!(check_share_title(Some("  ")).unwrap(), None);
        assert_eq!(check_share_title(Some(" Page ")).unwrap(), Some("Page"));
        for bad in ["two\nlines", &"x".repeat(MAX_SHARE_TITLE_CHARS + 1)] {
            assert!(matches!(
                check_share_title(Some(bad)),
                Err(Error::InvalidShareTitle(_))
            ));
        }
    }

    #[test]
    fn a_site_to_clear_is_a_plain_lowercase_domain() {
        assert_eq!(check_site("example.co.uk").unwrap(), "example.co.uk");
        for bad in [
            "",
            "example",
            "Example.com",
            "a..com",
            "-a.com",
            "a.com/",
            "a.com:80",
            "é.com",
        ] {
            assert!(matches!(check_site(bad), Err(Error::InvalidSite)), "{bad}");
        }
    }
}
