//! The only code that talks to the marketplace. It is built to distrust the server: HTTPS only,
//! no redirects, no cookies, every response size-capped, and errors that never repeat what the
//! server said. What it returns is checked by `index` before anything uses it.

use std::{collections::BTreeMap, net::IpAddr, time::Duration};

use reqwest::{Client, Method, Response, StatusCode, redirect::Policy};
use serde::{Deserialize, Serialize};
use url::{Host, Url};

use super::community::{
    self, CommentsReply, MAX_STARS, MIN_STARS, RatingSummary, RatingsReply, WireComment,
};
use super::index::{Entry, Index, MAX_INDEX_BYTES, TrustedKey, verify};
use crate::error::{Error, Result};
use crate::recipes::{self, Recipe};

const MARKET_URL: Option<&str> = option_env!("OPENMEDIA_MARKET_URL");
const CATALOG_KEYS: Option<&str> = option_env!("OPENMEDIA_CATALOG_KEYS");
const MAX_SIGNATURE_BYTES: usize = 1024;
const MAX_STATS_BYTES: usize = 256 * 1024;
const MAX_REPLY_BYTES: usize = 4 * 1024;
const MAX_COMMENTS_BYTES: usize = 128 * 1024;
const HEADER_PRO_USER: &str = "X-Pro-User";
const HEADER_DEVICE_TOKEN: &str = "X-Device-Token";
const HEADER_CLIENT: &str = "X-Client";
const MAX_PRO_USER_CHARS: usize = 100;
const MIN_PRO_USER_CHARS: usize = 8;
const TIMEOUT: Duration = Duration::from_secs(15);

