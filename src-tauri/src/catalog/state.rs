use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
    sync::{Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};

use super::community::{self, MAX_STARS, MIN_STARS};
use crate::error::{Error, Result};
use crate::library::write_atomically;

const MAX_TOKEN_CHARS: usize = 64;
const MAX_BLOCKED: usize = 500;
const MAX_RATINGS: usize = 5000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Data {
    /// The newest catalog sequence this device accepted; an older one is a replay.
    sequence: u64,
    /// Marketplace recipe id to the SHA-256 of the exact file installed, so a revocation in a
    /// later catalog can find it.
    installed: BTreeMap<String, String>,
    /// Marketplace recipe id to the token that lets this device submit new versions of it. It
    /// lets a new version be submitted; the server still checks and holds every submission
    /// before it is published.
    edit_tokens: BTreeMap<String, String>,
    count_installs: bool,
    /// Random, created on first use. The Worker only ever stores its hash.
    device_token: Option<String>,
    /// Recipe id to the stars this device gave it, so the shell can show "my rating".
    my_ratings: BTreeMap<String, u8>,
    /// Commenter ids this device hides.
    blocked_commenters: BTreeSet<String>,
}

impl Default for Data {
    fn default() -> Self {
        Self {
            sequence: 0,
            installed: BTreeMap::new(),
            edit_tokens: BTreeMap::new(),
            count_installs: true,
            device_token: None,
            my_ratings: BTreeMap::new(),
            blocked_commenters: BTreeSet::new(),
        }
    }
}

/// What the marketplace client remembers between runs, in `catalog-state.json`.
pub struct State {
    path: PathBuf,
    data: Mutex<Data>,
}

