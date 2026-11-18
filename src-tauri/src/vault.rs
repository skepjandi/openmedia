//! The password vault: logins brought in from another browser, kept encrypted on disk.
//!
//! One file, `passwords.vault`, holds every login as JSON sealed with AES-256-GCM. The 256-bit key
//! is random and lives only in the OS secure store (Keychain, Credential Manager, Secret Service,
//! Android Keystore) through [`SecretStore`]; it is read in Rust and never leaves it. A file
//! copied off the device is noise without the key, and the key without the file opens nothing.
//!
//! Nothing here is reachable from a site webview. The shell may list metadata (never a password)
//! and ask for one password to show on screen, both only inside an unlock window that a device
//! owner check opened (`vault_commands`). A fill sends a password to one page, on one tap, after
//! the page's origin was checked against the login's (`fill`).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::error::{Error, Result};
use crate::secrets::SecretStore;

/// The secret-store id of the vault key. A fixed id: there is one vault per install.
pub const KEY_ID: Uuid = Uuid::from_u128(0x6f70_656e_6d65_6469_612d_7661_756c_7431);

const MAGIC: &[u8; 4] = b"OMV1";
const KEY_BYTES: usize = 32;
/// Most logins one vault holds.
pub const MAX_ENTRIES: usize = 20_000;

/// One saved login, with its password.
#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: Uuid,
    /// The registrable domain.
    pub site: String,
    /// `scheme://host[:port]` the login was saved for.
    pub origin: String,
    pub name: String,
    pub username: String,
    pub password: String,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

/// A login without its password: what the shell may list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: Uuid,
    pub site: String,
    pub origin: String,
    pub name: String,
    pub username: String,
}

impl From<&Entry> for Meta {
    fn from(entry: &Entry) -> Self {
        Self {
            id: entry.id,
            site: entry.site.clone(),
            origin: entry.origin.clone(),
            name: entry.name.clone(),
            username: entry.username.clone(),
        }
    }
}

/// A login to add; the vault gives it an id.
pub struct NewEntry {
    pub site: String,
    pub origin: String,
    pub name: String,
    pub username: String,
    pub password: Zeroizing<String>,
}

pub struct Vault {
    path: PathBuf,
    /// Serializes read-modify-write, so two imports never lose each other's logins.
    lock: Mutex<()>,
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    /// The vault key, made on first use. A store that cannot hold it is an error: the vault never
    /// falls back to a key on disk.
    fn key(&self, store: &dyn SecretStore, create: bool) -> Result<Option<LessSafeKey>> {
        let hex = match store.get(KEY_ID)? {
            Some(hex) => hex,
            None if create => {
                let mut raw = Zeroizing::new([0u8; KEY_BYTES]);
                SystemRandom::new()
                    .fill(raw.as_mut())
                    .map_err(|_| Error::Vault("no source of randomness"))?;
                let hex =
                    Zeroizing::new(raw.iter().map(|b| format!("{b:02x}")).collect::<String>());
                store.set(KEY_ID, &hex)?;
                hex
            }
            None => return Ok(None),
        };
        let bytes = Zeroizing::new(from_hex(&hex).ok_or(Error::Vault("the key is damaged"))?);
        let unbound = UnboundKey::new(&AES_256_GCM, bytes.as_slice())
            .map_err(|_| Error::Vault("the key is damaged"))?;
        Ok(Some(LessSafeKey::new(unbound)))
    }

    fn read(&self, key: &LessSafeKey) -> Result<Vec<Entry>> {
        let sealed = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let header = MAGIC.len() + NONCE_LEN;
        if sealed.len() < header || &sealed[..MAGIC.len()] != MAGIC {
            return Err(Error::Vault("the vault file is not one of ours"));
        }
        let nonce = Nonce::try_assume_unique_for_key(&sealed[MAGIC.len()..header])
            .map_err(|_| Error::Vault("the vault file is damaged"))?;
        let mut body = Zeroizing::new(sealed[header..].to_vec());
        let plain = key
            .open_in_place(nonce, Aad::from(MAGIC), &mut body)
            .map_err(|_| Error::Vault("the vault cannot be opened with this device's key"))?;
        Ok(serde_json::from_slice(plain)?)
    }

