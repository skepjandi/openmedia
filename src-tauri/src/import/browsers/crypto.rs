//! The two ciphers Chromium browsers seal saved passwords with: AES-128-CBC (macOS and Linux, a key
//! stretched from a secret the OS keeps) and AES-256-GCM (Windows, a key the OS protects).

use std::num::NonZeroU32;

use aes::Aes128;
use cbc::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::Pkcs7};
use ring::pbkdf2;
use zeroize::Zeroizing;

const CBC_SALT: &[u8] = b"saltysalt";
const CBC_IV: [u8; 16] = [b' '; 16];
#[cfg(any(windows, test))]
const GCM_NONCE_BYTES: usize = 12;

/// A key the browser's blobs are opened with.
pub enum Key {
    Cbc(Zeroizing<[u8; 16]>),
    #[cfg(any(windows, test))]
    Gcm(Zeroizing<Vec<u8>>),
}

impl Key {
    /// Stretches the secret the OS keeps (`iterations` is 1003 on macOS, 1 on Linux).
    pub fn cbc_from_secret(secret: &[u8], iterations: u32) -> Option<Self> {
        let iterations = NonZeroU32::new(iterations)?;
        let mut key = Zeroizing::new([0u8; 16]);
        pbkdf2::derive(
            pbkdf2::PBKDF2_HMAC_SHA1,
            iterations,
            CBC_SALT,
            secret,
            key.as_mut(),
        );
        Some(Self::Cbc(key))
    }

    /// Opens a blob without its `v10`/`v11` prefix.
    pub fn open(&self, sealed: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
        match self {
            Self::Cbc(key) => open_cbc(key, sealed),
            #[cfg(any(windows, test))]
            Self::Gcm(key) => open_gcm(key, sealed),
        }
    }
}

fn open_cbc(key: &[u8; 16], sealed: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    let mut buffer = Zeroizing::new(sealed.to_vec());
    let plain = cbc::Decryptor::<Aes128>::new(key.into(), &CBC_IV.into())
        .decrypt_padded::<Pkcs7>(&mut buffer)
        .ok()?;
    Some(Zeroizing::new(plain.to_vec()))
}

#[cfg(any(windows, test))]
fn open_gcm(key: &[u8], sealed: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    use ring::aead;

    if sealed.len() < GCM_NONCE_BYTES + aead::AES_256_GCM.tag_len() {
        return None;
    }
    let (nonce, rest) = sealed.split_at(GCM_NONCE_BYTES);
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).ok()?);
    let nonce = aead::Nonce::try_assume_unique_for_key(nonce).ok()?;
    let mut buffer = Zeroizing::new(rest.to_vec());
    let plain_len = key
        .open_in_place(nonce, aead::Aad::empty(), &mut buffer)
        .ok()?
        .len();
    buffer.truncate(plain_len);
    Some(buffer)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use cbc::cipher::BlockModeEncrypt;
    use ring::aead;

    pub fn seal_cbc(key: &Key, plain: &[u8]) -> Vec<u8> {
        let Key::Cbc(key) = key else {
            return Vec::new();
        };
        let mut buffer = vec![0u8; plain.len() + 16];
        buffer[..plain.len()].copy_from_slice(plain);
        cbc::Encryptor::<Aes128>::new((&**key).into(), &CBC_IV.into())
            .encrypt_padded::<Pkcs7>(&mut buffer, plain.len())
            .map(<[u8]>::to_vec)
            .unwrap_or_default()
    }

    #[test]
    fn cbc_round_trips_and_rejects_a_wrong_key() {
        let key = Key::cbc_from_secret(b"peanuts", 1).unwrap();
        let sealed = seal_cbc(&key, b"hunter2");
        assert_eq!(key.open(&sealed).unwrap().as_slice(), b"hunter2");
        let other = Key::cbc_from_secret(b"walnuts", 1).unwrap();
        assert!(
            other
                .open(&sealed)
                .is_none_or(|p| p.as_slice() != b"hunter2")
        );
        assert!(key.open(&sealed[..5]).is_none());
    }

    #[test]
    fn gcm_opens_nonce_ciphertext_tag() {
        let raw = [7u8; 32];
        let sealing =
            aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &raw).unwrap());
        let nonce_bytes = [3u8; GCM_NONCE_BYTES];
        let mut body = b"correct horse".to_vec();
        sealing
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce_bytes),
                aead::Aad::empty(),
                &mut body,
            )
            .unwrap();
        let mut blob = nonce_bytes.to_vec();
        blob.extend(body);
        let key = Key::Gcm(Zeroizing::new(raw.to_vec()));
        assert_eq!(key.open(&blob).unwrap().as_slice(), b"correct horse");
        blob[14] ^= 1;
        assert!(key.open(&blob).is_none());
    }
}
