//! The desktop menu bar: the shortcuts a desktop browser has (Cmd on a Mac, Ctrl on Windows and
//! Linux). The page is a native view, so a key press
//! in it never reaches the shell; menu items are handled by the app before either sees the key.

use tauri::{
    AppHandle, Emitter, Runtime,
    menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
};
use tauri_plugin_siteview::{SiteviewExt, ZoomAction, ZoomRequest};

/// The shell listens for this and opens the sheet named in the payload.
const SHEET_EVENT: &str = "menu:sheet";
/// The new menus go before this one in Tauri's default menu. It is looked up by its text because
/// the default layout differs per OS (Mac has an app menu first, Windows and Linux do not).
const MENU_BEFORE: &str = "Window";

const BACK: &str = "siteview.back";
const FORWARD: &str = "siteview.forward";
const RELOAD: &str = "siteview.reload";
const ADDRESS: &str = "shell.address";
const SETTINGS: &str = "shell.settings";
const HISTORY: &str = "shell.history";
const ZOOM_IN: &str = "siteview.zoom-in";
const ZOOM_OUT: &str = "siteview.zoom-out";
const ZOOM_RESET: &str = "siteview.zoom-reset";

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    shortcut: &str,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, text, true, Some(shortcut))
}

/// Adds the Navigate and Page menus to the default menu.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let back = item(app, BACK, "Back", "CmdOrCtrl+[")?;
    let forward = item(app, FORWARD, "Forward", "CmdOrCtrl+]")?;
    let reload = item(app, RELOAD, "Reload Page", "CmdOrCtrl+R")?;
    let address = item(app, ADDRESS, "Open Address…", "CmdOrCtrl+L")?;
    let history = item(app, HISTORY, "History", "CmdOrCtrl+Y")?;
    let settings = item(app, SETTINGS, "Settings", "CmdOrCtrl+,")?;
    let separator = PredefinedMenuItem::separator(app)?;
    let navigate_items: [&dyn IsMenuItem<R>; 7] = [
        &back, &forward, &reload, &separator, &address, &history, &settings,
    ];
    let navigate = Submenu::with_items(app, "Navigate", true, &navigate_items)?;

    let zoom_in = item(app, ZOOM_IN, "Zoom In", "CmdOrCtrl+=")?;
    let zoom_out = item(app, ZOOM_OUT, "Zoom Out", "CmdOrCtrl+-")?;
    let zoom_reset = item(app, ZOOM_RESET, "Actual Size", "CmdOrCtrl+0")?;
    let page_items: [&dyn IsMenuItem<R>; 3] = [&zoom_in, &zoom_out, &zoom_reset];
    let page = Submenu::with_items(app, "Page", true, &page_items)?;

    let items = menu.items()?;
    let at = items
        .iter()
        .position(|menu_item| {
            menu_item
                .as_submenu()
                .is_some_and(|submenu| submenu.text().is_ok_and(|text| text == MENU_BEFORE))
        })
        .unwrap_or(items.len());
    menu.insert(&navigate, at)?;
    menu.insert(&page, at + 1)?;
    app.set_menu(menu)?;
    Ok(())
}

/// Runs a menu item. Menu events arrive on the main thread, and the plugin waits for it, so the
/// page actions run on another thread.
pub fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let app = app.clone();
    match event.id().as_ref() {
        ADDRESS => {
            let _ = app.emit(SHEET_EVENT, "assistant");
        }
        HISTORY => {
            let _ = app.emit(SHEET_EVENT, "history");
        }
        SETTINGS => {
            let _ = app.emit(SHEET_EVENT, "settings");
        }
        BACK => on_page(app, |plugin| plugin.go_back()),
        FORWARD => on_page(app, |plugin| plugin.go_forward()),
        RELOAD => on_page(app, |plugin| plugin.reload()),
        ZOOM_IN => zoom(app, ZoomAction::In),
        ZOOM_OUT => zoom(app, ZoomAction::Out),
        ZOOM_RESET => zoom(app, ZoomAction::Reset),
        _ => {}
    }
}

fn zoom<R: Runtime>(app: AppHandle<R>, action: ZoomAction) {
    on_page(app, move |plugin| plugin.zoom(ZoomRequest { action }));
}

/// A menu item with no page to act on (the start screen) does nothing.
fn on_page<R: Runtime>(
    app: AppHandle<R>,
    action: impl FnOnce(&tauri_plugin_siteview::Siteview<R>) -> tauri_plugin_siteview::Result<()>
    + Send
    + 'static,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = action(app.siteview());
    });
}
