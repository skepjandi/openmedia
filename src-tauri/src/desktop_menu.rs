//! The desktop menu bar: the shortcuts the shell's key bindings ask for (Cmd on a Mac, Ctrl on
//! Windows and Linux). The page is a native view, so a key press in it never reaches the shell;
//! menu items are handled by the app before either sees the key.
//!
//! The shell owns the bindings. It sends the list of items to show with `set_menu_shortcuts`
//! whenever they change, and every item that is chosen goes back to it as `menu:action` with the
//! action's id, so a single table decides what a key does whoever received it.

use tauri::{
    AppHandle, Emitter, Runtime,
    menu::{IsMenuItem, Menu, MenuEvent, MenuItem, Submenu},
};

use crate::error::{Error, Result};
use crate::keyboard::MenuShortcut;

/// The shell listens for this and runs the action named in the payload.
const ACTION_EVENT: &str = "menu:action";
/// Menu item ids from the shell carry this prefix, so the predefined items' own ids never reach it.
const ID_PREFIX: &str = "shortcut:";
/// The new menus go before this one in Tauri's default menu. It is looked up by its text because
/// the default layout differs per OS (Mac has an app menu first, Windows and Linux do not).
const MENU_BEFORE: &str = "Window";

/// One item. A key the menu cannot read leaves the item without a shortcut rather than failing.
fn item<R: Runtime>(app: &AppHandle<R>, shortcut: &MenuShortcut) -> tauri::Result<MenuItem<R>> {
    let id = format!("{ID_PREFIX}{}", shortcut.id());
    let with_keys = shortcut
        .accelerator()
        .and_then(|keys| MenuItem::with_id(app, &id, shortcut.label(), true, Some(keys)).ok());
    match with_keys {
        Some(item) => Ok(item),
        None => MenuItem::with_id(app, &id, shortcut.label(), true, None::<&str>),
    }
}

/// The groups in the order they first appear, each with its items.
fn grouped(shortcuts: &[MenuShortcut]) -> Vec<(&str, Vec<&MenuShortcut>)> {
    let mut groups: Vec<(&str, Vec<&MenuShortcut>)> = Vec::new();
    for shortcut in shortcuts {
        match groups
            .iter_mut()
            .find(|(name, _)| *name == shortcut.group())
        {
            Some((_, items)) => items.push(shortcut),
            None => groups.push((shortcut.group(), vec![shortcut])),
        }
    }
    groups
}

/// Replaces the menu bar: Tauri's default menu with one menu per group of `shortcuts`.
fn build<R: Runtime>(app: &AppHandle<R>, shortcuts: &[MenuShortcut]) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let items = menu.items()?;
    let first = items
        .iter()
        .position(|menu_item| {
            menu_item
                .as_submenu()
                .is_some_and(|submenu| submenu.text().is_ok_and(|text| text == MENU_BEFORE))
        })
        .unwrap_or(items.len());
    for (offset, (name, group)) in grouped(shortcuts).into_iter().enumerate() {
        let built = group
            .into_iter()
            .map(|shortcut| item(app, shortcut))
            .collect::<tauri::Result<Vec<_>>>()?;
        let refs: Vec<&dyn IsMenuItem<R>> = built
            .iter()
            .map(|entry| entry as &dyn IsMenuItem<R>)
            .collect();
        menu.insert(
            &Submenu::with_items(app, name, true, &refs)?,
            first + offset,
        )?;
    }
    app.set_menu(menu)?;
    Ok(())
}

/// Installs the default menu bar; the shell sends its shortcuts once it is up.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    build(app, &[])
}

/// Hands a chosen item to the shell, which runs the action.
pub fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if let Some(action) = event.id().as_ref().strip_prefix(ID_PREFIX) {
        let _ = app.emit(ACTION_EVENT, action);
    }
}

/// Shows these items, with their keys, in the menu bar.
pub fn set<R: Runtime>(app: &AppHandle<R>, shortcuts: &[MenuShortcut]) -> Result<()> {
    build(app, shortcuts).map_err(|error| Error::Menu(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shortcut(id: &str, group: &str) -> MenuShortcut {
        MenuShortcut::new(id, "Back", group, Some("CmdOrCtrl+["))
    }

    #[test]
    fn items_group_by_menu_in_first_seen_order() {
        let list = [
            shortcut("nav.back", "Navigate"),
            shortcut("tab.next", "Tabs"),
            shortcut("nav.reload", "Navigate"),
        ];
        let groups = grouped(&list);
        let names: Vec<&str> = groups.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, ["Navigate", "Tabs"]);
        assert_eq!(groups[0].1.len(), 2);
    }
}