pub struct Market {
    base: Url,
    keys: Vec<TrustedKey>,
    http: Client,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportReason {
    Harmful,
    Broken,
    Misleading,
    Spam,
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Submitted {
    pub submission_id: String,
    pub edit_token: Option<String>,
}

/// The RevenueCat app user id, checked against the shape the Worker accepts before it can be put
/// in a header. It is only ever sent on Pro-gated actions.
#[derive(Clone, PartialEq, Eq)]
pub struct ProUser(String);

impl ProUser {
    pub fn new(app_user_id: &str) -> Result<Self> {
        let body = app_user_id.strip_prefix('$').unwrap_or(app_user_id);
        let well_formed = (MIN_PRO_USER_CHARS..=MAX_PRO_USER_CHARS).contains(&app_user_id.len())
            && !body.is_empty()
            && body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'));
        if well_formed {
            Ok(Self(app_user_id.to_owned()))
        } else {
            Err(Error::Catalog(
                "this device's subscription could not be identified".into(),
            ))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

// The id is a credential-like identifier: it must never reach a log through `{:?}`.
impl std::fmt::Debug for ProUser {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProUser(..)")
    }
}

/// One request to the marketplace, built without touching the network so tests can read exactly
/// what would be sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub method: Method,
    pub path: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<Vec<u8>>,
}

impl Call {
    fn new(method: Method, path: impl Into<String>) -> Self {
        Self {
            method,
            path: path.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    fn header(mut self, name: &'static str, value: &str) -> Self {
        self.headers.push((name, value.to_owned()));
        self
    }

    fn json(mut self, body: &serde_json::Value) -> Result<Self> {
        self.body = Some(serde_json::to_vec(body)?);
        Ok(self)
    }
}

pub fn submit_call(
    recipe: &Recipe,
    summary: &str,
    edit_token: Option<&str>,
    pro: &ProUser,
) -> Result<Call> {
    let mut body = serde_json::json!({ "recipe": recipe, "summary": summary });
    if let (Some(token), Some(object)) = (edit_token, body.as_object_mut()) {
        object.insert("editToken".into(), token.into());
    }
    Call::new(Method::POST, "v1/submissions")
        .header(HEADER_PRO_USER, pro.as_str())
        .json(&body)
}

/// A rating carries the device token and says it comes from the app; never the Pro id.
pub fn rating_call(id: &str, stars: u8, device_token: &str) -> Result<Call> {
    if !(MIN_STARS..=MAX_STARS).contains(&stars) {
        return Err(Error::Catalog("a rating is 1 to 5 stars".into()));
    }
    if !community::is_device_token(device_token) {
        return Err(Error::Catalog("this device has no valid token".into()));
    }
    Call::new(Method::POST, format!("{}/rating", recipe_base(id)?))
        .header(HEADER_DEVICE_TOKEN, device_token)
        .header(HEADER_CLIENT, "app")
        .json(&serde_json::json!({ "stars": stars }))
}

pub fn comments_call(id: &str) -> Result<Call> {
    Ok(Call::new(
        Method::GET,
        format!("{}/comments.json", recipe_base(id)?),
    ))
}

pub fn post_comment_call(id: &str, text: &str, pro: &ProUser) -> Result<Call> {
    Call::new(Method::POST, format!("{}/comments", recipe_base(id)?))
        .header(HEADER_PRO_USER, pro.as_str())
        .json(&serde_json::json!({ "text": text }))
}

pub fn delete_comment_call(comment_id: &str, pro: &ProUser) -> Result<Call> {
    Ok(Call::new(Method::DELETE, comment_path(comment_id, "")?)
        .header(HEADER_PRO_USER, pro.as_str()))
}

/// Reporting uses the device token, so no Pro id leaves the device for it.
pub fn report_comment_call(comment_id: &str, device_token: &str) -> Result<Call> {
    if !community::is_device_token(device_token) {
        return Err(Error::Catalog("this device has no valid token".into()));
    }
    Ok(
        Call::new(Method::POST, comment_path(comment_id, "/report")?)
            .header(HEADER_DEVICE_TOKEN, device_token),
    )
}

fn recipe_base(id: &str) -> Result<String> {
    if recipes::is_catalog_id(id) {
        Ok(format!("v1/recipes/{id}"))
    } else {
        Err(Error::Catalog("not a marketplace id".into()))
    }
}

fn comment_path(comment_id: &str, tail: &str) -> Result<String> {
    if community::is_comment_id(comment_id) {
        Ok(format!("v1/comments/{comment_id}{tail}"))
    } else {
        Err(Error::Catalog("not a comment".into()))
    }
}

impl Market {
    /// The marketplace this build was configured for, or `MarketplaceNotConfigured`.
    pub fn from_build() -> Result<Self> {
        match (MARKET_URL, CATALOG_KEYS) {
            (Some(url), Some(keys)) if !url.is_empty() && !keys.is_empty() => Self::new(url, keys),
            _ => Err(Error::MarketplaceNotConfigured),
        }
    }

    pub fn new(base: &str, keys: &str) -> Result<Self> {
        let base = checked_base(base)?;
        let keys = TrustedKey::parse_list(keys)?;
        if keys.is_empty() {
            return Err(Error::MarketplaceNotConfigured);
        }
        let http = Client::builder()
            .timeout(TIMEOUT)
            // A redirect could send a request, or what it carries, to another host.
            .redirect(Policy::none())
            .https_only(!is_loopback(&base))
            .user_agent("OpenMedia")
            .build()
            .map_err(|_| Error::Catalog("could not set up the connection".into()))?;
        Ok(Self { base, keys, http })
    }

    /// The signed catalog, verified against the build's keys.
    pub async fn fetch_index(&self, now: i64, last_sequence: u64) -> Result<Index> {
        let bytes = self.get("v1/index.json", MAX_INDEX_BYTES).await?;
        let signature = self.get("v1/index.json.sig", MAX_SIGNATURE_BYTES).await?;
        let signature = String::from_utf8(signature)
            .map_err(|_| Error::Catalog("the catalog signature is malformed".into()))?;
        verify(&bytes, &signature, &self.keys, now, last_sequence)
    }

    /// The exact bytes of a recipe file; the caller ties them to the index.
    pub async fn fetch_recipe(&self, entry: &Entry) -> Result<Vec<u8>> {
        let path = recipe_path(&entry.id, &entry.version)?;
        let max = usize::try_from(entry.size).unwrap_or(recipes::MAX_RECIPE_BYTES);
        self.get(&path, max).await
    }

    /// Install counts. Unsigned and display-only, so a failure or a strange answer is just "none".
    pub async fn fetch_stats(&self) -> BTreeMap<String, u64> {
        self.get("v1/stats.json", MAX_STATS_BYTES)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Counts one install. Carries no body and no identifier.
    pub async fn report_install(&self, id: &str) -> Result<()> {
        if !recipes::is_catalog_id(id) {
            return Err(Error::Catalog("not a marketplace id".into()));
        }
        self.post(&format!("v1/recipes/{id}/installs"), None)
            .await
            .map(drop)
    }

    pub async fn submit(
        &self,
        recipe: &Recipe,
        summary: &str,
        edit_token: Option<&str>,
        pro: &ProUser,
    ) -> Result<Submitted> {
        let call = submit_call(recipe, summary, edit_token, pro)?;
        let reply = self.execute(call, MAX_REPLY_BYTES).await?;
        serde_json::from_slice(&reply)
            .map_err(|_| Error::Catalog("the marketplace answered unexpectedly".into()))
    }

    /// Average rating and count per recipe. Display-only, so a failure is just "none".
    pub async fn fetch_ratings(&self) -> BTreeMap<String, RatingSummary> {
        self.get("v1/ratings.json", MAX_STATS_BYTES)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RatingsReply>(&bytes).ok())
            .map(|reply| reply.ratings)
            .unwrap_or_default()
            .into_iter()
            .filter(|(id, rating)| {
                recipes::is_catalog_id(id)
                    && rating
                        .average
                        .is_none_or(|average| (1.0..=5.0).contains(&average))
            })
            .collect()
    }

    pub async fn rate(&self, id: &str, stars: u8, device_token: &str) -> Result<()> {
        self.execute(rating_call(id, stars, device_token)?, MAX_REPLY_BYTES)
            .await
            .map(drop)
    }

    pub async fn comments(&self, id: &str) -> Result<Vec<WireComment>> {
        let bytes = self.execute(comments_call(id)?, MAX_COMMENTS_BYTES).await?;
        serde_json::from_slice::<CommentsReply>(&bytes)
            .map(|reply| reply.comments)
            .map_err(|_| Error::Catalog("the marketplace answered unexpectedly".into()))
    }

    pub async fn post_comment(&self, id: &str, text: &str, pro: &ProUser) -> Result<()> {
        self.execute(post_comment_call(id, text, pro)?, MAX_REPLY_BYTES)
            .await
            .map(drop)
    }

    pub async fn delete_comment(&self, comment_id: &str, pro: &ProUser) -> Result<()> {
        self.execute(delete_comment_call(comment_id, pro)?, MAX_REPLY_BYTES)
            .await
            .map(drop)
    }

    pub async fn report_comment(&self, comment_id: &str, device_token: &str) -> Result<()> {
        self.execute(
            report_comment_call(comment_id, device_token)?,
            MAX_REPLY_BYTES,
        )
        .await
        .map(drop)
    }

    pub async fn report(&self, id: &str, version: &str, reason: ReportReason) -> Result<()> {
        recipe_path(id, version)?;
        let body = serde_json::json!({ "id": id, "version": version, "reason": reason });
        self.post("v1/reports", Some(serde_json::to_vec(&body)?))
            .await
            .map(drop)
    }

    async fn get(&self, path: &str, max: usize) -> Result<Vec<u8>> {
        self.execute(Call::new(Method::GET, path), max).await
    }

    async fn post(&self, path: &str, body: Option<Vec<u8>>) -> Result<Vec<u8>> {
        let mut call = Call::new(Method::POST, path);
        call.body = body;
        self.execute(call, MAX_REPLY_BYTES).await
    }

    async fn execute(&self, call: Call, max: usize) -> Result<Vec<u8>> {
        let mut request = self.http.request(call.method, self.endpoint(&call.path)?);
        for (name, value) in call.headers {
            request = request.header(name, value);
        }
        if let Some(body) = call.body {
            request = request
                .header("content-type", "application/json")
                .body(body);
        }
        let response = request.send().await.map_err(unreachable)?;
        read_capped(check_status(response).await?, max).await
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.base
            .join(path)
            .map_err(|_| Error::Catalog("bad marketplace address".into()))
    }
}

/// The path of a recipe file. Both parts are checked, so nothing else can reach the URL.
fn recipe_path(id: &str, version: &str) -> Result<String> {
    if recipes::is_catalog_id(id) && recipes::is_version(version) {
        Ok(format!("v1/recipes/{id}/{version}.json"))
    } else {
        Err(Error::Catalog("not a marketplace recipe".into()))
    }
}

/// HTTPS, a host, nothing else in the address. Plain HTTP only to this machine, and only in a
/// debug build, so a local `wrangler dev` can be tried.
fn checked_base(text: &str) -> Result<Url> {
    let url = Url::parse(text).map_err(|_| Error::Catalog("bad marketplace address".into()))?;
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
        Err(Error::Catalog("bad marketplace address".into()))
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

/// Maps a status to an error written here, never to what the server said. A 400 body is only
/// used to *choose* among messages written here.
async fn check_status(response: Response) -> Result<Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    if status == StatusCode::BAD_REQUEST {
        let reason = match read_capped(response, 2048).await {
            Ok(body) => bad_request_reason(&body),
            Err(_) => None,
        };
        if let Some(reason) = reason {
            return Err(Error::Catalog(reason.to_owned()));
        }
    }
    Err(status_error(status))
}

/// The Worker's fixed 400 reasons, each answered with a text written here.
fn bad_request_reason(body: &[u8]) -> Option<&'static str> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    Some(match value.get("error")?.as_str()? {
        "text must be 1-280 characters" => "a comment must be 1 to 280 characters",
        "text has invalid characters" => {
            "the comment has characters the marketplace does not allow"
        }
        "text must not contain links or contact details" => {
            "the comment may not contain links, addresses or phone numbers"
        }
        "body must be { stars: 1-5, turnstileToken?: string }" => "a rating must be 1 to 5 stars",
        "body is not valid JSON"
        | "body must be empty"
        | "body must be { text: string }"
        | "text must be a string" => "the marketplace could not read this request",
        "recipe.id is reserved for official recipes" => {
            "recipe ids starting market.official. are reserved"
        }
        "summary must be 1-140 plain characters" => "the summary must be 1 to 140 plain characters",
        "reason is not allowed" => "that report reason is not allowed",
        other => return recipe_reason(other),
    })
}

/// Recipe checks have dozens of Worker messages; each is answered by the part it concerns.
fn recipe_reason(error: &str) -> Option<&'static str> {
    const AREAS: [(&str, &str); 8] = [
        (
            "recipe.match",
            "the recipe's match patterns were refused (https hosts only, none too broad)",
        ),
        (
            "recipe.options",
            "the recipe's options were refused (ids, labels, group or default)",
        ),
        (
            "recipe.rules",
            "a rule in the recipe was refused (selector, declarations or ids)",
        ),
        (
            "recipe.meta",
            "the recipe's author, notes or homepage were refused",
        ),
        ("recipe.name", "the recipe's name was refused"),
        (
            "recipe.tags",
            "the recipe's tags must list mobile and/or desktop once each",
        ),
        ("recipe.", "the recipe's id, version or format was refused"),
        ("body ", "the marketplace could not read this submission"),
    ];
    AREAS
        .iter()
        .find(|(prefix, _)| error.starts_with(prefix))
        .map(|(_, text)| *text)
}

fn status_error(status: StatusCode) -> Error {
    let message = match status {
        StatusCode::PAYMENT_REQUIRED => return Error::ProRequired,
        StatusCode::TOO_MANY_REQUESTS => "too many requests; try again in a minute".to_owned(),
        StatusCode::UNAUTHORIZED => "this device's subscription could not be identified".to_owned(),
        StatusCode::SERVICE_UNAVAILABLE => {
            "the marketplace could not check this right now; try again later".to_owned()
        }
        StatusCode::CONFLICT => "you already said that".to_owned(),
        StatusCode::BAD_REQUEST => "the marketplace refused this text or request".to_owned(),
        StatusCode::FORBIDDEN => "the marketplace does not allow this".to_owned(),
        StatusCode::NOT_FOUND => "that is not in the marketplace any more".to_owned(),
        other => format!("the marketplace answered {}", other.as_u16()),
    };
    Error::Catalog(message)
}

async fn read_capped(mut response: Response, max: usize) -> Result<Vec<u8>> {
    let too_large = || Error::Catalog("the marketplace sent too much data".into());
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
    Error::Catalog("could not reach the marketplace".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    #[test]
    fn only_a_bare_https_address_is_accepted() {
        assert!(Market::new("https://market.openmedia.surf", KEY).is_ok());
        for bad in [
            "http://market.openmedia.surf",
            "https://user:pw@market.openmedia.surf",
            "https://market.openmedia.surf/v1",
            "https://market.openmedia.surf/?x=1",
            "https://market.openmedia.surf/#x",
            "ftp://market.openmedia.surf",
            "market.openmedia.surf",
        ] {
            assert!(Market::new(bad, KEY).is_err(), "{bad}");
        }
    }

    #[test]
    fn plain_http_is_for_this_machine_only() {
        assert!(Market::new("http://127.0.0.1:8787", KEY).is_ok());
        assert!(Market::new("http://localhost:8787", KEY).is_ok());
        assert!(Market::new("http://192.168.1.5:8787", KEY).is_err());
    }

    #[test]
    fn a_build_without_keys_is_not_configured() {
        assert!(matches!(
            Market::new("https://market.openmedia.surf", ""),
            Err(Error::MarketplaceNotConfigured)
        ));
    }

    #[test]
    fn recipe_paths_only_take_well_formed_ids_and_versions() {
        assert_eq!(
            recipe_path("market.calm", "1.0.0").unwrap(),
            "v1/recipes/market.calm/1.0.0.json"
        );
        for (id, version) in [
            ("market.calm/../x", "1.0.0"),
            ("calm", "1.0.0"),
            ("market.calm", "1.0.0/../../x"),
            ("market.calm", "latest"),
        ] {
            assert!(recipe_path(id, version).is_err(), "{id} {version}");
        }
    }

    const TOKEN: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const COMMENT: &str = "123e4567-e89b-12d3-a456-426614174000";
    const PRO: &str = "$RCAnonymousID:0123456789abcdef";

    fn pro() -> ProUser {
        ProUser::new(PRO).unwrap()
    }

    fn header<'a>(call: &'a Call, name: &str) -> Option<&'a str> {
        call.headers
            .iter()
            .find(|(existing, _)| *existing == name)
            .map(|(_, value)| value.as_str())
    }