    fn write(&self, key: &LessSafeKey, entries: &[Entry]) -> Result<()> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        SystemRandom::new()
            .fill(&mut nonce_bytes)
            .map_err(|_| Error::Vault("no source of randomness"))?;
        let mut body = Zeroizing::new(serde_json::to_vec(entries)?);
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(MAGIC),
            &mut *body,
        )
        .map_err(|_| Error::Vault("the vault could not be sealed"))?;
        let mut file = Vec::with_capacity(MAGIC.len() + NONCE_LEN + body.len());
        file.extend_from_slice(MAGIC);
        file.extend_from_slice(&nonce_bytes);
        file.extend_from_slice(&body);
        write_private(&self.path, &file)
    }

    /// Adds logins; one for the same origin and username replaces the older one. Returns how many
    /// were added or updated.
    pub fn add_many(&self, store: &dyn SecretStore, new: Vec<NewEntry>) -> Result<usize> {
        let _guard = self.lock.lock().map_err(|_| Error::Poisoned)?;
        let Some(key) = self.key(store, true)? else {
            return Ok(0);
        };
        let mut entries = self.read(&key)?;
        let mut changed = 0;
        for item in new {
            let position = entries
                .iter()
                .position(|entry| entry.origin == item.origin && entry.username == item.username);
            if let Some(at) = position {
                if entries[at].password != *item.password {
                    entries[at].password = item.password.to_string();
                    changed += 1;
                }
            } else if entries.len() < MAX_ENTRIES {
                entries.push(Entry {
                    id: Uuid::new_v4(),
                    site: item.site,
                    origin: item.origin,
                    name: item.name,
                    username: item.username,
                    password: item.password.to_string(),
                });
                changed += 1;
            } else {
                break;
            }
        }
        if changed > 0 {
            self.write(&key, &entries)?;
        }
        Ok(changed)
    }

    /// Every login without its password, by site then username.
    pub fn list(&self, store: &dyn SecretStore) -> Result<Vec<Meta>> {
        let _guard = self.lock.lock().map_err(|_| Error::Poisoned)?;
        let Some(key) = self.key(store, false)? else {
            return Ok(Vec::new());
        };
        let mut metas: Vec<Meta> = self.read(&key)?.iter().map(Meta::from).collect();
        metas.sort_by(|a, b| (&a.site, &a.username).cmp(&(&b.site, &b.username)));
        Ok(metas)
    }

    /// How many logins are saved for `site`. Reveals nothing but a number.
    pub fn count_for_site(&self, store: &dyn SecretStore, site: &str) -> Result<usize> {
        Ok(self
            .list(store)?
            .iter()
            .filter(|meta| meta.site == site)
            .count())
    }

    /// One login with its password, for the caller to show or fill.
    pub fn get(&self, store: &dyn SecretStore, id: Uuid) -> Result<Option<Entry>> {
        let _guard = self.lock.lock().map_err(|_| Error::Poisoned)?;
        let Some(key) = self.key(store, false)? else {
            return Ok(None);
        };
        Ok(self.read(&key)?.into_iter().find(|entry| entry.id == id))
    }

    pub fn delete(&self, store: &dyn SecretStore, id: Uuid) -> Result<()> {
        let _guard = self.lock.lock().map_err(|_| Error::Poisoned)?;
        let Some(key) = self.key(store, false)? else {
            return Ok(());
        };
        let mut entries = self.read(&key)?;
        let before = entries.len();
        entries.retain(|entry| entry.id != id);
        if entries.len() != before {
            self.write(&key, &entries)?;
        }
        Ok(())
    }

    /// Forgets every login: the file and the key.
    pub fn clear(&self, store: &dyn SecretStore) -> Result<()> {
        let _guard = self.lock.lock().map_err(|_| Error::Poisoned)?;
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        store.delete(KEY_ID)
    }
}

