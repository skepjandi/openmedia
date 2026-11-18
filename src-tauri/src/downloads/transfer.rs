//! The network side of one download: ask the server, split a large file over several connections,
//! write into a `.part` file, and move it into place when every byte has arrived.
//!
//! A server that honours `Range` lets a download pause and carry on from where each connection
//! stopped; one that does not gets a single connection and starts over after a pause. The request
//! carries no cookies and no credentials: a link that only works for a signed-in browser session
//! fails with the server's refusal.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use reqwest::header::{self, HeaderMap};
use reqwest::{Response, StatusCode};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::{MissedTickBehavior, interval, sleep, timeout};
use url::Url;
use uuid::Uuid;

use super::kind::{Kind, extension_for_mime, extension_of};
use super::manager::{Ctl, Inner, part_path};
use super::model::{Origin, Resume, Segment, Status};
use super::naming::{NameContext, expand_folder, expand_mask, sanitize_component, unique_path};

/// A file smaller than twice this is not worth a second connection.
const MIN_SEGMENT: u64 = 1 << 20;
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const TICK: Duration = Duration::from_millis(300);
const SAVE_EVERY_TICKS: u32 = 7;
const MAX_RETRIES: u32 = 3;
const NETWORK_FAILURE: &str = "The connection was lost.";
const CHANGED: &str = "The file changed on the server. Retry to download it again.";
const DISK_FAILURE: &str = "The file could not be written to the download folder.";

enum Outcome {
    Done,
    Paused,
    Cancelled,
    Failed(String),
}

enum SegmentEnd {
    Done,
    Stopped(Ctl),
}

struct Shared {
    client: reqwest::Client,
    url: Url,
    referer: Option<String>,
    validator: Option<String>,
    part: PathBuf,
    starts: Vec<u64>,
    ends: Vec<u64>,
    positions: Vec<AtomicU64>,
    received: AtomicU64,
}

struct Started {
    response: Response,
    total: Option<u64>,
    resumable: bool,
    etag: Option<String>,
    last_modified: Option<String>,
    part: PathBuf,
}

