//! Export and import of recipes as text. Import is two steps so the user reviews every rule
//! before anything is saved: `preview_recipe_import` parses and validates, `import_recipes`
//! parses and validates the same text again and saves only the chosen recipes.

use tauri::{AppHandle, State};

use crate::commands::reload_script;
use crate::entitlement::Entitlement;
use crate::error::Result;
use crate::library::Library;
use crate::recipes::{RecipePreview, Recipes};

/// The bundle text for the chosen recipes. Exporting is a Pro feature; importing stays free.
#[tauri::command]
pub fn export_recipes(
    recipes: State<'_, Recipes>,
    entitlement: State<'_, Entitlement>,
    recipe_ids: Vec<String>,
) -> Result<String> {
    entitlement.require_pro()?;
    recipes.export(&recipe_ids)
}

#[tauri::command]
pub fn preview_recipe_import(
    recipes: State<'_, Recipes>,
    text: String,
) -> Result<Vec<RecipePreview>> {
    recipes.preview_import(&text)
}

/// Async for the same reason as `open_site`: reloading the script touches the page views.
#[tauri::command]
pub async fn import_recipes(
    app: AppHandle,
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    text: String,
    recipe_ids: Vec<String>,
) -> Result<()> {
    recipes.save_imported(&text, &recipe_ids)?;
    reload_script(&app, &library, &recipes)
}

#[tauri::command]
pub async fn remove_imported_recipe(
    app: AppHandle,
    library: State<'_, Library>,
    recipes: State<'_, Recipes>,
    recipe_id: String,
) -> Result<()> {
    recipes.remove_imported(&recipe_id)?;
    reload_script(&app, &library, &recipes)
}
