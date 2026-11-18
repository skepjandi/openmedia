use serde::de::DeserializeOwned;
use tauri::{
    AppHandle, Emitter, Runtime,
    ipc::{Channel, InvokeResponseBody},
    plugin::{PluginApi, PluginHandle},
};

use crate::events::{
    BRIDGE_EVENT, CLOSED_EVENT, ERROR_EVENT, MEMORY_EVENT, NOTIFICATION_TAP_EVENT,
    POPUP_BLOCKED_EVENT, STATE_EVENT,
};
use crate::models::*;
use crate::validate::{
    check_auth_reason, check_evaluate_result, check_share_title, check_site, is_color_hex,
    parse_bridge_body, parse_session_id, parse_web_url, wrap_evaluate_script,
};
use crate::{Error, Result};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_siteview);

/// The Kotlin class the Android side loads: `surf.openmedia.siteview.SiteViewPlugin`.
#[cfg(target_os = "android")]
const ANDROID_PLUGIN: &str = "surf.openmedia.siteview";

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<Siteview<R>> {
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_siteview)?;
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(ANDROID_PLUGIN, "SiteViewPlugin")?;

    #[cfg(target_os = "android")]
    android_secrets::install(handle.clone());

    let app = app.clone();
    let events = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            dispatch_event(&app, &json);
        }
        Ok(())
    });
    Ok(Siteview { handle, events })
}

fn dispatch_event<R: Runtime>(app: &AppHandle<R>, json: &str) {
    let Ok(event) = serde_json::from_str::<SiteViewEvent>(json) else {
        return;
    };
    let _ = match event {
        SiteViewEvent::State { .. } => app.emit(STATE_EVENT, event),
        SiteViewEvent::Closed { session } => app.emit(CLOSED_EVENT, session),
        SiteViewEvent::MemoryWarning => app.emit(MEMORY_EVENT, ()),
        SiteViewEvent::NotificationTapped { session } => match parse_session_id(&session) {
            Ok(_) => app.emit(NOTIFICATION_TAP_EVENT, session),
            Err(_) => Ok(()),
        },
        SiteViewEvent::Error { message } => app.emit(ERROR_EVENT, message),
        SiteViewEvent::PopupBlocked { host } => app.emit(POPUP_BLOCKED_EVENT, host),
        SiteViewEvent::Bridge { origin, body } => match parse_bridge_body(&body) {
            Ok(body) => app.emit(BRIDGE_EVENT, BridgeMessage { origin, body }),
            Err(_) => Ok(()),
        },
    };
}

pub struct Siteview<R: Runtime> {
    handle: PluginHandle<R>,
    events: Channel<serde_json::Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenPayload<'a> {
    #[serde(flatten)]
    request: &'a OpenRequest,
    on_event: &'a Channel<serde_json::Value>,
}

impl<R: Runtime> Siteview<R> {
    fn run<T: DeserializeOwned>(&self, command: &str, payload: impl serde::Serialize) -> Result<T> {
        self.handle
            .run_mobile_plugin(command, payload)
            .map_err(Error::from)
    }

    pub fn open(&self, request: OpenRequest) -> Result<()> {
        self.run(
            "open",
            OpenPayload {
                request: &request,
                on_event: &self.events,
            },
        )
    }

    pub fn activate(&self, request: SessionRequest) -> Result<()> {
        self.run(
            "activate",
            serde_json::json!({ "session": request.session }),
        )
    }

    pub fn close(&self, request: SessionRequest) -> Result<()> {
        self.run("close", serde_json::json!({ "session": request.session }))
    }

    pub fn set_rect(&self, request: SetRectRequest) -> Result<()> {
        self.run("setRect", serde_json::json!({ "rect": request.rect }))
    }

    pub fn set_interactive_regions(&self, request: SetInteractiveRegionsRequest) -> Result<()> {
        self.run(
            "setInteractiveRegions",
            serde_json::json!({ "regions": request.regions }),
        )
    }

    pub fn set_covered(&self, request: SetCoveredRequest) -> Result<()> {
        self.run(
            "setCovered",
            serde_json::json!({ "covered": request.covered }),
        )
    }

