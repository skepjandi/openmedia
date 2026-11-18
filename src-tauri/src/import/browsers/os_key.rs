//! The key a Chromium browser seals its saved passwords with, fetched from the OS the way the
//! browser itself does it:
//!
//! - macOS: the Keychain item `<Browser> Safe Storage` (the OS asks the person to allow it);
//! - Windows: a key in `Local State`, protected by DPAPI for this Windows user;
//! - Linux: the Secret Service item the browser stored (`secret-tool`), or the fixed `peanuts`
//!   key older and keyring-less installs use.
//!
//! The key is fetched on the first password, not before, and dropped with the opener.

use std::cell::OnceCell;
use std::path::Path;

use zeroize::Zeroizing;

use super::chromium::{Def, Opener};
use super::crypto::Key;

const PREFIX_V10: &[u8] = b"v10";
#[cfg(target_os = "linux")]
const PREFIX_V11: &[u8] = b"v11";

struct Keys {
    v10: Option<Key>,
    #[cfg(target_os = "linux")]
    v11: Option<Key>,
}

pub struct OsOpener<'a> {
    def: &'a Def,
    user_data: &'a Path,
    keys: OnceCell<Keys>,
}

impl<'a> OsOpener<'a> {
    pub fn new(def: &'a Def, user_data: &'a Path) -> Self {
        Self {
            def,
            user_data,
            keys: OnceCell::new(),
        }
    }
}

impl Opener for OsOpener<'_> {
    fn open(&self, sealed: &[u8]) -> Option<Zeroizing<String>> {
        let keys = self.keys.get_or_init(|| fetch(self.def, self.user_data));
        #[cfg(target_os = "linux")]
        if let Some(body) = sealed.strip_prefix(PREFIX_V11) {
            return text(keys.v11.as_ref()?.open(body)?);
        }
        let body = sealed.strip_prefix(PREFIX_V10)?;
        let key = keys.v10.as_ref()?;
        text(key.open(body)?)
    }
}

fn text(plain: Zeroizing<Vec<u8>>) -> Option<Zeroizing<String>> {
    String::from_utf8(plain.to_vec()).ok().map(Zeroizing::new)
}

#[cfg(target_os = "macos")]
fn fetch(def: &Def, _user_data: &Path) -> Keys {
    let (service, account) = def.keychain;
    let secret = std::process::Command::new("security")
        .args(["find-generic-password", "-w", "-s", service, "-a", account])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| Zeroizing::new(output.stdout));
    Keys {
        v10: secret.and_then(|secret| Key::cbc_from_secret(secret.trim_ascii_end(), 1003)),
    }
}

#[cfg(target_os = "linux")]
fn fetch(def: &Def, _user_data: &Path) -> Keys {
    let secret = std::process::Command::new("secret-tool")
        .args(["lookup", "application", def.secret_app])
        .output()
        .ok()
        .filter(|output| output.status.success() && !output.stdout.is_empty())
        .map(|output| Zeroizing::new(output.stdout));
    Keys {
        v10: Key::cbc_from_secret(b"peanuts", 1),
        v11: secret.and_then(|secret| Key::cbc_from_secret(secret.trim_ascii_end(), 1)),
    }
}

#[cfg(target_os = "windows")]
fn fetch(_def: &Def, user_data: &Path) -> Keys {
    Keys {
        v10: windows_key(user_data),
    }
}

#[cfg(target_os = "windows")]
fn windows_key(user_data: &Path) -> Option<Key> {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(user_data.join("Local State")).ok()?).ok()?;
    let sealed = STANDARD
        .decode(state["os_crypt"]["encrypted_key"].as_str()?)
        .ok()?;
    let key = dpapi_unprotect(sealed.strip_prefix(b"DPAPI")?)?;
    Some(Key::Gcm(Zeroizing::new(key)))
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData};

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(sealed.len()).ok()?,
        pbData: sealed.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: `input` points at `sealed` for the call; on success `output` is a buffer the system
    // allocated, copied out and freed here, and never used again.
    unsafe {
        let done = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        );
        if done == 0 || output.pbData.is_null() {
            return None;
        }
        let key = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        Some(key)
    }
}
