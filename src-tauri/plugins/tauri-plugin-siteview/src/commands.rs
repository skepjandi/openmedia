use tauri::{AppHandle, Runtime, command};

use crate::models::*;
use crate::validate::{
    parse_profile_id, parse_session_id, parse_web_url, validate_layout, validate_notification_text,
    validate_rule_lists,
};
use crate::{Result, SiteviewExt};

#[command]
pub(crate) async fn open<R: Runtime>(app: AppHandle<R>, request: OpenRequest) -> Result<()> {
    parse_session_id(&request.session)?;
    parse_profile_id(&request.profile)?;
    parse_web_url(&request.url)?;
    validate_rule_lists(&request.content_rule_lists)?;
    app.siteview().open(request)
}

#[command]
pub(crate) async fn activate<R: Runtime>(app: AppHandle<R>, request: SessionRequest) -> Result<()> {
    parse_session_id(&request.session)?;
    app.siteview().activate(request)
}

#[command]
pub(crate) async fn close<R: Runtime>(app: AppHandle<R>, request: SessionRequest) -> Result<()> {
    parse_session_id(&request.session)?;
    app.siteview().close(request)
}

#[command]
pub(crate) async fn set_rect<R: Runtime>(app: AppHandle<R>, request: SetRectRequest) -> Result<()> {
    app.siteview().set_rect(request)
}

#[command]
pub(crate) async fn set_layout<R: Runtime>(
    app: AppHandle<R>,
    request: SetLayoutRequest,
) -> Result<()> {
    validate_layout(&request.panes)?;
    app.siteview().set_layout(request)
}

#[command]
pub(crate) async fn set_interactive_regions<R: Runtime>(
    app: AppHandle<R>,
    request: SetInteractiveRegionsRequest,
) -> Result<()> {
    app.siteview().set_interactive_regions(request)
}

#[command]
pub(crate) async fn set_covered<R: Runtime>(
    app: AppHandle<R>,
    request: SetCoveredRequest,
) -> Result<()> {
    app.siteview().set_covered(request)
}

#[command]
pub(crate) async fn navigate<R: Runtime>(
    app: AppHandle<R>,
    request: NavigateRequest,
) -> Result<()> {
    parse_web_url(&request.url)?;
    app.siteview().navigate(request)
}

#[command]
pub(crate) async fn go_back<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.siteview().go_back()
}

#[command]
pub(crate) async fn go_forward<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.siteview().go_forward()
}

#[command]
pub(crate) async fn reload<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.siteview().reload()
}

#[command]
pub(crate) async fn set_color_scheme<R: Runtime>(
    app: AppHandle<R>,
    request: SetColorSchemeRequest,
) -> Result<()> {
    app.siteview().set_color_scheme(request)
}

#[command]
pub(crate) async fn notify<R: Runtime>(app: AppHandle<R>, request: NotifyRequest) -> Result<()> {
    parse_session_id(&request.session)?;
    validate_notification_text(&request.title, &request.body)?;
    app.siteview().notify(request)
}

#[command]
pub(crate) async fn set_content_rule_lists<R: Runtime>(
    app: AppHandle<R>,
    request: SetContentRuleListsRequest,
) -> Result<()> {
    validate_rule_lists(&request.lists)?;
    app.siteview().set_content_rule_lists(request)
}

#[command]
pub(crate) async fn set_document_start_script<R: Runtime>(
    app: AppHandle<R>,
    request: SetDocumentStartScriptRequest,
) -> Result<()> {
    app.siteview().set_document_start_script(request)
}

/// Fetches a small PNG for the site's icon, as a `data:` URL. Runs natively against the site
/// itself; nothing is sent to a third-party icon service.
#[command]
pub(crate) async fn fetch_favicon<R: Runtime>(
    app: AppHandle<R>,
    request: FetchFaviconRequest,
) -> Result<Option<String>> {
    parse_web_url(&request.url)?;
    app.siteview().fetch_favicon(request)
}
