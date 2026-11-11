//! The signed catalog index: what the marketplace publishes, how the app trusts it, and how a
//! downloaded recipe is tied back to it. Pure functions only; nothing here touches the network.

use base64::{Engine, engine::general_purpose::STANDARD};
use ring::{
    rand::SystemRandom,
    signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::recipes::{self, Recipe};

pub const INDEX_FORMAT: u32 = 1;
const SIGNING_CONTEXT: &[u8] = b"openmedia-catalog-v1\n";
pub const MAX_INDEX_BYTES: usize = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 5000;
const MAX_REVOKED: usize = 5000;
const MAX_NAME_CHARS: usize = 60;
const MAX_SUMMARY_CHARS: usize = 140;
const MAX_HOSTS: usize = 10;
const MAX_HOST_CHARS: usize = 253;
const SIGNATURE_BYTES: usize = 64;
const PUBLIC_KEY_BYTES: usize = 32;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Index {
    pub format: u32,
    pub key_id: String,
    pub sequence: u64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub recipes: Vec<Entry>,
    pub revoked: Vec<Revoked>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub summary: String,
    pub hosts: Vec<String>,
    pub sha256: String,
    pub size: u64,
    pub published_at: i64,
    pub featured: bool,
    /// Platform tags of the recipe plus exactly one origin tag, added by the Worker.
    pub tags: Vec<String>,
    /// The recipe's own `meta.homepage`, when it is an https address.
    pub homepage: Option<String>,
}

pub const TAG_OFFICIAL: &str = "official";
pub const TAG_COMMUNITY: &str = "community";
/// Added by the Worker to a recipe that carries a `hub`: several sites opened as tabs.
pub const TAG_HUB: &str = "hub";
/// Official recipes are the ones the marketplace operator publishes under this id prefix.
pub const OFFICIAL_ID_PREFIX: &str = "market.official.";
const MAX_HOMEPAGE_CHARS: usize = 2048;

impl Entry {
    pub fn is_official(&self) -> bool {
        self.tags.iter().any(|tag| tag == TAG_OFFICIAL)
    }

    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|existing| existing == tag)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Revoked {
    pub id: String,
    pub sha256: String,
}

/// A public key the app trusts to sign the catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedKey {
    pub id: String,
    pub public: [u8; PUBLIC_KEY_BYTES],
}

impl TrustedKey {
    /// Parses `id:base64` pairs separated by commas, the form the build is configured with.
    pub fn parse_list(text: &str) -> Result<Vec<Self>> {
        text.split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(|part| {
                let (id, key) = part
                    .split_once(':')
                    .ok_or_else(|| Error::Catalog("a catalog key looks like id:base64".into()))?;
                let public = STANDARD
                    .decode(key)
                    .ok()
                    .and_then(|bytes| <[u8; PUBLIC_KEY_BYTES]>::try_from(bytes).ok())
                    .ok_or_else(|| Error::Catalog("a catalog key is 32 bytes of base64".into()))?;
                Ok(Self {
                    id: id.to_owned(),
                    public,
                })
            })
            .collect()
    }
}

/// The bytes to publish and the signature that goes beside them.
pub struct SignedIndex {
    pub bytes: Vec<u8>,
    pub signature: String,
}

/// Creates a signing key. Returns the PKCS#8 private key and the 32-byte public key.
pub fn generate_key() -> Result<(Vec<u8>, [u8; PUBLIC_KEY_BYTES])> {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .map_err(|_| Error::Catalog("could not generate a key".into()))?;
    let public = public_key_of(pkcs8.as_ref())?;
    Ok((pkcs8.as_ref().to_vec(), public))
}

pub fn public_key_of(pkcs8: &[u8]) -> Result<[u8; PUBLIC_KEY_BYTES]> {
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8)
        .map_err(|_| Error::Catalog("not a valid signing key".into()))?;
    <[u8; PUBLIC_KEY_BYTES]>::try_from(pair.public_key().as_ref())
        .map_err(|_| Error::Catalog("not a valid signing key".into()))
}

/// Serializes and signs an index. The Worker holds the signing key and publishes the catalog;
/// the app never signs in production. This is the reference implementation of the format and
/// the source of the test fixtures.
pub fn sign(index: &Index, pkcs8: &[u8]) -> Result<SignedIndex> {
    check_index(index)?;
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8)
        .map_err(|_| Error::Catalog("not a valid signing key".into()))?;
    let bytes = serde_json::to_vec(index)?;
    let signature = pair.sign(&signed_message(&bytes));
    Ok(SignedIndex {
        bytes,
        signature: STANDARD.encode(signature.as_ref()),
    })
}