    fn body(call: &Call) -> serde_json::Value {
        serde_json::from_slice(call.body.as_deref().unwrap()).unwrap()
    }

    #[test]
    fn a_rating_sends_the_device_token_and_the_app_marker_but_never_the_pro_id() {
        let call = rating_call("market.calm", 4, TOKEN).unwrap();
        assert_eq!(call.method, Method::POST);
        assert_eq!(call.path, "v1/recipes/market.calm/rating");
        assert_eq!(header(&call, "X-Device-Token"), Some(TOKEN));
        assert_eq!(header(&call, "X-Client"), Some("app"));
        assert_eq!(header(&call, "X-Pro-User"), None);
        assert_eq!(body(&call), serde_json::json!({ "stars": 4 }));
    }

    #[test]
    fn a_rating_outside_one_to_five_or_with_a_bad_token_or_id_is_never_built() {
        for stars in [0, 6, 255] {
            assert!(rating_call("market.calm", stars, TOKEN).is_err());
        }
        assert!(rating_call("market.calm", 3, "short").is_err());
        assert!(rating_call("calm", 3, TOKEN).is_err());
        assert!(rating_call("market.calm/../x", 3, TOKEN).is_err());
    }

    #[test]
    fn comment_calls_carry_the_pro_id_only_where_the_worker_needs_it() {
        let read = comments_call("market.calm").unwrap();
        assert_eq!(read.method, Method::GET);
        assert_eq!(read.path, "v1/recipes/market.calm/comments.json");
        assert!(read.headers.is_empty() && read.body.is_none());

        let post = post_comment_call("market.calm", "Nice one", &pro()).unwrap();
        assert_eq!(post.method, Method::POST);
        assert_eq!(post.path, "v1/recipes/market.calm/comments");
        assert_eq!(header(&post, "X-Pro-User"), Some(PRO));
        assert_eq!(header(&post, "X-Device-Token"), None);
        assert_eq!(body(&post), serde_json::json!({ "text": "Nice one" }));

        let delete = delete_comment_call(COMMENT, &pro()).unwrap();
        assert_eq!(delete.method, Method::DELETE);
        assert_eq!(delete.path, format!("v1/comments/{COMMENT}"));
        assert_eq!(header(&delete, "X-Pro-User"), Some(PRO));

        let report = report_comment_call(COMMENT, TOKEN).unwrap();
        assert_eq!(report.method, Method::POST);
        assert_eq!(report.path, format!("v1/comments/{COMMENT}/report"));
        assert_eq!(header(&report, "X-Device-Token"), Some(TOKEN));
        assert_eq!(header(&report, "X-Pro-User"), None);
    }

