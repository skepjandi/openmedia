//! Saved assistant chats. A chat belongs to a site (its registrable domain) and, once the
//! assistant has proposed something, to the recipe that proposal is about; reopening the
//! assistant on that site continues it. A turn keeps what the user asked, the steps the assistant
//! took, and how it ended. It never keeps the page snapshot or the exact payload.
//!
//! The file is the user's own and never leaves the device. It is disposable like the usage
//! numbers: a missing, corrupt or newer-format file starts empty. Nothing is saved in incognito
//! (see the commands), and the user can delete one chat or all of them.

use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{activity::Activity, agent::Proposal};
use crate::error::{Error, Result};
use crate::library::write_atomically;
use crate::recipes::script_policy;

const FORMAT_VERSION: u32 = 1;
pub const MAX_SESSIONS: usize = 60;
pub const MAX_TURNS: usize = 40;
const MAX_STEPS: usize = 24;
const MAX_RULES: usize = 8;
const MAX_REQUEST_CHARS: usize = 500;
const MAX_TITLE_CHARS: usize = 60;
const MAX_NAME_CHARS: usize = 30;
const MAX_DOMAIN_CHARS: usize = 253;
const MAX_SHORT_CHARS: usize = 200;
const MAX_SELECTOR_CHARS: usize = 300;
const MAX_POWERS: usize = 50;

