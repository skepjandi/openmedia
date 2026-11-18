//! The download list: what is queued, running, paused or finished, kept on disk between launches.
//!
//! The list is in memory behind one lock that is never held across an await. Each running download
//! is a task (`transfer.rs`) with a control channel; pausing and cancelling send on it. A download
//! started in incognito is marked private: it is never written to disk and `purge_private` drops it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tokio::sync::{Semaphore, watch};
use url::Url;
use uuid::Uuid;

use super::kind::{Kind, extension_of};
use super::model::{AddRequest, Download, Origin, Record, Status};
use super::naming::sanitize_component;
use super::settings::Settings;
use super::transfer;
use crate::error::{Error, Result};

const FILE_VERSION: u32 = 1;
const MAX_URL_CHARS: usize = 2048;
const MAX_FINISHED_KEPT: usize = 500;
const MAX_AT_ONCE: usize = 3;
pub(super) const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/// What a run is told to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Ctl {
    Run,
    Pause,
    Cancel,
}

pub(super) type Emit = dyn Fn(&Download) + Send + Sync;

#[derive(Serialize)]
struct SavedRef<'a> {
    version: u32,
    settings: &'a Settings,
    records: Vec<&'a Record>,
}

#[derive(Deserialize)]
struct Saved {
    version: u32,
    settings: Settings,
    records: Vec<Record>,
}

pub(super) struct State {
    pub settings: Settings,
    pub records: Vec<Record>,
    pub controls: HashMap<Uuid, watch::Sender<Ctl>>,
}

pub(super) struct Inner {
    pub file: PathBuf,
    pub default_root: PathBuf,
    pub client: reqwest::Client,
    pub emit: Box<Emit>,
    pub permits: Arc<Semaphore>,
    pub state: Mutex<State>,
}

#[derive(Clone)]
pub struct Manager {
    inner: Arc<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn site_of(url: &Url) -> String {
    url.host_str()
        .unwrap_or_default()
        .trim_start_matches("www.")
        .to_owned()
}

fn url_file_name(url: &Url) -> String {
    let segment = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();
    let decoded = percent_decode_str(segment).decode_utf8_lossy();
    let name = sanitize_component(&decoded);
    if name.is_empty() {
        "download".to_owned()
    } else {
        name
    }
}

pub(super) fn part_path(path: &Path) -> PathBuf {
    let mut part = path.as_os_str().to_owned();
    part.push(".part");
    PathBuf::from(part)
}

impl Inner {
    pub fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn save(&self, state: &State) {
        let records = state
            .records
            .iter()
            .filter(|record| !record.download.private)
            .collect();
        let saved = SavedRef {
            version: FILE_VERSION,
            settings: &state.settings,
            records,
        };
        // A list that cannot be written is lost on the next launch; the downloads themselves go on.
        let _ = write_atomically(&self.file, &saved);
    }

    /// Changes a record, saves the list when `save` and tells the shell. `None` when it is gone.
    pub fn mutate(
        &self,
        id: Uuid,
        save: bool,
        change: impl FnOnce(&mut Record),
    ) -> Option<Download> {
        let snapshot = {
            let mut state = self.lock();
            let record = state.records.iter_mut().find(|r| r.download.id == id)?;
            change(record);
            let snapshot = record.download.clone();
            if save {
                self.save(&state);
            }
            snapshot
        };
        (self.emit)(&snapshot);
        Some(snapshot)
    }

    /// Takes the control channel of a finished run.
    pub fn release(&self, id: Uuid) {
        self.lock().controls.remove(&id);
    }
}

fn write_atomically(file: &Path, value: &impl Serialize) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = file.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec(value)?)?;
    fs::rename(temporary, file)
}

fn trim_history(records: &mut Vec<Record>) {
    let finished = records
        .iter()
        .filter(|r| r.download.status.is_finished())
        .count();
    let mut excess = finished.saturating_sub(MAX_FINISHED_KEPT);
    records.retain(|record| {
        if excess > 0 && record.download.status.is_finished() {
            excess -= 1;
            return false;
        }
        true
    });
}