/// Trusts an index only if one of `keys` signed exactly these bytes, it is still fresh, and it is
/// not older than the newest one this device has accepted (`last_sequence`). The signature is
/// checked before the bytes are parsed.
pub fn verify(
    bytes: &[u8],
    signature: &str,
    keys: &[TrustedKey],
    now: i64,
    last_sequence: u64,
) -> Result<Index> {
    if bytes.len() > MAX_INDEX_BYTES {
        return Err(Error::Catalog("the catalog is too large".into()));
    }
    let signature = STANDARD
        .decode(signature.trim())
        .ok()
        .filter(|decoded| decoded.len() == SIGNATURE_BYTES)
        .ok_or_else(|| Error::Catalog("the catalog signature is malformed".into()))?;
    let message = signed_message(bytes);
    let signer = keys
        .iter()
        .find(|key| {
            UnparsedPublicKey::new(&ED25519, key.public)
                .verify(&message, &signature)
                .is_ok()
        })
        .ok_or_else(|| Error::Catalog("the catalog signature is not valid".into()))?;
    let index: Index = serde_json::from_slice(bytes).map_err(|e| Error::Catalog(e.to_string()))?;
    if index.key_id != signer.id {
        return Err(Error::Catalog("the catalog names the wrong key".into()));
    }
    if index.expires_at <= now {
        return Err(Error::Catalog("the catalog has expired".into()));
    }
    if index.sequence < last_sequence {
        return Err(Error::Catalog(
            "the catalog is older than one already seen".into(),
        ));
    }
    check_index(&index)?;
    Ok(index)
}

fn signed_message(bytes: &[u8]) -> Vec<u8> {
    [SIGNING_CONTEXT, bytes].concat()
}

fn check_index(index: &Index) -> Result<()> {
    if index.format != INDEX_FORMAT {
        return Err(Error::Catalog(format!(
            "unsupported catalog format {}",
            index.format
        )));
    }
    if index.recipes.len() > MAX_ENTRIES || index.revoked.len() > MAX_REVOKED {
        return Err(Error::Catalog("the catalog is too large".into()));
    }
    let mut seen = std::collections::HashSet::new();
    for entry in &index.recipes {
        check_entry(entry)?;
        if !seen.insert(entry.id.as_str()) {
            return Err(Error::Catalog(format!("duplicate catalog id {}", entry.id)));
        }
    }
    for revoked in &index.revoked {
        if !recipes::is_catalog_id(&revoked.id) || !is_sha256_hex(&revoked.sha256) {
            return Err(Error::Catalog("a revocation is malformed".into()));
        }
    }
    Ok(())
}

fn check_entry(entry: &Entry) -> Result<()> {
    let text_ok = recipes::is_plain_text(&entry.name, MAX_NAME_CHARS)
        && !entry.name.trim().is_empty()
        && recipes::is_plain_text(&entry.author, MAX_NAME_CHARS)
        && recipes::is_plain_text(&entry.summary, MAX_SUMMARY_CHARS)
        && entry.hosts.len() <= MAX_HOSTS
        && entry
            .hosts
            .iter()
            .all(|host| !host.is_empty() && recipes::is_plain_text(host, MAX_HOST_CHARS));
    let well_formed = recipes::is_catalog_id(&entry.id)
        && recipes::is_version(&entry.version)
        && is_sha256_hex(&entry.sha256)
        && entry.size > 0
        && entry.size <= recipes::MAX_RECIPE_BYTES as u64;
    if text_ok && well_formed && tags_ok(entry) && homepage_ok(entry.homepage.as_deref()) {
        Ok(())
    } else {
        Err(Error::Catalog(format!(
            "catalog entry {} is malformed",
            entry.id
        )))
    }
}

/// Platform tags (at least one), no repeats, exactly one origin tag; `official` only under the
/// official id prefix and `community` never under it, so an upload cannot wear the badge. `hub`
/// is the one extra tag, for a recipe that is a hub.
fn tags_ok(entry: &Entry) -> bool {
    let mut platforms = 0;
    let mut origins = Vec::new();
    for (index, tag) in entry.tags.iter().enumerate() {
        if entry.tags[..index].contains(tag) {
            return false;
        }
        match tag.as_str() {
            "mobile" | "desktop" | TAG_HUB => platforms += usize::from(tag != TAG_HUB),
            TAG_OFFICIAL | TAG_COMMUNITY => origins.push(tag.as_str()),
            _ => return false,
        }
    }
    let official_id = entry.id.starts_with(OFFICIAL_ID_PREFIX);
    platforms >= 1
        && match origins.as_slice() {
            [TAG_OFFICIAL] => official_id,
            [TAG_COMMUNITY] => !official_id,
            _ => false,
        }
}