    pub fn navigate(&self, request: NavigateRequest) -> Result<()> {
        self.run("navigate", serde_json::json!({ "url": request.url }))
    }

    pub fn go_back(&self) -> Result<()> {
        self.run("goBack", ())
    }

    pub fn go_forward(&self) -> Result<()> {
        self.run("goForward", ())
    }

    pub fn reload(&self) -> Result<()> {
        self.run("reload", ())
    }

    pub fn notify(&self, request: NotifyRequest) -> Result<()> {
        self.run(
            "notify",
            serde_json::json!({
                "session": request.session,
                "title": request.title,
                "body": request.body,
            }),
        )
    }
}

impl<R: Runtime> Siteview<R> {
    pub fn set_color_scheme(&self, request: SetColorSchemeRequest) -> Result<()> {
        self.run(
            "setColorScheme",
            serde_json::json!({ "scheme": request.scheme }),
        )
    }

    pub fn fetch_favicon(&self, request: FetchFaviconRequest) -> Result<Option<String>> {
        let response: FaviconResponse =
            self.run("fetchFavicon", serde_json::json!({ "url": request.url }))?;
        Ok(response.data_url)
    }

    pub fn set_document_start_script(&self, request: SetDocumentStartScriptRequest) -> Result<()> {
        self.run(
            "setDocumentStartScript",
            serde_json::json!({ "script": request.script }),
        )
    }

    pub fn set_content_rule_lists(&self, request: SetContentRuleListsRequest) -> Result<()> {
        self.run(
            "setContentRuleLists",
            serde_json::json!({ "enabled": request.enabled, "lists": request.lists }),
        )
    }

    /// Covers one session with a native shield and stops it: no touches, no loading, no media,
    /// no navigation. Rust-only: the plugin registers no command for it, so neither the shell
    /// nor a site view can reach it.
    pub fn set_blocked(&self, request: SetBlockedRequest) -> Result<()> {
        self.run(
            "setBlocked",
            serde_json::json!({ "session": request.session, "blocked": request.blocked }),
        )
    }

    /// Names the sites whose media may keep playing while hidden or in the background. Rust-only:
    /// the plugin registers no command for it, so neither the shell nor a site view can reach it.
    pub fn set_background_media(&self, request: SetBackgroundMediaRequest) -> Result<()> {
        self.run(
            "setBackgroundMedia",
            serde_json::json!({ "sites": request.sites }),
        )
    }

    /// Names the sites whose videos may open in picture-in-picture. Rust-only: the plugin
    /// registers no command for it, so neither the shell nor a site view can reach it.
    pub fn set_picture_in_picture(&self, request: SetPictureInPictureRequest) -> Result<()> {
        self.run(
            "setPictureInPicture",
            serde_json::json!({ "sites": request.sites }),
        )
    }

    /// Names the sites whose pages are asked for as a desktop page. Rust-only: the plugin
    /// registers no command for it, so neither the shell nor a site view can reach it. Pages
    /// already open reload when their site's choice changed.
    pub fn set_desktop_sites(&self, request: SetDesktopSitesRequest) -> Result<()> {
        self.run(
            "setDesktopSites",
            serde_json::json!({ "sites": request.sites }),
        )
    }

    /// Opens the system's share sheet for an address. Rust-only: no webview can raise it.
    pub fn share(&self, request: ShareRequest) -> Result<()> {
        parse_web_url(&request.url)?;
        let title = check_share_title(request.title.as_deref())?;
        self.run(
            "share",
            serde_json::json!({ "url": request.url, "title": title }),
        )
    }

    /// Erases one site's cookies, storage and cache from the active page's profile, then reloads
    /// the page. Rust-only: no webview can call it.
    pub fn clear_site_data(&self, request: ClearSiteDataRequest) -> Result<()> {
        let site = check_site(&request.site)?;
        self.run("clearSiteData", serde_json::json!({ "site": site }))
    }

