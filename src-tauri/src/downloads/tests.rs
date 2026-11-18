//! The engine against a small HTTP server on the loopback address.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use uuid::Uuid;

use super::manager::Manager;
use super::model::{AddRequest, Download, Status};
use super::settings::{Rule, Settings};

const LARGE: usize = 3 * (1 << 20) + 17;

fn body(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

struct Server {
    port: u16,
    ranged: Arc<AtomicUsize>,
}

fn serve(stream: &mut TcpStream, ranged: &AtomicUsize) -> std::io::Result<()> {
    let mut request = Vec::new();
    let mut buffer = [0u8; 1024];
    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            return Ok(());
        }
        request.extend_from_slice(&buffer[..read]);
    }
    let text = String::from_utf8_lossy(&request).into_owned();
    let path = text.split_whitespace().nth(1).unwrap_or("/").to_owned();
    let range = text.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .strip_prefix("range: bytes=")
            .map(str::to_owned)
    });
    let (content, supports_range, slow, extra): (Vec<u8>, bool, bool, &str) = match path.as_str() {
        "/file.bin" => (body(LARGE), true, false, ""),
        "/slow.bin" => (body(LARGE), true, true, ""),
        "/plain.bin" => (body(LARGE), false, false, ""),
        "/named" => (
            body(300),
            false,
            false,
            "Content-Disposition: attachment; filename=\"../pic.png\"\r\nContent-Type: image/png\r\n",
        ),
        _ => {
            stream.write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )?;
            return Ok(());
        }
    };
    let total = content.len();
    let (start, end, partial) = match range.filter(|_| supports_range) {
        Some(range) => {
            ranged.fetch_add(1, Ordering::SeqCst);
            let (from, to) = range.trim().split_once('-').unwrap_or(("0", ""));
            let from: usize = from.parse().unwrap_or(0);
            let to: usize = to.parse().map_or(total - 1, |to: usize| to.min(total - 1));
            (from, to + 1, true)
        }
        None => (0, total, false),
    };
    let head = if partial {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{}/{total}\r\nAccept-Ranges: bytes\r\n",
            end - 1
        )
    } else {
        let accept = if supports_range {
            "Accept-Ranges: bytes\r\n"
        } else {
            ""
        };
        format!("HTTP/1.1 200 OK\r\n{accept}")
    };
    stream.write_all(
        format!(
            "{head}{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
            end - start
        )
        .as_bytes(),
    )?;
    for chunk in content[start..end].chunks(8192) {
        stream.write_all(chunk)?;
        if slow {
            sleep(Duration::from_millis(10));
        }
    }
    Ok(())
}

fn start_server() -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let ranged = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&ranged);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let counter = Arc::clone(&counter);
            std::thread::spawn(move || {
                let mut stream = stream;
                let _ = serve(&mut stream, &counter);
            });
        }
    });
    Server { port, ranged }
}

fn request(server: &Server, path: &str) -> AddRequest {
    AddRequest {
        url: format!("http://127.0.0.1:{}{path}", server.port),
        label: None,
        kind: None,
        page_url: None,
        page_title: None,
    }
}

fn manager(root: &Path) -> Manager {
    Manager::load(
        root.join("state/d.json"),
        root.join("files"),
        Box::new(|_| {}),
    )
    .unwrap()
}

fn wait_for(manager: &Manager, id: Uuid, wanted: impl Fn(&Download) -> bool) -> Download {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let download = manager.list().into_iter().find(|d| d.id == id).unwrap();
        if wanted(&download) {
            return download;
        }
        assert!(
            Instant::now() < deadline,
            "timed out in {:?}: {download:?}",
            download.status
        );
        sleep(Duration::from_millis(20));
    }
}

fn finished(manager: &Manager, id: Uuid) -> Download {
    wait_for(manager, id, |d| d.status.is_finished())
}

#[test]
fn a_large_file_arrives_in_pieces_and_intact() {
    let server = start_server();
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    let id = manager
        .add(vec![request(&server, "/file.bin")], false)
        .unwrap()[0]
        .id;
    let download = finished(&manager, id);
    assert_eq!(download.status, Status::Done, "{:?}", download.error);
    assert_eq!(download.total, Some(LARGE as u64));
    assert_eq!(std::fs::read(download.path.unwrap()).unwrap(), body(LARGE));
    // 3 MiB at 1 MiB a piece: the opening request and two more.
    assert_eq!(server.ranged.load(Ordering::SeqCst), 3);
}