/// Waits until the run is told to stop, and says how.
async fn stopped(ctl: &mut watch::Receiver<Ctl>) -> Ctl {
    loop {
        let current = *ctl.borrow_and_update();
        if current != Ctl::Run {
            return current;
        }
        if ctl.changed().await.is_err() {
            return Ctl::Cancel;
        }
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
}

/// The task for one download: waits its turn, then transfers.
pub(super) async fn run(inner: Arc<Inner>, id: Uuid, mut ctl: watch::Receiver<Ctl>) {
    let permit = tokio::select! {
        permit = Arc::clone(&inner.permits).acquire_owned() => permit.ok(),
        stop = stopped(&mut ctl) => {
            settle(&inner, id, &match stop {
                Ctl::Cancel => Outcome::Cancelled,
                _ => Outcome::Paused,
            });
            return;
        }
    };
    let Some(_permit) = permit else {
        return;
    };
    inner.mutate(id, false, |record| {
        record.download.status = Status::Downloading;
        record.download.error = None;
    });
    let outcome = transfer(&inner, id, &mut ctl).await;
    settle(&inner, id, &outcome);
}

fn settle(inner: &Inner, id: Uuid, outcome: &Outcome) {
    inner.release(id);
    inner.mutate(id, true, |record| {
        let download = &mut record.download;
        download.speed = 0;
        match outcome {
            Outcome::Done => {
                download.status = Status::Done;
                download.finished_at = Some(now_ms());
                download.resumable = false;
                record.resume = None;
            }
            Outcome::Paused => download.status = Status::Paused,
            Outcome::Cancelled => {
                if let Some(path) = &download.path {
                    let _ = fs::remove_file(part_path(Path::new(path)));
                }
                download.status = Status::Cancelled;
                download.path = None;
                download.received = 0;
                download.total = None;
                record.resume = None;
            }
            Outcome::Failed(message) => {
                download.status = Status::Failed;
                download.error = Some(message.clone());
            }
        }
    });
}

fn now_ms() -> u64 {
    u64::try_from(now_secs()).unwrap_or(0) * 1000
}

struct Job {
    url: Url,
    referer: Option<String>,
    resume: Option<Resume>,
    path: Option<PathBuf>,
    wanted_segments: usize,
}

fn job_of(inner: &Inner, id: Uuid) -> Option<Job> {
    let state = inner.lock();
    let record = state.records.iter().find(|r| r.download.id == id)?;
    let referer = record
        .origin
        .page_url
        .as_deref()
        .and_then(|page| Url::parse(page).ok())
        .map(|page| format!("{}/", page.origin().ascii_serialization()));
    Some(Job {
        url: Url::parse(&record.download.url).ok()?,
        referer,
        resume: record.resume.clone(),
        path: record.download.path.as_deref().map(PathBuf::from),
        wanted_segments: usize::from(state.settings.segments),
    })
}

async fn send(
    client: &reqwest::Client,
    url: &Url,
    referer: Option<&str>,
    range: Option<String>,
    validator: Option<&str>,
) -> Result<Response, String> {
    let mut request = client.get(url.clone());
    if let Some(referer) = referer {
        request = request.header(header::REFERER, referer);
    }
    if let Some(range) = range {
        request = request.header(header::RANGE, range);
        if let Some(validator) = validator {
            request = request.header(header::IF_RANGE, validator);
        }
    }
    let response = request
        .send()
        .await
        .map_err(|_| NETWORK_FAILURE.to_owned())?;
    let status = response.status();
    if status.is_success() {
        Ok(response)
    } else {
        Err(format!(
            "The server refused the download (HTTP {}).",
            status.as_u16()
        ))
    }
}

fn header_text(headers: &HeaderMap, name: header::HeaderName) -> Option<String> {
    headers.get(name)?.to_str().ok().map(str::to_owned)
}

/// The size after the slash of `Content-Range: bytes 0-9/100`.
fn content_range_total(value: &str) -> Option<u64> {
    value.rsplit_once('/')?.1.trim().parse().ok()
}

/// The file name a `Content-Disposition` header asks for.
fn disposition_name(value: &str) -> Option<String> {
    let mut plain = None;
    for part in value.split(';').skip(1) {
        let (key, raw) = part.split_once('=')?;
        let raw = raw.trim();
        match key.trim().to_ascii_lowercase().as_str() {
            "filename*" => {
                let encoded = raw.splitn(3, '\'').nth(2)?;
                return Some(percent_decode_str(encoded).decode_utf8_lossy().into_owned());
            }
            "filename" => plain = Some(raw.trim_matches('"').to_owned()),
            _ => {}
        }
    }
    plain
}

fn final_file_name(headers: &HeaderMap, provisional: &str) -> String {
    let named = header_text(headers, header::CONTENT_DISPOSITION)
        .and_then(|value| disposition_name(&value))
        .map(|name| {
            name.rsplit(['/', '\\'])
                .next()
                .unwrap_or_default()
                .to_owned()
        })
        .map(|name| sanitize_component(&name))
        .filter(|name| !name.is_empty());
    let mut name = named.unwrap_or_else(|| provisional.to_owned());
    if extension_of(&name).is_none()
        && let Some(extension) = header_text(headers, header::CONTENT_TYPE)
            .as_deref()
            .and_then(extension_for_mime)
    {
        name.push('.');
        name.push_str(extension);
    }
    name
}

fn root_of(inner: &Inner) -> PathBuf {
    inner
        .lock()
        .settings
        .folder
        .as_ref()
        .map_or_else(|| inner.default_root.clone(), PathBuf::from)
}

/// Asks the server for the whole file and decides where it will be saved.
async fn begin(inner: &Arc<Inner>, id: Uuid, job: &Job) -> Result<Started, Outcome> {
    let response = send(
        &inner.client,
        &job.url,
        job.referer.as_deref(),
        Some("bytes=0-".to_owned()),
        None,
    )
    .await
    .map_err(Outcome::Failed)?;
    let headers = response.headers().clone();
    let partial = response.status() == StatusCode::PARTIAL_CONTENT;
    let (total, resumable) = if partial {
        let total =
            header_text(&headers, header::CONTENT_RANGE).and_then(|v| content_range_total(&v));
        (total, total.is_some())
    } else {
        let total = response.content_length();
        let ranges = header_text(&headers, header::ACCEPT_RANGES)
            .is_some_and(|v| v.eq_ignore_ascii_case("bytes"));
        (total, ranges && total.is_some())
    };
    let (file_name, origin, routing) = {
        let state = inner.lock();
        let record = state
            .records
            .iter()
            .find(|r| r.download.id == id)
            .ok_or(Outcome::Cancelled)?;
        let file_name = final_file_name(&headers, &record.download.file_name);
        let kind = extension_of(&file_name)
            .and_then(Kind::from_extension)
            .unwrap_or_else(|| {
                Kind::from_mime(&header_text(&headers, header::CONTENT_TYPE).unwrap_or_default())
            });
        let routing = state.settings.route(&job.url, kind);
        (
            file_name,
            (record.origin.clone(), kind),
            (routing.mask.to_owned(), routing.folder.map(str::to_owned)),
        )
    };
    let (origin, kind) = origin;
    let (path, part) = plan_target(inner, &job.url, &file_name, &origin, kind, &routing)
        .map_err(Outcome::Failed)?;
    if let Some(total) = total
        && let Ok(file) = fs::OpenOptions::new().write(true).open(&part)
    {
        file.set_len(total)
            .map_err(|_| Outcome::Failed(DISK_FAILURE.to_owned()))?;
    }
    inner.mutate(id, true, |record| {
        let download = &mut record.download;
        download.file_name = path
            .file_name()
            .map_or_else(|| file_name.clone(), |n| n.to_string_lossy().into_owned());
        download.path = Some(path.to_string_lossy().into_owned());
        download.kind = kind;
        download.total = total;
        download.resumable = resumable;
    });
    Ok(Started {
        response,
        total,
        resumable,
        etag: header_text(&headers, header::ETAG),
        last_modified: header_text(&headers, header::LAST_MODIFIED),
        part,
    })
}

/// Picks the file's name and creates its `.part` file. The part file is made with `create_new`, so
/// two downloads of the same name cannot take the same place.
fn plan_target(
    inner: &Inner,
    url: &Url,
    file_name: &str,
    origin: &Origin,
    kind: Kind,
    routing: &(String, Option<String>),
) -> Result<(PathBuf, PathBuf), String> {
    let context = NameContext {
        url,
        file_name,
        label: origin.label.as_deref().filter(|l| !l.is_empty()),
        page_title: origin.page_title.as_deref().filter(|t| !t.is_empty()),
        kind,
        index: origin.index,
        now: now_secs(),
    };
    let mut parts = routing
        .1
        .as_deref()
        .map(|folder| expand_folder(folder, &context))
        .unwrap_or_default();
    parts.extend(expand_mask(&routing.0, &context));
    let root = root_of(inner);
    for _ in 0..50 {
        let path = unique_path(&root, &parts, |p| p.exists() || part_path(p).exists());
        let part = part_path(&path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| DISK_FAILURE.to_owned())?;
        }
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
        {
            Ok(_) => return Ok((path, part)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(DISK_FAILURE.to_owned()),
        }
    }
    Err(DISK_FAILURE.to_owned())
}

fn split(total: Option<u64>, resumable: bool, wanted: usize) -> Vec<Segment> {
    let Some(total) = total else {
        return vec![Segment {
            start: 0,
            end: u64::MAX,
            pos: 0,
        }];
    };
    let count = if resumable {
        usize::try_from(total / MIN_SEGMENT)
            .unwrap_or(usize::MAX)
            .clamp(1, wanted.max(1))
    } else {
        1
    };
    let size = total.div_ceil(count as u64).max(1);
    (0..count as u64)
        .map(|i| Segment {
            start: (i * size).min(total),
            end: ((i + 1) * size).min(total),
            pos: (i * size).min(total),
        })
        .filter(|segment| segment.end > segment.start || total == 0)
        .collect()
}

async fn transfer(inner: &Arc<Inner>, id: Uuid, ctl: &mut watch::Receiver<Ctl>) -> Outcome {
    let Some(job) = job_of(inner, id) else {
        return Outcome::Cancelled;
    };
    let resuming = job
        .resume
        .clone()
        .zip(job.path.clone())
        .filter(|(_, path)| part_path(path).exists());
    let (segments, total, etag, last_modified, part, mut first, resumable) = match resuming {
        Some((resume, path)) => {
            let total = resume.segments.last().map(|s| s.end);
            (
                resume.segments,
                total,
                resume.etag,
                resume.last_modified,
                part_path(&path),
                None,
                true,
            )
        }
        None => {
            let started = tokio::select! {
                started = begin(inner, id, &job) => match started {
                    Ok(started) => started,
                    Err(outcome) => return outcome,
                },
                stop = stopped(ctl) => return if stop == Ctl::Cancel { Outcome::Cancelled } else { Outcome::Paused },
            };
            let segments = split(started.total, started.resumable, job.wanted_segments);
            (
                segments,
                started.total,
                started.etag,
                started.last_modified,
                started.part,
                Some(started.response),
                started.resumable,
            )
        }
    };
    let shared = Arc::new(Shared {
        client: inner.client.clone(),
        url: job.url.clone(),
        referer: job.referer.clone(),
        validator: etag.clone().or_else(|| last_modified.clone()),
        part: part.clone(),
        starts: segments.iter().map(|s| s.start).collect(),
        ends: segments.iter().map(|s| s.end).collect(),
        positions: segments.iter().map(|s| AtomicU64::new(s.pos)).collect(),
        received: AtomicU64::new(segments.iter().map(|s| s.pos - s.start).sum()),
    });
    let snapshot = |shared: &Shared| Resume {
        etag: etag.clone(),
        last_modified: last_modified.clone(),
        segments: (0..shared.ends.len())
            .map(|i| Segment {
                start: shared.starts[i],
                end: shared.ends[i],
                pos: shared.positions[i].load(Ordering::Relaxed),
            })
            .collect(),
    };
    let mut set = JoinSet::new();
    for index in 0..segments.len() {
        let response = if index == 0 { first.take() } else { None };
        set.spawn(segment(Arc::clone(&shared), index, response, ctl.clone()));
    }
    let mut ticker = interval(TICK);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut last = (Instant::now(), shared.received.load(Ordering::Relaxed));
    let mut ticks = 0u32;
    let mut stop = None;
    let mut failure: Option<String> = None;
    loop {
        tokio::select! {
            joined = set.join_next() => match joined {
                None => break,
                Some(Ok(Ok(SegmentEnd::Done))) => {}
                Some(Ok(Ok(SegmentEnd::Stopped(ctl)))) => stop = Some(ctl),
                Some(Ok(Err(message))) => {
                    failure.get_or_insert(message);
                    set.abort_all();
                }
                Some(Err(_)) => {
                    failure.get_or_insert_with(|| NETWORK_FAILURE.to_owned());
                    set.abort_all();
                }
            },
            _ = ticker.tick() => {
                let received = shared.received.load(Ordering::Relaxed);
                let elapsed = last.0.elapsed().as_secs_f64().max(0.001);
                let speed = (received.saturating_sub(last.1) as f64 / elapsed) as u64;
                last = (Instant::now(), received);
                ticks += 1;
                let save = ticks.is_multiple_of(SAVE_EVERY_TICKS);
                let resume = save.then(|| snapshot(&shared));
                inner.mutate(id, save, |record| {
                    record.download.received = received;
                    record.download.speed = speed;
                    if let Some(resume) = resume {
                        record.resume = resumable.then_some(resume);
                    }
                });
            }
        }
    }
    let received = shared.received.load(Ordering::Relaxed);
    let resume = resumable.then(|| snapshot(&shared));
    inner.mutate(id, false, |record| {
        record.download.received = received;
        record.resume = resume;
    });
    if let Some(message) = failure {
        return Outcome::Failed(message);
    }
    match stop {
        Some(Ctl::Cancel) => return Outcome::Cancelled,
        Some(_) => return Outcome::Paused,
        None => {}
    }
    if total.is_some_and(|total| received != total) {
        return Outcome::Failed("The file arrived incomplete.".to_owned());
    }
    finish_file(inner, id, &part, received)
}

/// Moves the finished `.part` file to its name.
fn finish_file(inner: &Inner, id: Uuid, part: &Path, received: u64) -> Outcome {
    let Some(path) = inner
        .lock()
        .records
        .iter()
        .find(|r| r.download.id == id)
        .and_then(|r| r.download.path.clone())
    else {
        return Outcome::Cancelled;
    };
    if fs::rename(part, &path).is_err() {
        return Outcome::Failed(DISK_FAILURE.to_owned());
    }
    inner.mutate(id, false, |record| {
        record.download.received = received;
        record.download.total = Some(received);
    });
    Outcome::Done
}

fn range_header(pos: u64, end: u64) -> String {
    if end == u64::MAX {
        format!("bytes={pos}-")
    } else {
        format!("bytes={pos}-{}", end - 1)
    }
}

async fn segment(
    shared: Arc<Shared>,
    index: usize,
    mut first: Option<Response>,
    mut ctl: watch::Receiver<Ctl>,
) -> Result<SegmentEnd, String> {
    let end = shared.ends[index];
    let unbounded = end == u64::MAX;
    let mut failures = 0u32;
    loop {
        let pos = shared.positions[index].load(Ordering::Relaxed);
        if pos >= end {
            return Ok(SegmentEnd::Done);
        }
        let mut response = match first.take() {
            Some(response) => response,
            None if unbounded && pos > 0 => return Err(NETWORK_FAILURE.to_owned()),
            None => match send(
                &shared.client,
                &shared.url,
                shared.referer.as_deref(),
                Some(range_header(pos, end)),
                shared.validator.as_deref().filter(|_| pos > 0),
            )
            .await
            {
                Ok(response) if response.status() == StatusCode::PARTIAL_CONTENT => response,
                Ok(_) => return Err(CHANGED.to_owned()),
                Err(message) if message == NETWORK_FAILURE => {
                    failures += 1;
                    if failures > MAX_RETRIES || unbounded {
                        return Err(message);
                    }
                    sleep(Duration::from_millis(400 * u64::from(failures))).await;
                    continue;
                }
                Err(message) => return Err(message),
            },
        };
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&shared.part)
            .await
            .map_err(|_| DISK_FAILURE.to_owned())?;
        file.seek(std::io::SeekFrom::Start(pos))
            .await
            .map_err(|_| DISK_FAILURE.to_owned())?;
        let mut position = pos;
        let broken = loop {
            tokio::select! {
                stop = stopped(&mut ctl) => {
                    file.flush().await.map_err(|_| DISK_FAILURE.to_owned())?;
                    return Ok(SegmentEnd::Stopped(stop));
                }
                chunk = timeout(READ_TIMEOUT, response.chunk()) => match chunk {
                    Ok(Ok(Some(bytes))) => {
                        let room = end.saturating_sub(position);
                        let take = usize::try_from(room).map_or(bytes.len(), |room| room.min(bytes.len()));
                        file.write_all(&bytes[..take]).await.map_err(|_| DISK_FAILURE.to_owned())?;
                        position += take as u64;
                        shared.positions[index].store(position, Ordering::Relaxed);
                        shared.received.fetch_add(take as u64, Ordering::Relaxed);
                        if position >= end {
                            file.flush().await.map_err(|_| DISK_FAILURE.to_owned())?;
                            return Ok(SegmentEnd::Done);
                        }
                    }
                    Ok(Ok(None)) => break false,
                    Ok(Err(_)) | Err(_) => break true,
                },
            }
        };
        file.flush().await.map_err(|_| DISK_FAILURE.to_owned())?;
        if unbounded && !broken {
            return Ok(SegmentEnd::Done);
        }
        failures += 1;
        if failures > MAX_RETRIES || unbounded {
            return Err(NETWORK_FAILURE.to_owned());
        }
        sleep(Duration::from_millis(400 * u64::from(failures))).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_disposition_names_are_read_and_cleaned() {
        assert_eq!(
            disposition_name(r#"attachment; filename="a b.zip""#).as_deref(),
            Some("a b.zip")
        );
        assert_eq!(
            disposition_name("attachment; filename=\"x.txt\"; filename*=UTF-8''caf%C3%A9.txt")
                .as_deref(),
            Some("café.txt")
        );
        assert_eq!(disposition_name("inline"), None);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_DISPOSITION,
            r#"attachment; filename="../../evil.sh""#.parse().unwrap(),
        );
        assert_eq!(final_file_name(&headers, "fallback"), "evil.sh");
    }

    #[test]
    fn a_name_without_an_extension_gets_one_from_the_content_type() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "image/png".parse().unwrap());
        assert_eq!(final_file_name(&headers, "cat"), "cat.png");
        assert_eq!(final_file_name(&headers, "cat.jpg"), "cat.jpg");
    }

    #[test]
    fn range_totals_and_splits() {
        assert_eq!(content_range_total("bytes 0-9/100"), Some(100));
        assert_eq!(content_range_total("bytes 0-9/*"), None);
        let parts = split(Some(10 * MIN_SEGMENT + 5), true, 4);
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0].start, 0);
        assert_eq!(parts.last().map(|s| s.end), Some(10 * MIN_SEGMENT + 5));
        assert!(parts.windows(2).all(|w| w[0].end == w[1].start));
        assert_eq!(split(Some(100), true, 4).len(), 1);
        assert_eq!(split(Some(10 * MIN_SEGMENT), false, 4).len(), 1);
        assert_eq!(
            split(None, false, 4),
            [Segment {
                start: 0,
                end: u64::MAX,
                pos: 0
            }]
        );
    }
}