/// How one turn ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum Outcome {
    /// Waiting for the user. A saved turn in this state was left unanswered: the preview is gone
    /// from the page, so the shell offers to ask again instead of accepting.
    Proposed {
        proposal: Proposal,
    },
    Accepted {
        proposal: Proposal,
    },
    Rejected {
        proposal: Proposal,
    },
    /// `kind` is the shell's error class, `text` the short line Rust sent when there is no fixed
    /// one for the class.
    Failed {
        kind: String,
        text: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatTurn {
    pub id: Uuid,
    pub request: String,
    /// Milliseconds since the epoch, from the shell's clock.
    pub at: i64,
    /// The provider asked, by the name the user gave it.
    #[serde(default)]
    pub provider: Option<String>,
    pub steps: Vec<Activity>,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatSession {
    pub id: Uuid,
    /// The site: a registrable domain such as `youtube.com`.
    pub domain: String,
    /// The recipe the assistant worked on, once it proposed something.
    pub recipe_id: Option<String>,
    pub recipe_name: Option<String>,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub turns: Vec<ChatTurn>,
}

fn cut(text: &mut String, max: usize) {
    if let Some((index, _)) = text.char_indices().nth(max) {
        text.truncate(index);
    }
}

fn cut_proposal(proposal: &mut Proposal) {
    cut(&mut proposal.summary, MAX_SHORT_CHARS);
    cut(&mut proposal.recipe_id, MAX_SHORT_CHARS);
    cut(&mut proposal.recipe_name, MAX_SHORT_CHARS);
    cut(&mut proposal.option.label, MAX_SHORT_CHARS);
    cut(&mut proposal.option.description, MAX_SHORT_CHARS);
    proposal.rules.truncate(MAX_RULES);
    for rule in &mut proposal.rules {
        cut(&mut rule.label, MAX_SHORT_CHARS);
        cut(&mut rule.selector, MAX_SELECTOR_CHARS);
        if let Some(code) = &mut rule.code {
            cut(code, script_policy::MAX_CODE_BYTES);
        }
        rule.powers.truncate(MAX_POWERS);
        for power in &mut rule.powers {
            cut(&mut power.code, MAX_SHORT_CHARS);
            cut(&mut power.message, MAX_SHORT_CHARS);
        }
    }
}

impl ChatSession {
    /// Refuses what cannot be a chat and cuts what is too long, so the file stays small whatever
    /// the shell sends.
    fn bounded(mut self) -> Result<Self> {
        let host_like = !self.domain.is_empty()
            && self.domain.chars().count() <= MAX_DOMAIN_CHARS
            && self
                .domain
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
        if !host_like {
            return Err(Error::InvalidChat("a chat belongs to a site"));
        }
        if self.turns.is_empty() {
            return Err(Error::InvalidChat("a chat needs at least one turn"));
        }
        if self.created_at < 0 || self.updated_at < 0 {
            return Err(Error::InvalidChat("a chat needs a time"));
        }
        cut(&mut self.title, MAX_TITLE_CHARS);
        if let Some(id) = self.recipe_id.as_mut() {
            cut(id, MAX_SHORT_CHARS);
        }
        if let Some(name) = self.recipe_name.as_mut() {
            cut(name, MAX_SHORT_CHARS);
        }
        let overflow = self.turns.len().saturating_sub(MAX_TURNS);
        self.turns.drain(..overflow);
        for turn in &mut self.turns {
            cut(&mut turn.request, MAX_REQUEST_CHARS);
            turn.steps.truncate(MAX_STEPS);
            if let Some(name) = &mut turn.provider {
                cut(name, MAX_NAME_CHARS);
            }
            match &mut turn.outcome {
                Outcome::Proposed { proposal }
                | Outcome::Accepted { proposal }
                | Outcome::Rejected { proposal } => cut_proposal(proposal),
                Outcome::Failed { kind, text } => {
                    cut(kind, 24);
                    if let Some(line) = text.as_mut() {
                        cut(line, MAX_SHORT_CHARS);
                    }
                }
            }
        }
        Ok(self)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatData {
    version: u32,
    sessions: Vec<ChatSession>,
}

impl ChatData {
    fn empty() -> Self {
        Self {
            version: FORMAT_VERSION,
            sessions: Vec::new(),
        }
    }
}

pub struct Chats {
    path: PathBuf,
    data: Mutex<ChatData>,
}

fn parse(text: &str) -> ChatData {
    serde_json::from_str::<ChatData>(text)
        .ok()
        .filter(|data| data.version == FORMAT_VERSION)
        .unwrap_or_else(ChatData::empty)
}

impl Chats {
    pub fn load(path: PathBuf) -> Result<Self> {
        let data = match fs::read_to_string(&path) {
            Ok(text) => parse(&text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ChatData::empty(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            path,
            data: Mutex::new(data),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, ChatData>> {
        self.data.lock().map_err(|_| Error::Poisoned)
    }

    fn persist(&self, data: &ChatData) -> Result<()> {
        write_atomically(&self.path, &serde_json::to_vec(data)?)?;
        Ok(())
    }

    /// Every chat, the most recently used first.
    pub fn list(&self) -> Result<Vec<ChatSession>> {
        let mut sessions = self.lock()?.sessions.clone();
        sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
        Ok(sessions)
    }

    /// Adds the chat or replaces the one with the same id. Past [`MAX_SESSIONS`] the least
    /// recently used chats are dropped.
    pub fn save(&self, session: ChatSession) -> Result<()> {
        let session = session.bounded()?;
        let mut data = self.lock()?;
        data.sessions.retain(|saved| saved.id != session.id);
        data.sessions.push(session);
        if data.sessions.len() > MAX_SESSIONS {
            data.sessions
                .sort_by_key(|saved| std::cmp::Reverse(saved.updated_at));
            data.sessions.truncate(MAX_SESSIONS);
        }
        self.persist(&data)
    }

    pub fn delete(&self, id: Uuid) -> Result<()> {
        let mut data = self.lock()?;
        data.sessions.retain(|saved| saved.id != id);
        self.persist(&data)
    }

    pub fn clear(&self) -> Result<()> {
        let mut data = self.lock()?;
        data.sessions.clear();
        self.persist(&data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::agent::{ProposalKind, ProposalOption, ProposalRule, ProposalRuleKind};
    use crate::recipes::OptionGroup;

    fn proposal() -> Proposal {
        Proposal {
            id: Uuid::new_v4(),
            kind: ProposalKind::NewOption,
            summary: "Hides the promo".into(),
            recipe_id: "custom.example.org".into(),
            recipe_name: "example.org".into(),
            option: ProposalOption {
                id: None,
                label: "Hide promo".into(),
                description: "The promo box.".into(),
                group: OptionGroup::Content,
            },
            rules: vec![ProposalRule {
                label: "Promo".into(),
                kind: ProposalRuleKind::Style,
                selector: "#promo".into(),
                matches: 2,
                code: None,
                powers: Vec::new(),
            }],
            unmatched: 0,
            runs_code: false,
            publishable: true,
        }
    }

    fn turn(request: &str, outcome: Outcome) -> ChatTurn {
        ChatTurn {
            id: Uuid::new_v4(),
            request: request.into(),
            at: 1,
            provider: Some("Claude".into()),
            steps: Vec::new(),
            outcome,
        }
    }

    fn session(domain: &str, updated_at: i64) -> ChatSession {
        ChatSession {
            id: Uuid::new_v4(),
            domain: domain.into(),
            recipe_id: None,
            recipe_name: None,
            title: "Hide the promo".into(),
            created_at: updated_at,
            updated_at,
            turns: vec![turn(
                "hide the promo",
                Outcome::Accepted {
                    proposal: proposal(),
                },
            )],
        }
    }

    fn store() -> (tempfile::TempDir, Chats) {
        let dir = tempfile::tempdir().unwrap();
        let chats = Chats::load(dir.path().join("chats.json")).unwrap();
        (dir, chats)
    }

    #[test]
    fn a_saved_chat_survives_a_restart_and_saving_again_replaces_it() {
        let (dir, chats) = store();
        let mut chat = session("example.org", 10);
        chats.save(chat.clone()).unwrap();
        chat.turns.push(turn(
            "and the footer",
            Outcome::Failed {
                kind: "network".into(),
                text: None,
            },
        ));
        chat.updated_at = 20;
        chats.save(chat.clone()).unwrap();

        let reopened = Chats::load(dir.path().join("chats.json")).unwrap();
        assert_eq!(reopened.list().unwrap(), vec![chat]);
    }

    #[test]
    fn the_most_recently_used_chat_comes_first_and_the_oldest_are_dropped_at_the_cap() {
        let (_dir, chats) = store();
        for n in 0..=i64::try_from(MAX_SESSIONS).unwrap() {
            chats.save(session("example.org", n)).unwrap();
        }
        let listed = chats.list().unwrap();
        assert_eq!(listed.len(), MAX_SESSIONS);
        assert_eq!(
            listed[0].updated_at,
            i64::try_from(MAX_SESSIONS).unwrap(),
            "newest first"
        );
        assert_eq!(listed.last().unwrap().updated_at, 1, "the oldest is gone");
    }

    #[test]
    fn deleting_one_chat_leaves_the_others_and_clearing_removes_all() {
        let (dir, chats) = store();
        let keep = session("example.org", 1);
        let drop = session("other.net", 2);
        chats.save(keep.clone()).unwrap();
        chats.save(drop.clone()).unwrap();
        chats.delete(drop.id).unwrap();
        assert_eq!(chats.list().unwrap(), vec![keep]);
        chats.clear().unwrap();
        assert!(chats.list().unwrap().is_empty());
        let reopened = Chats::load(dir.path().join("chats.json")).unwrap();
        assert_eq!(reopened.list().unwrap().len(), 0);
    }

    #[test]
    fn what_cannot_be_a_chat_is_refused_and_what_is_too_long_is_cut() {
        let (_dir, chats) = store();
        assert!(chats.save(session("", 1)).is_err());
        assert!(chats.save(session("Not A Host/", 1)).is_err());
        let mut empty = session("example.org", 1);
        empty.turns.clear();
        assert!(chats.save(empty).is_err());

        let mut long = session("example.org", 1);
        long.title = "t".repeat(500);
        long.turns = (0..MAX_TURNS + 5)
            .map(|n| {
                turn(
                    &format!("{n}{}", "x".repeat(900)),
                    Outcome::Rejected {
                        proposal: proposal(),
                    },
                )
            })
            .collect();
        chats.save(long).unwrap();
        let saved = chats.list().unwrap().remove(0);
        assert_eq!(saved.title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(saved.turns.len(), MAX_TURNS);
        assert!(
            saved.turns[0].request.starts_with('5'),
            "the oldest turns go first"
        );
        assert_eq!(saved.turns[0].request.chars().count(), MAX_REQUEST_CHARS);
    }

    #[test]
    fn a_corrupt_or_newer_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chats.json");
        fs::write(&path, "{not json").unwrap();
        assert_eq!(Chats::load(path.clone()).unwrap().list().unwrap().len(), 0);
        fs::write(&path, r#"{"version":99,"sessions":[]}"#).unwrap();
        assert_eq!(Chats::load(path).unwrap().list().unwrap().len(), 0);
    }

    #[test]
    fn unknown_fields_are_refused_so_the_shell_cannot_smuggle_data_into_the_file() {
        let json = serde_json::to_value(session("example.org", 1)).unwrap();
        let mut tampered = json.clone();
        tampered["payload"] = "the whole prompt".into();
        assert!(serde_json::from_value::<ChatSession>(tampered).is_err());
        assert!(serde_json::from_value::<ChatSession>(json).is_ok());
    }

    /// The shape the shell sends: `src/features/ai/ipc.ts`. If one side changes, this fails.
    #[test]
    fn the_shape_the_shell_sends_is_accepted() {
        let json = serde_json::json!({
            "id": "3f1b0a52-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
            "domain": "youtube.com",
            "recipeId": "custom.youtube.com",
            "recipeName": "youtube.com",
            "title": "hide the promo",
            "createdAt": 1_700_000_000_000i64,
            "updatedAt": 1_700_000_000_000i64,
            "turns": [{
                "id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
                "request": "hide the promo",
                "at": 1_700_000_000_000i64,
                "provider": "MiniMax",
                "steps": [
                    {"kind": "readPage", "status": "done", "round": 0, "matched": null, "total": 1234},
                    {"kind": "askModel", "status": "done", "round": 0, "matched": null, "total": null},
                    {"kind": "countMatches", "status": "done", "round": 0, "matched": 1, "total": 2}
                ],
                "outcome": {
                    "status": "accepted",
                    "proposal": {
                        "id": "1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
                        "kind": "newOption",
                        "summary": "Hides the promo",
                        "recipeId": "custom.youtube.com",
                        "recipeName": "youtube.com",
                        "option": {
                            "id": null,
                            "label": "Hide promo",
                            "description": "The promo box.",
                            "group": "content"
                        },
                        "rules": [{"label": "Promo", "kind": "style", "selector": "#promo", "matches": 2, "code": null, "powers": []}],
                        "unmatched": 0,
                        "runsCode": false,
                        "publishable": true
                    }
                }
            }]
        });
        let chat: ChatSession = serde_json::from_value(json).unwrap();
        assert_eq!(chat.turns[0].steps.len(), 3);
        let (_dir, chats) = store();
        chats.save(chat).unwrap();
        assert_eq!(chats.list().unwrap().len(), 1);
    }

    #[test]
    fn a_proposal_saved_before_script_rules_still_loads() {
        let old = serde_json::json!({
            "id": "1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
            "kind": "newOption",
            "summary": "Hides the promo",
            "recipeId": "custom.youtube.com",
            "recipeName": "youtube.com",
            "option": { "id": null, "label": "Hide promo", "description": "The promo box.", "group": "content" },
            "rules": [{ "label": "Promo", "selector": "#promo", "matches": 2 }],
            "unmatched": 0
        });
        let json = serde_json::json!({
            "version": FORMAT_VERSION,
            "sessions": [{
                "id": "7f3e2d1c-0b9a-4c8d-9e7f-6a5b4c3d2e1f",
                "domain": "youtube.com",
                "recipeId": "custom.youtube.com",
                "recipeName": "youtube.com",
                "title": "hide the promo",
                "createdAt": 1_700_000_000_000i64,
                "updatedAt": 1_700_000_000_000i64,
                "turns": [{
                    "id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
                    "request": "hide the promo",
                    "at": 1_700_000_000_000i64,
                    "provider": "MiniMax",
                    "steps": [],
                    "outcome": { "status": "accepted", "proposal": old }
                }]
            }]
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chats.json");
        fs::write(&path, json.to_string()).unwrap();
        let chats = Chats::load(path).unwrap();
        let listed = chats.list().unwrap();
        assert_eq!(listed.len(), 1, "the old file is kept, not wiped");
        let Outcome::Accepted { proposal } = &listed[0].turns[0].outcome else {
            panic!("expected an accepted turn");
        };
        let rule = &proposal.rules[0];
        assert_eq!(rule.kind, ProposalRuleKind::Style);
        assert!(rule.code.is_none() && rule.powers.is_empty());
        assert!(!proposal.runs_code && proposal.publishable);
    }
}