#[test]
fn a_server_without_ranges_gets_one_connection() {
    let server = start_server();
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    let id = manager
        .add(vec![request(&server, "/plain.bin")], false)
        .unwrap()[0]
        .id;
    let download = finished(&manager, id);
    assert_eq!(download.status, Status::Done, "{:?}", download.error);
    assert!(!download.resumable);
    assert_eq!(std::fs::read(download.path.unwrap()).unwrap(), body(LARGE));
    assert_eq!(server.ranged.load(Ordering::SeqCst), 0);
}

#[test]
fn pausing_keeps_the_bytes_and_resuming_finishes_the_file() {
    let server = start_server();
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    let id = manager
        .add(vec![request(&server, "/slow.bin")], false)
        .unwrap()[0]
        .id;
    wait_for(&manager, id, |d| d.received > 0);
    manager.pause(id);
    let paused = wait_for(&manager, id, |d| d.status == Status::Paused);
    assert!(paused.received < LARGE as u64);
    assert!(paused.resumable);
    manager.resume(id);
    let download = finished(&manager, id);
    assert_eq!(download.status, Status::Done, "{:?}", download.error);
    assert_eq!(std::fs::read(download.path.unwrap()).unwrap(), body(LARGE));
}

#[test]
fn cancelling_leaves_no_file_behind() {
    let server = start_server();
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    let id = manager
        .add(vec![request(&server, "/slow.bin")], false)
        .unwrap()[0]
        .id;
    wait_for(&manager, id, |d| d.received > 0);
    manager.cancel(id);
    let download = wait_for(&manager, id, |d| d.status == Status::Cancelled);
    assert_eq!(download.path, None);
    let files = dir.path().join("files");
    assert!(!files.exists() || std::fs::read_dir(files).unwrap().next().is_none());
}

#[test]
fn a_refusal_fails_with_the_status_and_a_retry_can_run_again() {
    let server = start_server();
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    let id = manager
        .add(vec![request(&server, "/missing")], false)
        .unwrap()[0]
        .id;
    let download = finished(&manager, id);
    assert_eq!(download.status, Status::Failed);
    assert_eq!(
        download.error.as_deref(),
        Some("The server refused the download (HTTP 404).")
    );
    manager.resume(id);
    assert_eq!(finished(&manager, id).status, Status::Failed);
}

#[test]
fn the_server_names_the_file_and_a_rule_routes_it_without_leaving_the_folder() {
    let server = start_server();
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    let settings = Settings {
        mask: "{n:2}-{filename}".to_owned(),
        rules: vec![Rule {
            id: Uuid::new_v4(),
            name: "pictures".to_owned(),
            enabled: true,
            host: Some("127.0.0.1".to_owned()),
            kinds: vec![super::kind::Kind::Image],
            regex: None,
            mask: None,
            folder: Some("Pics/{kind}".to_owned()),
        }],
        ..Settings::default()
    };
    manager.set_settings(settings).unwrap();
    let id = manager
        .add(vec![request(&server, "/named")], false)
        .unwrap()[0]
        .id;
    let download = finished(&manager, id);
    assert_eq!(download.status, Status::Done, "{:?}", download.error);
    let expected = dir.path().join("files/Pics/image/01-pic.png");
    assert_eq!(Path::new(&download.path.unwrap()), expected);
    assert_eq!(std::fs::read(expected).unwrap(), body(300));
}

#[test]
fn the_same_name_twice_gets_a_number_and_incognito_downloads_are_not_saved() {
    let server = start_server();
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    let first = manager
        .add(vec![request(&server, "/named")], false)
        .unwrap()[0]
        .id;
    let second = manager.add(vec![request(&server, "/named")], true).unwrap()[0].id;
    let (first, second) = (finished(&manager, first), finished(&manager, second));
    let names = [first.file_name, second.file_name];
    assert!(names.contains(&"pic.png".to_owned()) && names.contains(&"pic (1).png".to_owned()));
    let saved = std::fs::read_to_string(dir.path().join("state/d.json")).unwrap();
    assert_eq!(saved.matches("\"private\":true").count(), 0);
    manager.purge_private();
    assert_eq!(manager.list().len(), 1);
}