fn from_hex(text: &str) -> Option<[u8; KEY_BYTES]> {
    if text.len() != KEY_BYTES * 2 || !text.is_ascii() {
        return None;
    }
    let mut out = [0u8; KEY_BYTES];
    for (byte, pair) in out.iter_mut().zip(text.as_bytes().chunks(2)) {
        *byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(out)
}

/// Writes `bytes` to `path` through a temporary file, readable by the owner only.
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension("tmp");
    fs::write(&temp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&temp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;

    fn new_entry(origin: &str, username: &str, password: &str) -> NewEntry {
        NewEntry {
            site: "example.com".into(),
            origin: origin.into(),
            name: "Example".into(),
            username: username.into(),
            password: Zeroizing::new(password.into()),
        }
    }

    fn vault() -> (tempfile::TempDir, Vault, MemoryStore) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().join("passwords.vault"));
        (dir, vault, MemoryStore::default())
    }

    #[test]
    fn a_login_round_trips_and_the_file_holds_no_plain_text() {
        let (dir, vault, store) = vault();
        let added = vault
            .add_many(
                &store,
                vec![new_entry("https://example.com", "me", "hunter2-pw")],
            )
            .unwrap();
        assert_eq!(added, 1);
        let metas = vault.list(&store).unwrap();
        assert_eq!(metas.len(), 1);
        let entry = vault.get(&store, metas[0].id).unwrap().unwrap();
        assert_eq!(entry.password, "hunter2-pw");
        let raw = fs::read(dir.path().join("passwords.vault")).unwrap();
        for needle in ["hunter2-pw", "example.com", "me"] {
            assert!(
                !raw.windows(needle.len()).any(|w| w == needle.as_bytes()),
                "{needle}"
            );
        }
    }

    #[test]
    fn the_same_origin_and_user_is_updated_not_duplicated() {
        let (_dir, vault, store) = vault();
        vault
            .add_many(&store, vec![new_entry("https://example.com", "me", "one")])
            .unwrap();
        let changed = vault
            .add_many(&store, vec![new_entry("https://example.com", "me", "two")])
            .unwrap();
        assert_eq!(changed, 1);
        let unchanged = vault
            .add_many(&store, vec![new_entry("https://example.com", "me", "two")])
            .unwrap();
        assert_eq!(unchanged, 0);
        let metas = vault.list(&store).unwrap();
        assert_eq!(metas.len(), 1);
        assert_eq!(
            vault.get(&store, metas[0].id).unwrap().unwrap().password,
            "two"
        );
    }

    #[test]
    fn a_tampered_file_or_another_key_opens_nothing() {
        let (dir, vault, store) = vault();
        vault
            .add_many(&store, vec![new_entry("https://example.com", "me", "pw")])
            .unwrap();
        let path = dir.path().join("passwords.vault");
        let other_store = MemoryStore::default();
        other_store.set(KEY_ID, &"ab".repeat(32)).unwrap();
        assert!(vault.list(&other_store).is_err());
        let mut raw = fs::read(&path).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        fs::write(&path, raw).unwrap();
        assert!(vault.list(&store).is_err());
    }

    #[test]
    fn a_vault_with_no_key_is_empty_and_never_makes_one_to_read() {
        let (_dir, vault, store) = vault();
        assert!(vault.list(&store).unwrap().is_empty());
        assert!(store.get(KEY_ID).unwrap().is_none());
    }

    #[test]
    fn delete_removes_one_and_clear_removes_the_file_and_the_key() {
        let (dir, vault, store) = vault();
        vault
            .add_many(
                &store,
                vec![
                    new_entry("https://example.com", "a", "1"),
                    new_entry("https://example.com", "b", "2"),
                ],
            )
            .unwrap();
        let first = vault.list(&store).unwrap()[0].id;
        vault.delete(&store, first).unwrap();
        assert_eq!(vault.list(&store).unwrap().len(), 1);
        vault.clear(&store).unwrap();
        assert!(!dir.path().join("passwords.vault").exists());
        assert!(store.get(KEY_ID).unwrap().is_none());
        assert!(vault.list(&store).unwrap().is_empty());
    }

    #[test]
    fn the_listing_shows_no_password_and_counts_by_site() {
        let (_dir, vault, store) = vault();
        vault
            .add_many(
                &store,
                vec![new_entry("https://example.com", "me", "secret-pw")],
            )
            .unwrap();
        let metas = vault.list(&store).unwrap();
        assert!(!serde_json::to_string(&metas).unwrap().contains("secret-pw"));
        assert_eq!(vault.count_for_site(&store, "example.com").unwrap(), 1);
        assert_eq!(vault.count_for_site(&store, "other.org").unwrap(), 0);
    }

    #[test]
    fn hex_keys_decode_only_at_the_exact_length() {
        assert!(from_hex(&"0f".repeat(32)).is_some());
        assert!(from_hex(&"0f".repeat(31)).is_none());
        assert!(from_hex(&"zz".repeat(32)).is_none());
    }
}
