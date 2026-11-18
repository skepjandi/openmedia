use uuid::Uuid;
use zeroize::Zeroizing;

use crate::error::{Error, Result};

/// The service the secrets live under: the Keychain service, the Credential Manager target
/// prefix, the Secret Service attribute. Android has no service: its store keeps the secret
/// under its own name.
#[cfg(not(target_os = "android"))]
const SERVICE: &str = "surf.openmedia";

/// Where API keys live. Keys go in and come out only through this trait, and only Rust code
/// calls it: no command returns a key to the shell.
pub trait SecretStore: Send + Sync {
    fn set(&self, id: Uuid, secret: &str) -> Result<()>;
    fn get(&self, id: Uuid) -> Result<Option<Zeroizing<String>>>;
    fn delete(&self, id: Uuid) -> Result<()>;

    fn exists(&self, id: Uuid) -> Result<bool> {
        Ok(self.get(id)?.is_some())
    }
}

/// The OS secure store: the Keychain on iOS and macOS, Credential Manager on Windows, the Secret
/// Service (GNOME Keyring, KWallet) on Linux, the Android Keystore on Android.
#[cfg(not(target_os = "android"))]
pub struct KeychainStore;

/// The OS secure store on Android: a key in the Android Keystore encrypts the secret, and only
/// the ciphertext is written to the app's own preferences.
#[cfg(target_os = "android")]
pub use tauri_plugin_siteview::AndroidSecretStore as KeychainStore;

/// The name a secret is stored under.
fn secret_id(id: Uuid) -> String {
    format!("ai-provider:{id}")
}

#[cfg(not(target_os = "android"))]
impl KeychainStore {
    /// Turns a store failure into the error the shell shows. On Linux the usual cause is that no
    /// Secret Service is running, and the key must not fall back to a file.
    fn fail(e: keyring::Error) -> Error {
        #[cfg(target_os = "linux")]
        if matches!(
            e,
            keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)
        ) {
            return Error::Secret(format!(
                "no secret service available: install and unlock GNOME Keyring or KWallet ({e})"
            ));
        }
        Error::Secret(e.to_string())
    }

    fn entry(id: Uuid) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, &secret_id(id)).map_err(Self::fail)
    }
}

#[cfg(not(target_os = "android"))]
impl SecretStore for KeychainStore {
    fn set(&self, id: Uuid, secret: &str) -> Result<()> {
        Self::entry(id)?.set_password(secret).map_err(Self::fail)
    }

    fn get(&self, id: Uuid) -> Result<Option<Zeroizing<String>>> {
        match Self::entry(id)?.get_password() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Self::fail(e)),
        }
    }

    fn delete(&self, id: Uuid) -> Result<()> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Self::fail(e)),
        }
    }
}

#[cfg(target_os = "android")]
impl SecretStore for KeychainStore {
    fn set(&self, id: Uuid, secret: &str) -> Result<()> {
        tauri_plugin_siteview::AndroidSecretStore::set(&secret_id(id), secret)
            .map_err(Error::Secret)
    }

    fn get(&self, id: Uuid) -> Result<Option<Zeroizing<String>>> {
        match tauri_plugin_siteview::AndroidSecretStore::get(&secret_id(id))
            .map_err(Error::Secret)?
        {
            Some(secret) => Ok(Some(Zeroizing::new(secret))),
            None => Ok(None),
        }
    }

    fn delete(&self, id: Uuid) -> Result<()> {
        tauri_plugin_siteview::AndroidSecretStore::delete(&secret_id(id)).map_err(Error::Secret)
    }
}

#[cfg(test)]
pub use memory::MemoryStore;

#[cfg(test)]
mod memory {
    use std::{collections::HashMap, sync::Mutex};

    use super::*;

    #[derive(Default)]
    pub struct MemoryStore(Mutex<HashMap<Uuid, String>>);

    impl SecretStore for MemoryStore {
        fn set(&self, id: Uuid, secret: &str) -> Result<()> {
            self.0.lock().unwrap().insert(id, secret.to_owned());
            Ok(())
        }

        fn get(&self, id: Uuid) -> Result<Option<Zeroizing<String>>> {
            Ok(self.0.lock().unwrap().get(&id).cloned().map(Zeroizing::new))
        }

        fn delete(&self, id: Uuid) -> Result<()> {
            self.0.lock().unwrap().remove(&id);
            Ok(())
        }
    }
}