impl Manager {
    /// Loads the saved list. A download that was running when the app closed comes back paused when
    /// its bytes are still there to carry on from, failed otherwise.
    pub fn load(file: PathBuf, default_root: PathBuf, emit: Box<Emit>) -> Result<Self> {
        let saved = match fs::read(&file) {
            Ok(bytes) => {
                let saved: Saved = serde_json::from_slice(&bytes)?;
                if saved.version != FILE_VERSION {
                    return Err(Error::UnsupportedVersion(saved.version));
                }
                Some(saved)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let (settings, mut records) = saved.map_or_else(
            || (Settings::default(), Vec::new()),
            |saved| (saved.settings, saved.records),
        );
        for record in &mut records {
            interrupt(record);
        }
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| Error::Download("could not start the download engine".to_owned()))?;
        Ok(Self {
            inner: Arc::new(Inner {
                file,
                default_root,
                client,
                emit,
                permits: Arc::new(Semaphore::new(MAX_AT_ONCE)),
                state: Mutex::new(State {
                    settings,
                    records,
                    controls: HashMap::new(),
                }),
            }),
        })
    }

    pub(super) fn client(&self) -> &reqwest::Client {
        &self.inner.client
    }

    pub fn default_root(&self) -> &Path {
        &self.inner.default_root
    }

    pub fn settings(&self) -> Settings {
        self.inner.lock().settings.clone()
    }

    pub fn set_settings(&self, settings: Settings) -> Result<Settings> {
        let settings = settings.validated()?;
        let mut state = self.inner.lock();
        state.settings = settings.clone();
        self.inner.save(&state);
        Ok(settings)
    }

    pub fn list(&self) -> Vec<Download> {
        self.inner
            .lock()
            .records
            .iter()
            .map(|r| r.download.clone())
            .collect()
    }

    /// The file a finished download made.
    pub fn finished_path(&self, id: Uuid) -> Option<PathBuf> {
        let state = self.inner.lock();
        let download = &state.records.iter().find(|r| r.download.id == id)?.download;
        (download.status == Status::Done)
            .then(|| download.path.as_ref().map(PathBuf::from))
            .flatten()
    }

    /// Queues the addresses and starts them. A request that is not an `http` or `https` address
    /// fails the whole call before anything starts.
    pub fn add(&self, requests: Vec<AddRequest>, private: bool) -> Result<Vec<Download>> {
        let parsed: Vec<(AddRequest, Url)> = requests
            .into_iter()
            .map(|request| {
                let url = Url::parse(&request.url)
                    .ok()
                    .filter(|url| {
                        matches!(url.scheme(), "http" | "https")
                            && url.host_str().is_some()
                            && request.url.chars().count() <= MAX_URL_CHARS
                    })
                    .ok_or_else(|| {
                        Error::Download(
                            "only http and https addresses can be downloaded".to_owned(),
                        )
                    })?;
                Ok((request, url))
            })
            .collect::<Result<_>>()?;
        let mut added = Vec::with_capacity(parsed.len());
        {
            let mut state = self.inner.lock();
            for (index, (request, url)) in parsed.into_iter().enumerate() {
                let file_name = url_file_name(&url);
                let kind = request
                    .kind
                    .or_else(|| extension_of(&file_name).and_then(Kind::from_extension))
                    .unwrap_or(Kind::Other);
                let site = site_of(&url);
                let download = Download {
                    id: Uuid::new_v4(),
                    url: url.into(),
                    file_name,
                    path: None,
                    kind,
                    status: Status::Queued,
                    received: 0,
                    total: None,
                    speed: 0,
                    resumable: false,
                    error: None,
                    site,
                    added_at: now_ms(),
                    finished_at: None,
                    private,
                };
                added.push(download.clone());
                state.records.push(Record {
                    download,
                    origin: Origin {
                        page_url: request.page_url,
                        page_title: request.page_title,
                        label: request.label,
                        index: index + 1,
                    },
                    resume: None,
                });
            }
            trim_history(&mut state.records);
            self.inner.save(&state);
        }
        for download in &added {
            (self.inner.emit)(download);
            self.start(download.id);
        }
        Ok(added)
    }

    fn start(&self, id: Uuid) {
        let (sender, receiver) = watch::channel(Ctl::Run);
        self.inner.lock().controls.insert(id, sender);
        let inner = Arc::clone(&self.inner);
        tauri::async_runtime::spawn(transfer::run(inner, id, receiver));
    }

    fn signal(&self, id: Uuid, ctl: Ctl) -> bool {
        self.inner
            .lock()
            .controls
            .get(&id)
            .is_some_and(|sender| sender.send(ctl).is_ok())
    }

    fn status_of(&self, id: Uuid) -> Option<Status> {
        self.inner
            .lock()
            .records
            .iter()
            .find(|r| r.download.id == id)
            .map(|r| r.download.status)
    }

    pub fn pause(&self, id: Uuid) {
        self.signal(id, Ctl::Pause);
    }

    /// Carries on a paused or failed download, or starts a cancelled one over.
    pub fn resume(&self, id: Uuid) {
        let Some(status) = self.status_of(id) else {
            return;
        };
        if !matches!(status, Status::Paused | Status::Failed | Status::Cancelled)
            || self.inner.lock().controls.contains_key(&id)
        {
            return;
        }
        self.inner.mutate(id, true, |record| {
            if record.resume.is_none() || status == Status::Cancelled {
                discard_partial(record);
            }
            record.download.status = Status::Queued;
            record.download.error = None;
            record.download.finished_at = None;
        });
        self.start(id);
    }

    pub fn cancel(&self, id: Uuid) {
        if self.signal(id, Ctl::Cancel) {
            return;
        }
        if matches!(self.status_of(id), Some(Status::Paused | Status::Failed)) {
            self.inner.mutate(id, true, |record| {
                discard_partial(record);
                record.download.status = Status::Cancelled;
                record.download.error = None;
            });
        }
    }

    /// Takes a download off the list. A running one is cancelled; a finished file stays on disk.
    pub fn remove(&self, id: Uuid) {
        self.signal(id, Ctl::Cancel);
        let mut state = self.inner.lock();
        if let Some(position) = state.records.iter().position(|r| r.download.id == id) {
            let record = state.records.remove(position);
            if record.download.status != Status::Done {
                remove_partial(&record);
            }
            self.inner.save(&state);
        }
    }

    pub fn clear_finished(&self) {
        let mut state = self.inner.lock();
        state
            .records
            .retain(|record| !record.download.status.is_finished());
        self.inner.save(&state);
    }

    /// Drops what incognito downloaded, once incognito ends. Running ones are cancelled.
    pub fn purge_private(&self) {
        let ids: Vec<Uuid> = self
            .inner
            .lock()
            .records
            .iter()
            .filter(|r| r.download.private)
            .map(|r| r.download.id)
            .collect();
        for id in ids {
            self.remove(id);
        }
    }
}

fn interrupt(record: &mut Record) {
    let download = &mut record.download;
    if matches!(download.status, Status::Queued | Status::Downloading) {
        download.speed = 0;
        if record.resume.is_some()
            && download
                .path
                .as_deref()
                .is_some_and(|p| part_path(Path::new(p)).exists())
        {
            download.status = Status::Paused;
        } else {
            download.status = Status::Failed;
            download.error = Some("The app closed before this download finished.".to_owned());
        }
    }
}

fn remove_partial(record: &Record) {
    if let Some(path) = &record.download.path {
        let _ = fs::remove_file(part_path(Path::new(path)));
    }
}

/// Forgets what had arrived, so the next run starts the file over.
fn discard_partial(record: &mut Record) {
    remove_partial(record);
    record.resume = None;
    record.download.path = None;
    record.download.received = 0;
    record.download.total = None;
    record.download.speed = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_name_comes_from_the_last_path_segment() {
        let url = Url::parse("https://example.com/a/b/cat%20pic.jpg?x=1").unwrap();
        assert_eq!(url_file_name(&url), "cat pic.jpg");
        let bare = Url::parse("https://example.com/").unwrap();
        assert_eq!(url_file_name(&bare), "download");
        let hostile = Url::parse("https://example.com/..%2f..%2fetc%2fpasswd").unwrap();
        assert!(!url_file_name(&hostile).contains('/'));
    }

    #[test]
    fn only_web_addresses_are_accepted_and_nothing_starts_on_a_bad_one() {
        let dir = tempfile::tempdir().unwrap();
        let manager = Manager::load(
            dir.path().join("d.json"),
            dir.path().into(),
            Box::new(|_| {}),
        )
        .unwrap();
        let bad = |url: &str| AddRequest {
            url: url.to_owned(),
            label: None,
            kind: None,
            page_url: None,
            page_title: None,
        };
        for url in [
            "file:///etc/passwd",
            "javascript:1",
            "data:text/plain,hi",
            "ftp://a/b",
            "not a url",
        ] {
            assert!(manager.add(vec![bad(url)], false).is_err(), "{url}");
        }
        assert!(
            manager
                .add(vec![bad("https://ok.example/x"), bad("file:///x")], false)
                .is_err()
        );
        assert!(manager.list().is_empty());
    }

    #[test]
    fn interrupted_downloads_come_back_paused_or_failed() {
        let mut record = Record {
            download: Download {
                id: Uuid::nil(),
                url: "https://a/b".into(),
                file_name: "b".into(),
                path: Some("/nonexistent/b".into()),
                kind: Kind::Other,
                status: Status::Downloading,
                received: 5,
                total: Some(10),
                speed: 9,
                resumable: true,
                error: None,
                site: "a".into(),
                added_at: 0,
                finished_at: None,
                private: false,
            },
            origin: Origin::default(),
            resume: None,
        };
        interrupt(&mut record);
        assert_eq!(record.download.status, Status::Failed);
        assert_eq!(record.download.speed, 0);
    }
}
