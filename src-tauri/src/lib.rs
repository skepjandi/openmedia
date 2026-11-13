mod ad_block;
mod ai;
mod boot;
mod commands;
#[cfg(target_os = "macos")]
mod desktop_menu;
mod entitlement;
pub mod error;
mod incognito;
mod library;
mod ota;
mod recipe_library;
pub mod recipes;
mod secrets;
mod self_update;
mod share;
mod sites;
mod usage;
mod usage_commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::expect_used, reason = "a failed startup is unrecoverable")]
pub fn run() {
    let ota = ota::Ota::new();
    let mut context = tauri::generate_context!();
    ota::OtaAssets::install(&mut context, ota.clone());
    let builder = tauri::Builder::default()
        .manage(ota.clone())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_siteview::init())
        .plugin(tauri_plugin_billing::init());
    #[cfg(all(desktop, feature = "self-update"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(target_os = "macos")]
    let builder = builder.on_menu_event(desktop_menu::handle);
    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            desktop_menu::install(app.handle())?;
            let data_dir = app.path().app_data_dir()?;
            let library = library::Library::load(data_dir.join("library.json"))?;
            let ad_block_enabled = library.ad_block_enabled()?;
            let background_media = library.background_media_sites()?;
            app.manage(library);
            // Off the setup thread: on iOS the plugin answers from the main thread, which is the
            // thread running this closure, so asking from here would wait for itself.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                // The list reaches the site views once; a failure leaves every site pausing.
                let _ = commands::push_background_media(&handle, background_media);
            });
            app.manage(incognito::Incognito::default());
            app.manage(recipes::Recipes::load(data_dir.join("recipes"))?);
            app.manage(share::Shares::from_build());
            let ad_block = ad_block::AdBlock::bundled(app.path().app_cache_dir()?.join("ad-block"));
            app.manage(ad_block.clone());
            // The start page opens now, on another thread, while the shell boots; see `boot.rs`.
            let boot = boot::Boot::start(app.handle(), &app.state::<library::Library>())?;
            app.manage(boot);
            if ad_block_enabled {
                // Converting the lists takes seconds on the first run; do it while the shell loads
                // so the first page open does not wait. A failure surfaces when a page opens.
                tauri::async_runtime::spawn_blocking(move || ad_block.rule_lists());
            }
            let usage = usage::Usage::load(data_dir.join("usage.json"))?;
            usage.retire_public_suffix_sites(&app.state::<library::Library>().favorite_hosts()?)?;
            app.manage(usage);
            app.manage(ai::agent::Agent::default());
            app.manage(ai::hub::Hubs::default());
            app.manage(ai::chats::Chats::load(data_dir.join("chats.json"))?);
            app.manage(commands::Secrets(Box::new(secrets::KeychainStore)));
            app.manage(entitlement::Entitlement::from_build());
            entitlement::start(app.handle());
            ota::check_after_launch(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            entitlement::get_entitlement,
            entitlement::refresh_entitlement,
            entitlement::get_offerings,
            entitlement::purchase_package,
            entitlement::restore_purchases,
            commands::get_state,
            commands::set_favorites,
            commands::set_site_favorite,
            commands::set_last_url,
            commands::add_history,
            commands::clear_history,
            commands::record_usage,
            commands::get_usage,
            commands::clear_usage,
            usage_commands::get_usage_limits,
            usage_commands::set_usage_limit,
            usage_commands::set_usage_section_limit,
            usage_commands::set_usage_blocked,
            incognito::unlock_incognito,
            incognito::biometry_kind,
            incognito::enter_incognito,
            incognito::exit_incognito,
            incognito::get_incognito_favorites,
            incognito::set_incognito_favorites,
            commands::complete_onboarding,
            commands::reset_onboarding,
            commands::open_external,
            commands::set_theme,
            commands::set_locale,
            commands::set_search_engine,
            commands::refresh_icons,
            commands::get_icons,
            commands::open_site,
            commands::adopt_boot_session,
            commands::set_ad_block,
            commands::get_sites,
            commands::set_site_option,
            recipe_library::library_list,
            recipe_library::library_preview,
            recipe_library::library_install,
            recipe_library::library_uninstall,
            recipe_library::onboarding_options,
            recipe_library::onboarding_apply,
            share::commands::share_status_available,
            share::commands::share_start,
            share::commands::share_status,
            share::commands::share_open,
            share::commands::share_cancel,
            share::commands::share_account,
            share::commands::share_sign_out,
            commands::set_bottom_margin,
            commands::set_site_bottom_margin,
            commands::bottom_margin_for,
            commands::set_site_background_media,
            commands::set_back_button,
            commands::ai_state,
            commands::ai_save_provider,
            commands::ai_delete_provider,
            commands::ai_set_key,
            commands::ai_remove_key,
            commands::ai_set_active,
            commands::ai_test,
            commands::set_ai_preview,
            commands::ai_prepare,
            commands::ai_send,
            commands::ai_accept,
            commands::ai_reject,
            commands::ai_hub_build,
            commands::ai_hub_accept,
            commands::ai_hub_reject,
            commands::chat_list,
            commands::chat_save,
            commands::chat_delete,
            commands::chat_clear,
            ota::commands::ota_status,
            ota::commands::ota_confirm,
            ota::commands::ota_check,
            self_update::app_update_check,
            self_update::app_update_install,
        ])
        .run(context)
        .expect("error while running tauri application");
}
