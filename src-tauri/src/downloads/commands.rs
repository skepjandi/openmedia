use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_siteview::{EvaluateRequest, SiteviewExt};
use uuid::Uuid;

use super::manager::Manager;
use super::model::{AddRequest, Download};
use super::pattern::{MAX_EXPANSION, expand};
use super::settings::Settings;
use super::sniff::{self, Sniffed};
use crate::error::{Error, Result};
use crate::incognito::Incognito;

const MAX_PREVIEW_IMAGE_BYTES: u64 = 8 << 20;
const MAX_PREVIEW_TEXT_BYTES: usize = 16 << 10;
const MAX_PASTE_CHARS: usize = 100_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadsState {
    pub settings: Settings,
    pub downloads: Vec<Download>,
    pub default_folder: String,
}

/// What a finished file looks like inside the app.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Preview {
    Image {
        data_uri: String,
    },
    Text {
        text: String,
    },
    /// Audio, video, archives and the rest open in the system's own app.
    None,
}

#[tauri::command]
pub fn downloads_state(manager: State<'_, Manager>) -> DownloadsState {
    DownloadsState {
        settings: manager.settings(),
        downloads: manager.list(),
        default_folder: manager.default_root().to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub fn downloads_set_settings(manager: State<'_, Manager>, settings: Settings) -> Result<Settings> {
    manager.set_settings(settings)
}

#[tauri::command]
pub fn downloads_add(
    manager: State<'_, Manager>,
    incognito: State<'_, Incognito>,
    requests: Vec<AddRequest>,
) -> Result<Vec<Download>> {
    manager.add(requests, incognito.is_active())
}

/// Adds what the user typed or pasted: one address per line, each of which may be a batch
/// descriptor such as `https://example.com/img[001-020].jpg`.
#[tauri::command]
pub fn downloads_add_text(
    manager: State<'_, Manager>,
    incognito: State<'_, Incognito>,
    text: String,
    page_url: Option<String>,
    page_title: Option<String>,
) -> Result<Vec<Download>> {
    if text.chars().count() > MAX_PASTE_CHARS {
        return Err(Error::Download(
            "that is too much text to add at once".to_owned(),
        ));
    }
    let mut requests = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        for url in expand(line)? {
            requests.push(AddRequest {
                url,
                label: None,
                kind: None,
                page_url: page_url.clone(),
                page_title: page_title.clone(),
            });
        }
        if requests.len() > MAX_EXPANSION {
            return Err(Error::Download(format!(
                "at most {MAX_EXPANSION} addresses can be added at once"
            )));
        }
    }
    if requests.is_empty() {
        return Err(Error::Download(
            "there is no address to download".to_owned(),
        ));
    }
    manager.add(requests, incognito.is_active())
}

#[tauri::command]
pub fn downloads_pause(manager: State<'_, Manager>, id: Uuid) {
    manager.pause(id);
}

#[tauri::command]
pub fn downloads_resume(manager: State<'_, Manager>, id: Uuid) {
    manager.resume(id);
}

#[tauri::command]
pub fn downloads_cancel(manager: State<'_, Manager>, id: Uuid) {
    manager.cancel(id);
}

#[tauri::command]
pub fn downloads_remove(manager: State<'_, Manager>, id: Uuid) {
    manager.remove(id);
}

#[tauri::command]
pub fn downloads_clear_finished(manager: State<'_, Manager>) {
    manager.clear_finished();
}

fn finished_file(manager: &Manager, id: Uuid) -> Result<String> {
    manager
        .finished_path(id)
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| Error::Download("this file is no longer in the download folder".to_owned()))
}

#[tauri::command]
pub fn downloads_open(app: AppHandle, manager: State<'_, Manager>, id: Uuid) -> Result<()> {
    let path = finished_file(&manager, id)?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|_| Error::Download("this device has no app to open that file".to_owned()))
}

#[tauri::command]
pub fn downloads_reveal(app: AppHandle, manager: State<'_, Manager>, id: Uuid) -> Result<()> {
    let path = finished_file(&manager, id)?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|_| Error::Download("this device cannot show a file in its folder".to_owned()))
}

fn image_mime(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// The preview of a file: images up to 8 MiB as a data address (an image tag never runs the
/// scripts an SVG may carry), and the start of plain text. Anything else has none.
pub(super) fn preview_of(path: &Path) -> Result<Preview> {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    let size = std::fs::metadata(path)?.len();
    if let Some(mime) = image_mime(extension)
        && size <= MAX_PREVIEW_IMAGE_BYTES
    {
        let bytes = std::fs::read(path)?;
        return Ok(Preview::Image {
            data_uri: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
        });
    }
    if matches!(
        extension.to_ascii_lowercase().as_str(),
        "txt" | "csv" | "md" | "log"
    ) {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(MAX_PREVIEW_TEXT_BYTES as u64)
            .read_to_end(&mut bytes)?;
        return Ok(Preview::Text {
            text: String::from_utf8_lossy(&bytes).into_owned(),
        });
    }
    Ok(Preview::None)
}

#[tauri::command]
pub async fn downloads_preview(manager: State<'_, Manager>, id: Uuid) -> Result<Preview> {
    let path = manager.finished_path(id).ok_or_else(|| {
        Error::Download("this file is no longer in the download folder".to_owned())
    })?;
    tokio::task::spawn_blocking(move || preview_of(&path))
        .await
        .map_err(|_| Error::Download("the preview could not be made".to_owned()))?
}

/// Lists the media on the page in front. Async, like every command that evaluates in the page: the
/// iOS plugin answers from the main thread, so a synchronous command would wait for itself.
#[tauri::command]
pub async fn downloads_sniff(app: AppHandle) -> Result<Sniffed> {
    let json = app.siteview().evaluate(EvaluateRequest {
        script: sniff::SCRIPT.to_owned(),
        page_world: false,
    })?;
    Ok(sniff::parse(&json))
}

/// A small picture of an image the sniffer listed, as a data address, or `None` when the address
/// is not an image the shell may show. The shell's CSP allows no remote images, so Rust fetches it.
#[tauri::command]
pub async fn downloads_thumbnail(
    manager: State<'_, Manager>,
    url: String,
    page_url: Option<String>,
) -> Result<Option<String>> {
    super::thumbnail::fetch(manager.client(), &url, page_url.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_become_data_addresses_text_is_cut_and_the_rest_has_no_preview() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("a.PNG");
        std::fs::write(&image, [1, 2, 3]).unwrap();
        assert_eq!(
            preview_of(&image).unwrap(),
            Preview::Image {
                data_uri: "data:image/png;base64,AQID".to_owned()
            }
        );
        let text = dir.path().join("a.txt");
        std::fs::write(&text, "x".repeat(MAX_PREVIEW_TEXT_BYTES + 10)).unwrap();
        let Preview::Text { text } = preview_of(&text).unwrap() else {
            panic!("expected text");
        };
        assert_eq!(text.len(), MAX_PREVIEW_TEXT_BYTES);
        let movie = dir.path().join("a.mp4");
        std::fs::write(&movie, [0]).unwrap();
        assert_eq!(preview_of(&movie).unwrap(), Preview::None);
    }
}
