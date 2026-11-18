//! What the manager keeps for each download, and what the shell is shown.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::kind::Kind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Queued,
    Downloading,
    Paused,
    Done,
    Failed,
    Cancelled,
}

impl Status {
    pub fn is_finished(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

/// One download as the shell lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: Uuid,
    pub url: String,
    pub file_name: String,
    /// Where the finished file is, or will be; unset until the server has answered.
    pub path: Option<String>,
    pub kind: Kind,
    pub status: Status,
    pub received: u64,
    pub total: Option<u64>,
    /// Bytes per second while downloading.
    pub speed: u64,
    /// Whether pausing keeps what has arrived.
    pub resumable: bool,
    pub error: Option<String>,
    pub site: String,
    /// Milliseconds since the Unix epoch.
    pub added_at: u64,
    pub finished_at: Option<u64>,
    /// Started in incognito: never saved to disk, gone when incognito ends.
    pub private: bool,
}

/// Where a download came from; the naming tokens read it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub page_url: Option<String>,
    pub page_title: Option<String>,
    pub label: Option<String>,
    pub index: usize,
}

/// One connection's share of a file: bytes `start..end`, of which `start..pos` are on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub start: u64,
    pub end: u64,
    pub pos: u64,
}

/// What it takes to carry on a download after a pause.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resume {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub download: Download,
    #[serde(default)]
    pub origin: Origin,
    #[serde(default)]
    pub resume: Option<Resume>,
}

/// One address to download, as the shell asks for it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddRequest {
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub kind: Option<Kind>,
    #[serde(default)]
    pub page_url: Option<String>,
    #[serde(default)]
    pub page_title: Option<String>,
}