impl State {
    /// A missing or unreadable file is a fresh start: nothing here is needed to use the app.
    pub fn load(path: PathBuf) -> Self {
        let data = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
                // Edit tokens cannot be issued again, so an unreadable file is kept aside rather
                // than overwritten by the next save.
                let _ = fs::rename(&path, path.with_extension("json.corrupt"));
                Data::default()
            }),
            Err(_) => Data::default(),
        };
        Self {
            path,
            data: Mutex::new(data),
        }
    }

    pub fn sequence(&self) -> u64 {
        self.read(|data| data.sequence)
    }

    /// Remembers a newer sequence. An older one never lowers it.
    pub fn accept_sequence(&self, sequence: u64) -> Result<()> {
        self.update(|data| data.sequence = data.sequence.max(sequence))
    }

    pub fn installed(&self) -> BTreeMap<String, String> {
        self.read(|data| data.installed.clone())
    }

    pub fn record_install(&self, id: &str, sha256: &str) -> Result<()> {
        self.update(|data| {
            data.installed.insert(id.to_owned(), sha256.to_owned());
        })
    }

    pub fn forget(&self, id: &str) -> Result<()> {
        self.update(|data| {
            data.installed.remove(id);
        })
    }

    pub fn edit_token(&self, id: &str) -> Option<String> {
        self.read(|data| data.edit_tokens.get(id).cloned())
    }

    /// Keeps a token the server handed out, if it has the shape of one.
    pub fn set_edit_token(&self, id: &str, token: &str) -> Result<()> {
        let well_formed = !token.is_empty()
            && token.len() <= MAX_TOKEN_CHARS
            && token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !well_formed {
            return Ok(());
        }
        self.update(|data| {
            data.edit_tokens.insert(id.to_owned(), token.to_owned());
        })
    }

    pub fn count_installs(&self) -> bool {
        self.read(|data| data.count_installs)
    }

    pub fn set_count_installs(&self, on: bool) -> Result<()> {
        self.update(|data| data.count_installs = on)
    }

    /// The device token, created and saved the first time it is needed. A stored value that is
    /// not shaped like a token is replaced.
    pub fn device_token(&self) -> Result<String> {
        let mut data = self.data.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(token) = data
            .device_token
            .as_deref()
            .filter(|token| community::is_device_token(token))
        {
            return Ok(token.to_owned());
        }
        let token = community::new_device_token()?;
        data.device_token = Some(token.clone());
        write_atomically(&self.path, &serde_json::to_vec_pretty(&*data)?)?;
        Ok(token)
    }

    pub fn my_rating(&self, id: &str) -> Option<u8> {
        self.read(|data| data.my_ratings.get(id).copied())
    }

    pub fn my_ratings(&self) -> BTreeMap<String, u8> {
        self.read(|data| data.my_ratings.clone())
    }

    pub fn set_my_rating(&self, id: &str, stars: u8) -> Result<()> {
        if !(MIN_STARS..=MAX_STARS).contains(&stars) {
            return Err(Error::Catalog("a rating is 1 to 5 stars".into()));
        }
        self.update(|data| {
            if data.my_ratings.len() < MAX_RATINGS || data.my_ratings.contains_key(id) {
                data.my_ratings.insert(id.to_owned(), stars);
            }
        })
    }

    pub fn blocked(&self) -> Vec<String> {
        self.read(|data| data.blocked_commenters.iter().cloned().collect())
    }

    pub fn block(&self, commenter: &str) -> Result<()> {
        if !community::is_commenter_id(commenter) {
            return Err(Error::Catalog("not a commenter".into()));
        }
        if self.read(|data| data.blocked_commenters.len() >= MAX_BLOCKED) {
            return Err(Error::Catalog("the block list is full".into()));
        }
        self.update(|data| {
            data.blocked_commenters.insert(commenter.to_owned());
        })
    }

    pub fn unblock(&self, commenter: &str) -> Result<()> {
        self.update(|data| {
            data.blocked_commenters.remove(commenter);
        })
    }

    fn read<T>(&self, f: impl FnOnce(&Data) -> T) -> T {
        f(&self.data.lock().unwrap_or_else(PoisonError::into_inner))
    }

    fn update(&self, f: impl FnOnce(&mut Data)) -> Result<()> {
        let mut data = self.data.lock().unwrap_or_else(PoisonError::into_inner);
        f(&mut data);
        write_atomically(&self.path, &serde_json::to_vec_pretty(&*data)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (tempfile::TempDir, State) {
        let dir = tempfile::tempdir().unwrap();
        let state = State::load(dir.path().join("catalog-state.json"));
        (dir, state)
    }

    #[test]
    fn the_sequence_only_ever_goes_up_and_survives_a_restart() {
        let (dir, state) = state();
        state.accept_sequence(7).unwrap();
        state.accept_sequence(3).unwrap();
        assert_eq!(state.sequence(), 7);
        let restarted = State::load(dir.path().join("catalog-state.json"));
        assert_eq!(restarted.sequence(), 7);
    }

    #[test]
    fn installs_are_recorded_and_forgotten() {
        let (_dir, state) = state();
        state.record_install("market.a", "abc").unwrap();
        assert_eq!(
            state.installed().get("market.a").map(String::as_str),
            Some("abc")
        );
        state.forget("market.a").unwrap();
        assert!(state.installed().is_empty());
    }

    #[test]
    fn counting_installs_starts_on_and_can_be_turned_off() {
        let (dir, state) = state();
        assert!(state.count_installs());
        state.set_count_installs(false).unwrap();
        assert!(!State::load(dir.path().join("catalog-state.json")).count_installs());
    }

    #[test]
    fn only_token_shaped_text_is_kept() {
        let (_dir, state) = state();
        state.set_edit_token("market.a", "abc_DEF-123").unwrap();
        assert_eq!(state.edit_token("market.a").as_deref(), Some("abc_DEF-123"));
        state.set_edit_token("market.b", "has space").unwrap();
        state.set_edit_token("market.c", &"x".repeat(65)).unwrap();
        assert_eq!(state.edit_token("market.b"), None);
        assert_eq!(state.edit_token("market.c"), None);
    }

    #[test]
    fn the_device_token_is_made_once_has_the_right_shape_and_survives_a_restart() {
        let (dir, state) = state();
        let token = state.device_token().unwrap();
        assert!(community::is_device_token(&token));
        assert_eq!(state.device_token().unwrap(), token);
        let restarted = State::load(dir.path().join("catalog-state.json"));
        assert_eq!(restarted.device_token().unwrap(), token);
    }

    #[test]
    fn a_stored_token_of_the_wrong_shape_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog-state.json");
        fs::write(&path, r#"{"deviceToken":"short"}"#).unwrap();
        let state = State::load(path);
        assert!(community::is_device_token(&state.device_token().unwrap()));
    }

    #[test]
    fn the_block_list_persists_stays_sorted_and_only_takes_commenter_ids() {
        let (dir, state) = state();
        state.block("bbbbbbbbbb").unwrap();
        state.block("aaaaaaaaaa").unwrap();
        state.block("aaaaaaaaaa").unwrap();
        for bad in ["", "AAAAAAAAAA", "aaaaaaaaa", "aaaaaaaaaaa", "../x"] {
            assert!(state.block(bad).is_err(), "{bad}");
        }
        assert_eq!(state.blocked(), ["aaaaaaaaaa", "bbbbbbbbbb"]);
        let restarted = State::load(dir.path().join("catalog-state.json"));
        assert_eq!(restarted.blocked(), ["aaaaaaaaaa", "bbbbbbbbbb"]);
        restarted.unblock("aaaaaaaaaa").unwrap();
        assert_eq!(restarted.blocked(), ["bbbbbbbbbb"]);
        restarted.unblock("cccccccccc").unwrap();
    }

    #[test]
    fn my_rating_is_kept_replaced_and_limited_to_one_to_five() {
        let (dir, state) = state();
        state.set_my_rating("market.a", 4).unwrap();
        state.set_my_rating("market.a", 2).unwrap();
        assert!(state.set_my_rating("market.a", 0).is_err());
        assert!(state.set_my_rating("market.a", 6).is_err());
        assert_eq!(state.my_rating("market.a"), Some(2));
        assert_eq!(state.my_rating("market.b"), None);
        let restarted = State::load(dir.path().join("catalog-state.json"));
        assert_eq!(restarted.my_rating("market.a"), Some(2));
    }

    #[test]
    fn a_damaged_file_is_a_fresh_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog-state.json");
        fs::write(&path, "{ not json").unwrap();
        let state = State::load(path);
        assert_eq!(state.sequence(), 0);
        assert!(state.count_installs());
    }
    #[test]
    fn an_unreadable_state_file_is_kept_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog-state.json");
        fs::write(&path, "{\"editTokens\": {\"market.x\": \"tok\"").unwrap();
        let state = State::load(path.clone());
        assert_eq!(state.edit_token("market.x"), None);
        state.accept_sequence(3).unwrap();
        let aside = fs::read_to_string(path.with_extension("json.corrupt")).unwrap();
        assert!(aside.contains("tok"));
    }
}