    #[test]
    fn comment_calls_refuse_ids_that_could_change_the_path() {
        assert!(delete_comment_call("../recipes", &pro()).is_err());
        assert!(report_comment_call("x/report", TOKEN).is_err());
        assert!(report_comment_call(COMMENT, "short").is_err());
        assert!(post_comment_call("market.a/b", "x", &pro()).is_err());
        assert!(comments_call("../x").is_err());
    }

    #[test]
    fn a_submission_carries_the_pro_id_and_the_edit_token_in_the_body_only() {
        let recipe = crate::recipes::official_recipes().remove(0);
        let call = submit_call(&recipe, "Quieter", Some("tok_en-1"), &pro()).unwrap();
        assert_eq!(call.path, "v1/submissions");
        assert_eq!(header(&call, "X-Pro-User"), Some(PRO));
        let sent = body(&call);
        assert_eq!(sent["editToken"], "tok_en-1");
        assert_eq!(sent["summary"], "Quieter");
        assert_eq!(sent["recipe"]["tags"], serde_json::json!(recipe.tags));
        let first = submit_call(&recipe, "Quieter", None, &pro()).unwrap();
        assert!(body(&first).get("editToken").is_none());
    }

    #[test]
    fn a_pro_id_must_have_the_shape_the_worker_accepts() {
        for good in [
            PRO,
            "$RCAnonymousID:abcdef0123456789abcdef",
            "user_12345678",
            "a-b:c_dddd",
        ] {
            assert!(ProUser::new(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "short",
            "$",
            "has space 12345",
            "line\nbreak12345",
            "ünïcode-12345",
            "x@y.example.com",
            &"a".repeat(101),
        ] {
            assert!(ProUser::new(bad).is_err(), "{bad:?}");
        }
        assert_eq!(format!("{:?}", pro()), "ProUser(..)");
    }

    #[test]
    fn a_status_becomes_a_message_written_here_and_402_is_the_paywall() {
        assert!(matches!(
            status_error(StatusCode::PAYMENT_REQUIRED),
            Error::ProRequired
        ));
        for status in [401, 403, 404, 409, 429, 503, 400, 500] {
            let message = status_error(StatusCode::from_u16(status).unwrap()).to_string();
            assert!(message.starts_with("marketplace: "), "{message}");
        }
    }

    /// Serves one canned answer on a loopback port and returns what the client sent.
    fn serve_once(answer: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let read = stream.read(&mut chunk).unwrap();
                received.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&received).into_owned();
                if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                    let wanted = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if rest.len() >= wanted {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            stream.write_all(answer.as_bytes()).unwrap();
            String::from_utf8_lossy(&received).into_owned()
        });
        (port, handle)
    }