fn homepage_ok(homepage: Option<&str>) -> bool {
    homepage.is_none_or(|homepage| {
        recipes::is_plain_text(homepage, MAX_HOMEPAGE_CHARS)
            && url::Url::parse(homepage)
                .is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some())
    })
}

fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn entry<'a>(index: &'a Index, id: &str) -> Option<&'a Entry> {
    index.recipes.iter().find(|entry| entry.id == id)
}

/// Whether this recipe file was withdrawn in the catalog.
pub fn is_revoked(index: &Index, id: &str, sha256: &str) -> bool {
    index
        .revoked
        .iter()
        .any(|revoked| revoked.id == id && revoked.sha256 == sha256)
}

/// Ties downloaded bytes to the signed entry: same size, same hash, not revoked, and the recipe
/// inside is the id and version the index promised. Then the normal import validation runs.
pub fn check_download(index: &Index, id: &str, bytes: &[u8]) -> Result<Recipe> {
    let entry = entry(index, id).ok_or_else(|| Error::Catalog("not in the catalog".into()))?;
    if is_revoked(index, id, &entry.sha256) {
        return Err(Error::Catalog("this recipe was withdrawn".into()));
    }
    if bytes.len() as u64 != entry.size || sha256_hex(bytes) != entry.sha256 {
        return Err(Error::Catalog(
            "the download does not match the catalog".into(),
        ));
    }
    let recipe = recipes::parse_catalog_recipe(bytes)?;
    if recipe.id != entry.id
        || recipe.version != entry.version
        || recipe.hub.is_some() != entry.has_tag(TAG_HUB)
    {
        return Err(Error::Catalog(
            "the recipe is not the one the catalog lists".into(),
        ));
    }
    Ok(recipe)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn recipe_bytes(id: &str, version: &str) -> Vec<u8> {
        format!(
            r#"{{"schema":1,"id":"{id}","name":"Calm","version":"{version}","origin":"user","tags":["mobile"],"match":["https://*.example.com/*"],
              "options":[{{"id":"a","label":"A","description":"d","group":"content","default":false}}],
              "rules":[{{"id":"r","label":"l","type":"hide","option":"a","target":{{"css":".x"}}}}]}}"#
        )
        .into_bytes()
    }

    fn entry_for(bytes: &[u8]) -> Entry {
        Entry {
            id: "market.calm".into(),
            name: "Calm".into(),
            version: "1.0.0".into(),
            author: "Ada".into(),
            summary: "Quieter pages".into(),
            hosts: vec!["example.com".into()],
            sha256: sha256_hex(bytes),
            size: bytes.len() as u64,
            published_at: NOW - 10,
            featured: false,
            tags: vec!["mobile".into(), "community".into()],
            homepage: Some("https://www.example.com/".into()),
        }
    }

    fn index_with(entries: Vec<Entry>) -> Index {
        Index {
            format: INDEX_FORMAT,
            key_id: "k1".into(),
            sequence: 5,
            issued_at: NOW - 100,
            expires_at: NOW + 1000,
            recipes: entries,
            revoked: vec![],
        }
    }

    fn keypair() -> (Vec<u8>, TrustedKey) {
        let (pkcs8, public) = generate_key().unwrap();
        (
            pkcs8,
            TrustedKey {
                id: "k1".into(),
                public,
            },
        )
    }

    fn signed(index: &Index, pkcs8: &[u8]) -> SignedIndex {
        sign(index, pkcs8).unwrap()
    }

    #[test]
    fn an_index_signed_by_a_trusted_key_verifies() {
        let (pkcs8, key) = keypair();
        let index = index_with(vec![entry_for(&recipe_bytes("market.calm", "1.0.0"))]);
        let out = signed(&index, &pkcs8);
        let verified = verify(&out.bytes, &out.signature, &[key], NOW, 5).unwrap();
        assert_eq!(verified, index);
    }

    #[test]
    fn a_changed_byte_a_foreign_key_or_a_wrong_context_is_refused() {
        let (pkcs8, key) = keypair();
        let (_, stranger) = keypair();
        let index = index_with(vec![]);
        let out = signed(&index, &pkcs8);

        let mut tampered = out.bytes.clone();
        tampered[0] = b' ';
        assert!(
            verify(
                &tampered,
                &out.signature,
                std::slice::from_ref(&key),
                NOW,
                0
            )
            .is_err()
        );
        assert!(verify(&out.bytes, &out.signature, &[stranger], NOW, 0).is_err());
        assert!(
            verify(
                &out.bytes,
                "not base64!",
                std::slice::from_ref(&key),
                NOW,
                0
            )
            .is_err()
        );
        assert!(verify(&out.bytes, "AAAA", std::slice::from_ref(&key), NOW, 0).is_err());

        let pair = Ed25519KeyPair::from_pkcs8(&pkcs8).unwrap();
        let without_context = STANDARD.encode(pair.sign(&out.bytes).as_ref());
        assert!(verify(&out.bytes, &without_context, &[key], NOW, 0).is_err());
    }

    #[test]
    fn the_index_must_name_the_key_that_signed_it() {
        let (pkcs8, mut key) = keypair();
        key.id = "k2".into();
        let out = signed(&index_with(vec![]), &pkcs8);
        assert!(verify(&out.bytes, &out.signature, &[key], NOW, 0).is_err());
    }

    #[test]
    fn a_rotated_key_list_accepts_either_key() {
        let (old_pkcs8, old_key) = keypair();
        let (new_pkcs8, mut new_key) = keypair();
        new_key.id = "k2".into();
        let keys = [old_key, new_key];
        let mut index = index_with(vec![]);
        let old = signed(&index, &old_pkcs8);
        assert!(verify(&old.bytes, &old.signature, &keys, NOW, 0).is_ok());
        index.key_id = "k2".into();
        let new = signed(&index, &new_pkcs8);
        assert!(verify(&new.bytes, &new.signature, &keys, NOW, 0).is_ok());
    }

    #[test]
    fn an_expired_or_older_index_is_refused_and_the_same_sequence_is_fine() {
        let (pkcs8, key) = keypair();
        let out = signed(&index_with(vec![]), &pkcs8);
        let keys = [key];
        assert!(verify(&out.bytes, &out.signature, &keys, NOW + 1000, 0).is_err());
        assert!(verify(&out.bytes, &out.signature, &keys, NOW, 6).is_err());
        assert!(verify(&out.bytes, &out.signature, &keys, NOW, 5).is_ok());
    }

    #[test]
    fn a_malformed_entry_is_refused_even_when_signed() {
        let (pkcs8, _) = keypair();
        let good = entry_for(&recipe_bytes("market.calm", "1.0.0"));
        let bad = [
            Entry {
                id: "calm".into(),
                ..good.clone()
            },
            Entry {
                id: "market.Bad/../x".into(),
                ..good.clone()
            },
            Entry {
                sha256: "ABC".into(),
                ..good.clone()
            },
            Entry {
                size: 0,
                ..good.clone()
            },
            Entry {
                size: 10_000_000,
                ..good.clone()
            },
            Entry {
                version: "1.0".into(),
                ..good.clone()
            },
            Entry {
                name: "Ca\u{202E}lm".into(),
                ..good.clone()
            },
            Entry {
                summary: "x".repeat(141),
                ..good.clone()
            },
            Entry {
                homepage: Some("http://www.example.com/".into()),
                ..good.clone()
            },
            Entry {
                homepage: Some("javascript:alert(1)".into()),
                ..good.clone()
            },
        ];
        for entry in bad {
            assert!(
                sign(&index_with(vec![entry.clone()]), &pkcs8).is_err(),
                "{entry:?}"
            );
        }
        assert!(sign(&index_with(vec![good.clone(), good]), &pkcs8).is_err());
    }

    fn tagged(id: &str, tags: &[&str]) -> Entry {
        Entry {
            id: id.into(),
            tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
            ..entry_for(&recipe_bytes(id, "1.0.0"))
        }
    }

    #[test]
    fn origin_and_platform_tags_follow_the_acceptance_rules() {
        let (pkcs8, _) = keypair();
        let accepted = |entry: Entry| sign(&index_with(vec![entry]), &pkcs8).is_ok();
        assert!(accepted(tagged("market.calm", &["mobile", "community"])));
        assert!(accepted(tagged(
            "market.calm",
            &["desktop", "mobile", "community"]
        )));
        assert!(accepted(tagged(
            "market.official.youtube",
            &["desktop", "official"]
        )));
        let rejected = [
            // Origin tags: exactly one.
            tagged("market.calm", &["mobile"]),
            tagged("market.calm", &["mobile", "community", "official"]),
            tagged("market.calm", &["mobile", "community", "community"]),
            // Official needs the official prefix; community may never carry it.
            tagged("market.calm", &["mobile", "official"]),
            tagged("market.official.youtube", &["mobile", "community"]),
            // Platform tags: at least one, no repeats, nothing else.
            tagged("market.calm", &["community"]),
            tagged("market.calm", &["mobile", "mobile", "community"]),
            tagged("market.calm", &["tablet", "mobile", "community"]),
            tagged("market.calm", &[]),
            tagged("market.official.youtube", &["official"]),
        ];
        for entry in rejected {
            assert!(!accepted(entry.clone()), "{:?}", entry.tags);
        }
    }
    #[test]
    fn hub_is_an_additional_catalog_tag() {
        let (pkcs8, _) = keypair();
        let accepted = |entry: Entry| sign(&index_with(vec![entry]), &pkcs8).is_ok();
        assert!(accepted(tagged(
            "market.hub",
            &["mobile", TAG_HUB, TAG_COMMUNITY]
        )));
        assert!(!accepted(tagged(
            "market.hub",
            &["mobile", TAG_HUB, TAG_HUB, TAG_COMMUNITY]
        )));
    }

    #[test]
    fn a_signed_index_missing_tags_is_refused_when_parsed() {
        let (pkcs8, key) = keypair();
        let index = index_with(vec![entry_for(&recipe_bytes("market.calm", "1.0.0"))]);
        let mut value = serde_json::to_value(&index).unwrap();
        value["recipes"][0].as_object_mut().unwrap().remove("tags");
        let bytes = serde_json::to_vec(&value).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(&pkcs8).unwrap();
        let signature = STANDARD.encode(pair.sign(&signed_message(&bytes)).as_ref());
        assert!(verify(&bytes, &signature, &[key], NOW, 0).is_err());
    }

    #[test]
    fn an_index_of_another_format_is_refused() {
        let (pkcs8, _) = keypair();
        let index = Index {
            format: 2,
            ..index_with(vec![])
        };
        assert!(sign(&index, &pkcs8).is_err());
    }

    #[test]
    fn a_download_must_match_the_signed_entry_exactly() {
        let bytes = recipe_bytes("market.calm", "1.0.0");
        let index = index_with(vec![entry_for(&bytes)]);
        let recipe = check_download(&index, "market.calm", &bytes).unwrap();
        assert_eq!(recipe.id, "market.calm");

        let mut changed = bytes.clone();
        changed.extend_from_slice(b" ");
        assert!(check_download(&index, "market.calm", &changed).is_err());
        assert!(check_download(&index, "market.other", &bytes).is_err());
    }

    #[test]
    fn a_download_whose_contents_disagree_with_the_entry_is_refused() {
        let other_id = recipe_bytes("market.other", "1.0.0");
        let index = index_with(vec![entry_for(&other_id)]);
        assert!(check_download(&index, "market.calm", &other_id).is_err());
        let other_version = recipe_bytes("market.calm", "2.0.0");
        let index = index_with(vec![entry_for(&other_version)]);
        assert!(check_download(&index, "market.calm", &other_version).is_err());
    }

    #[test]
    fn a_withdrawn_recipe_cannot_be_downloaded() {
        let bytes = recipe_bytes("market.calm", "1.0.0");
        let mut index = index_with(vec![entry_for(&bytes)]);
        index.revoked.push(Revoked {
            id: "market.calm".into(),
            sha256: sha256_hex(&bytes),
        });
        assert!(check_download(&index, "market.calm", &bytes).is_err());
    }

    #[test]
    fn a_trusted_key_list_parses_and_rejects_bad_input() {
        let (_, key) = keypair();
        let text = format!("k1:{}", STANDARD.encode(key.public));
        assert_eq!(TrustedKey::parse_list(&text).unwrap(), vec![key]);
        assert!(TrustedKey::parse_list("").unwrap().is_empty());
        assert!(TrustedKey::parse_list("k1").is_err());
        assert!(TrustedKey::parse_list("k1:AAAA").is_err());
    }
}
