//! The only code that talks to the sharing service (our Cloudflare Worker). It is built to
//! distrust it: HTTPS only, no redirects, no cookies, every response size-capped and parsed
//! strictly, and errors that are sentences written here, never what the service said.

use std::{net::IpAddr, time::Duration};

use reqwest::{Client, Response, StatusCode, redirect::Policy};
use serde::Deserialize;
use url::{Host, Url};

use super::messages;
use crate::error::{Error, Result};

const SHARE_URL: Option<&str> = option_env!("OPENMEDIA_SHARE_URL");
const MAX_REPLY_BYTES: usize = 8 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
const HEADER_POLL_TOKEN: &str = "X-Poll-Token";
const HEADER_REMEMBER_TOKEN: &str = "X-Remember-Token";

pub struct Worker {
    base: Url,
    http: Client,
}

/// What the service answers to a new share, checked: the id and poll token have the shape the
/// service issues, and the login address (if any) is on the service's own origin. There is no
/// login address when the service recognised the remember token: nobody needs to sign in.
#[derive(Debug)]
pub struct Created {
    pub id: String,
    pub poll_token: String,
    pub login_url: Option<Url>,
}

/// The service's answer about a share, before `super` turns it into what the shell sees.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub state: Option<String>,
    pub pr_url: Option<String>,
    pub login: Option<String>,
    pub error_code: Option<String>,
    /// Handed over once, with the first answer after a sign-in.
    pub remember_token: Option<String>,
}

#[derive(Debug)]
pub enum Polled {
    Reply(Reply),
    /// The service no longer knows this share, or refused its poll token.
    Gone,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCreated {
    id: String,
    poll_token: String,
    login_url: Option<String>,
}

impl Worker {
    /// The service this build was configured for, if any.
    pub fn from_build() -> Option<Self> {
        SHARE_URL
            .filter(|url| !url.is_empty())
            .and_then(|url| Self::new(url).ok())
    }

    pub fn new(base: &str) -> Result<Self> {
        let base = checked_base(base)?;
        let http = Client::builder()
            .timeout(TIMEOUT)
            // A redirect could send a request, or what it carries, to another host.
            .redirect(Policy::none())
            .https_only(!is_loopback(&base))
            .user_agent("OpenMedia")
            .build()
            .map_err(|_| Error::Share(messages::FAILED.into()))?;
        Ok(Self { base, http })
    }

    /// `remember` is the token from an earlier sign-in; the service may then skip the sign-in.
    pub async fn create(&self, body: Vec<u8>, remember: Option<&str>) -> Result<Created> {
        let mut request = self
            .http
            .post(self.endpoint("v1/shares")?)
            .header("content-type", "application/json")
            .body(body);
        if let Some(token) = remember {
            request = request.header(HEADER_REMEMBER_TOKEN, token);
        }
        let response = request.send().await.map_err(unreachable)?;
        let bytes = read_capped(checked(response)?, MAX_REPLY_BYTES).await?;
        let wire: WireCreated = serde_json::from_slice(&bytes).map_err(unexpected)?;
        if !is_token(&wire.id, 22, 64) || !is_token(&wire.poll_token, 43, 43) {
            return Err(unexpected(()));
        }
        let login_url = wire
            .login_url
            .map(|text| {
                let url = Url::parse(&text).map_err(unexpected)?;
                if url.origin() != self.base.origin() || !url.username().is_empty() {
                    return Err(unexpected(()));
                }
                Ok(url)
            })
            .transpose()?;
        Ok(Created {
            id: wire.id,
            poll_token: wire.poll_token,
            login_url,
        })
    }

    pub async fn poll(&self, id: &str, poll_token: &str) -> Result<Polled> {
        if !is_token(id, 22, 64) {
            return Ok(Polled::Gone);
        }
        let request = self
            .http
            .get(self.endpoint(&format!("v1/shares/{id}"))?)
            .header(HEADER_POLL_TOKEN, poll_token);
        let response = request.send().await.map_err(unreachable)?;
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::NOT_FOUND
        ) {
            return Ok(Polled::Gone);
        }
        let bytes = read_capped(checked(response)?, MAX_REPLY_BYTES).await?;
        serde_json::from_slice(&bytes)
            .map(Polled::Reply)
            .map_err(unexpected)
    }

    /// Asks the service to forget a remember token. The answer says nothing about the token.
    pub async fn forget(&self, token: &str) -> Result<()> {
        let response = self
            .http
            .delete(self.endpoint("v1/remember")?)
            .header(HEADER_REMEMBER_TOKEN, token)
            .send()
            .await
            .map_err(unreachable)?;
        checked(response).map(drop)
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.base
            .join(path)
            .map_err(|_| Error::Share(messages::FAILED.into()))
    }
}

/// Ids and poll tokens are URL-safe random strings.
pub(super) fn is_token(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// HTTPS, a host, nothing else in the address. Plain HTTP only to this machine, and only in a
/// debug build, so a local `wrangler dev` can be tried.
fn checked_base(text: &str) -> Result<Url> {
    let url = Url::parse(text).map_err(|_| Error::Share(messages::UNAVAILABLE.into()))?;
    let plain_ok = cfg!(debug_assertions) && url.scheme() == "http" && is_loopback(&url);
    let clean = url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == "/";
    if clean && (url.scheme() == "https" || plain_ok) {
        Ok(url)
    } else {
        Err(Error::Share(messages::UNAVAILABLE.into()))
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain == "localhost",
        Some(Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        None => false,
    }
}

/// Maps a status to a sentence written here, never to what the service said.
fn checked(response: Response) -> Result<Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    Err(Error::Share(
        match status {
            StatusCode::BAD_REQUEST => messages::REFUSED,
            StatusCode::TOO_MANY_REQUESTS => messages::BUSY,
            _ => messages::UNAVAILABLE,
        }
        .into(),
    ))
}

async fn read_capped(mut response: Response, max: usize) -> Result<Vec<u8>> {
    let too_large = || unexpected(());
    if response
        .content_length()
        .is_some_and(|length| length > max as u64)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(unreachable)? {
        if body.len() + chunk.len() > max {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn unreachable(_: reqwest::Error) -> Error {
    Error::Share(messages::OFFLINE.into())
}

fn unexpected<E>(_: E) -> Error {
    Error::Share(messages::UNAVAILABLE.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_bare_https_address_is_accepted() {
        assert!(Worker::new("https://share.openmedia.surf").is_ok());
        for bad in [
            "http://share.openmedia.surf",
            "https://share.openmedia.surf/v1",
            "https://user@share.openmedia.surf",
            "https://share.openmedia.surf/?a=1",
            "ftp://share.openmedia.surf",
            "share.openmedia.surf",
        ] {
            assert!(Worker::new(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn plain_http_is_for_this_machine_only() {
        assert_eq!(
            Worker::new("http://127.0.0.1:8787").is_ok(),
            cfg!(debug_assertions)
        );
        assert_eq!(
            Worker::new("http://localhost:8787").is_ok(),
            cfg!(debug_assertions)
        );
        assert!(Worker::new("http://192.168.1.5:8787").is_err());
    }

    #[test]
    fn tokens_have_the_shape_the_service_issues() {
        assert!(is_token(&"a".repeat(22), 22, 64));
        assert!(!is_token(&"a".repeat(21), 22, 64));
        assert!(!is_token("../etc/passwd/xxxxxxxxxxxxxxxx", 22, 64));
    }
}