    #[test]
    fn a_rating_reaches_the_server_with_exactly_the_documented_headers() {
        let (port, server) = serve_once("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}");
        let market = Market::new(&format!("http://127.0.0.1:{port}"), KEY).unwrap();
        tauri::async_runtime::block_on(market.rate("market.calm", 5, TOKEN)).unwrap();
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("post /v1/recipes/market.calm/rating "));
        assert!(request.contains(&format!("x-device-token: {}", TOKEN.to_ascii_lowercase())));
        assert!(request.contains("x-client: app"));
        assert!(!request.contains("x-pro-user"));
        assert!(request.ends_with(r#"{"stars":5}"#));
    }

    #[test]
    fn a_402_answer_to_a_comment_is_the_pro_required_error() {
        let (port, server) =
            serve_once("HTTP/1.1 402 Payment Required\r\ncontent-length: 0\r\n\r\n");
        let market = Market::new(&format!("http://127.0.0.1:{port}"), KEY).unwrap();
        let error =
            tauri::async_runtime::block_on(market.post_comment("market.calm", "hi", &pro()))
                .unwrap_err();
        assert!(matches!(error, Error::ProRequired));
        let request = server.join().unwrap();
        assert!(request.contains(PRO));
    }
}

#[cfg(test)]
mod bad_request_tests {
    use super::*;

    #[test]
    fn a_400_reason_picks_a_local_text_and_unknown_ones_are_never_repeated() {
        let known = br#"{"error":"text must not contain links or contact details"}"#;
        assert!(bad_request_reason(known).unwrap().contains("links"));
        assert_eq!(
            bad_request_reason(br#"{"error":"<script>x</script>"}"#),
            None
        );
        assert_eq!(bad_request_reason(b"not json"), None);
        let rule = br#"{"error":"recipe.rules target.css may not contain comments"}"#;
        assert!(bad_request_reason(rule).unwrap().contains("rule"));
    }
}
