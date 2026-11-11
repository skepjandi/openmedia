use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use tauri::{AppHandle, Runtime, plugin::PluginApi};

use crate::models::*;
use crate::{Error, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<Siteview<R>> {
    Ok(Siteview(PhantomData))
}

/// Windows and Linux have no site views yet; macOS has them (`macos/`).
pub struct Siteview<R: Runtime>(PhantomData<fn() -> R>);

impl<R: Runtime> Siteview<R> {
    pub fn open(&self, _request: OpenRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn activate(&self, _request: SessionRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn close(&self, _request: SessionRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn set_rect(&self, _request: SetRectRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn set_interactive_regions(&self, _request: SetInteractiveRegionsRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn navigate(&self, _request: NavigateRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn go_back(&self) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn go_forward(&self) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn reload(&self) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn notify(&self, _request: NotifyRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }
}

impl<R: Runtime> Siteview<R> {
    pub fn set_color_scheme(&self, _request: SetColorSchemeRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn fetch_favicon(&self, _request: FetchFaviconRequest) -> Result<Option<String>> {
        Err(Error::DesktopUnsupported("site views"))
    }

    /// Desktop targets without site views have no native navigation policy to update.
    pub fn set_favorite_domains(&self, _request: SetFavoriteDomainsRequest) -> Result<()> {
        Ok(())
    }

    pub fn set_document_start_script(&self, _request: SetDocumentStartScriptRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn set_content_rule_lists(&self, _request: SetContentRuleListsRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn set_blocked(&self, _request: SetBlockedRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn authenticate(&self, _request: AuthenticateRequest) -> Result<bool> {
        Err(Error::DesktopUnsupported("site views"))
    }

    pub fn biometry_kind(&self) -> Result<BiometryKind> {
        Ok(BiometryKind::Fingerprint)
    }

    pub fn evaluate(&self, _request: EvaluateRequest) -> Result<String> {
        Err(Error::DesktopUnsupported("site views"))
    }
}
