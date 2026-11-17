use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

mod commands;
mod error;
#[cfg(any(mobile, target_os = "macos"))]
mod events;
mod models;
pub mod site;
pub mod validate;

#[cfg(all(desktop, not(target_os = "macos")))]
mod desktop;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(mobile)]
mod mobile;

pub use error::{Error, Result};
pub use models::*;

#[cfg(all(desktop, not(target_os = "macos")))]
pub use desktop::Siteview;
#[cfg(target_os = "macos")]
pub use macos::Siteview;
#[cfg(mobile)]
pub use mobile::Siteview;

/// The Android secret store. Android has no `keyring` backend, so the plugin's Android side
/// keeps the key in the Android Keystore.
#[cfg(target_os = "android")]
pub use mobile::AndroidSecretStore;

pub trait SiteviewExt<R: Runtime> {
    fn siteview(&self) -> &Siteview<R>;
}

impl<R: Runtime, T: Manager<R>> SiteviewExt<R> for T {
    fn siteview(&self) -> &Siteview<R> {
        self.state::<Siteview<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("siteview")
        .invoke_handler(tauri::generate_handler![
            commands::open,
            commands::activate,
            commands::close,
            commands::set_rect,
            commands::set_interactive_regions,
            commands::set_covered,
            commands::navigate,
            commands::go_back,
            commands::go_forward,
            commands::reload,
            commands::set_color_scheme,
            commands::fetch_favicon,
            commands::set_content_rule_lists,
            commands::set_document_start_script,
            commands::notify,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let siteview = mobile::init(app, api)?;
            #[cfg(all(desktop, not(target_os = "macos")))]
            let siteview = desktop::init(app, api)?;
            #[cfg(target_os = "macos")]
            let siteview = macos::init(app, api)?;
            app.manage(siteview);
            Ok(())
        })
        .build()
}