    /// Asks the device owner for Face ID, Touch ID or the device passcode and says whether they
    /// passed. Rust-only: the plugin registers no command for it, so neither the shell nor a site
    /// view can raise or answer the prompt.
    pub fn authenticate(&self, request: AuthenticateRequest) -> Result<bool> {
        let reason = check_auth_reason(&request.reason)?;
        let response: AuthenticateResponse =
            self.run("authenticate", serde_json::json!({ "reason": reason }))?;
        Ok(response.authenticated)
    }

    /// Which biometric the device has, for the shell's icon. Rust-only like `authenticate`; it
    /// reveals nothing but Face ID versus a fingerprint and raises no prompt.
    pub fn biometry_kind(&self) -> Result<BiometryKind> {
        let response: BiometryResponse = self.run("biometryKind", serde_json::json!({}))?;
        Ok(response.kind)
    }

    /// Evaluates `request.script` (an expression) in the active session's main frame and returns
    /// its value as JSON text. Rust-only: it is deliberately not a Tauri command and has no
    /// permission, so no webview can call it. The result is hostile page data.
    pub fn evaluate(&self, request: EvaluateRequest) -> Result<String> {
        let script = wrap_evaluate_script(&request.script)?;
        let response: EvaluateResponse = self.run(
            "evaluate",
            serde_json::json!({ "script": script, "pageWorld": request.page_world }),
        )?;
        check_evaluate_result(response.json)
    }

    /// The color the active session's web view actually shows at `request`, as `#rrggbb`
    /// lowercase, or `None` when it cannot be read. Rust-only like `evaluate`: no webview can
    /// call it.
    pub fn sample_color(&self, request: SampleColorRequest) -> Result<Option<String>> {
        let response: SampleColorResponse = self.run(
            "sampleColor",
            serde_json::json!({ "x": request.x, "y": request.y }),
        )?;
        Ok(Some(response.hex).filter(|hex| is_color_hex(hex)))
    }
}

/// The Android secret store: the Keystore-backed store the Kotlin side keeps. Android has no
/// keyring backend in `keyring`, so the plugin's Android side holds the key in the Android
/// Keystore and the ciphertext in the app's own preferences.
///
/// Rust-only: the plugin registers no command for it that a webview could reach, and the app's
/// own `SecretStore` implementation is the only caller.
#[cfg(target_os = "android")]
pub struct AndroidSecretStore;

#[cfg(target_os = "android")]
impl AndroidSecretStore {
    /// Stores a secret under `id`.
    pub fn set(id: &str, secret: &str) -> std::result::Result<(), String> {
        android_secrets::call("set", id, secret).map(|_| ())
    }

    /// Reads the secret stored under `id`, if there is one.
    pub fn get(id: &str) -> std::result::Result<Option<String>, String> {
        android_secrets::call("get", id, "")
    }

    /// Forgets the secret stored under `id`.
    pub fn delete(id: &str) -> std::result::Result<(), String> {
        android_secrets::call("delete", id, "").map(|_| ())
    }
}

/// The bridge to the Kotlin secret store. The operations are held in one place so the app's own
/// store can reach them without carrying a plugin handle around.
#[cfg(target_os = "android")]
mod android_secrets {
    use std::sync::{Arc, OnceLock};

    use serde::Deserialize;
    use tauri::Runtime;
    use tauri::plugin::PluginHandle;

    /// `op` is one of `set`, `get` or `delete`; the answer is the stored value, if any.
    pub type Ops = Arc<dyn Fn(&str, &str, &str) -> Result<Option<String>, String> + Send + Sync>;

    static OPS: OnceLock<Ops> = OnceLock::new();

    #[derive(Deserialize)]
    struct Response {
        value: Option<String>,
    }

    pub fn install<R: Runtime>(handle: PluginHandle<R>) {
        let _ = OPS.set(Arc::new(move |op: &str, id: &str, value: &str| {
            let response: Response = handle
                .run_mobile_plugin(
                    "secretOp",
                    serde_json::json!({ "op": op, "id": id, "value": value }),
                )
                .map_err(|e| e.to_string())?;
            Ok(response.value)
        }));
    }

    pub fn call(op: &str, id: &str, value: &str) -> Result<Option<String>, String> {
        let ops = OPS
            .get()
            .ok_or_else(|| "the secret store is not ready".to_string())?;
        ops(op, id, value)
    }
}
