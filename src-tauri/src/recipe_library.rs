//! The recipe library: every recipe that ships with the app (`recipes::bundled`), listed,
//! previewed and added to the user's installed recipes. Adding copies the bundled recipe into
//! local files, so nothing here needs the network. The commands are
//! shell-only; no site view can reach them.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::reload_script;
use crate::entitlement::Entitlement;
use crate::error::{Error, Result};
use crate::library::{
    FREE_FAVORITE_LIMIT, FavoriteInput, Library, MAX_FAVORITE_NAME_CHARS, PRO_FAVORITE_LIMIT,
};
use crate::recipes::{
    RecipePreview, Recipes, bundled, bundled::Bundled, current_platform_tag, preview_recipe,
};

/// One row of the library screen.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub summary: String,
    pub hosts: Vec<String>,
    /// Platform tags, `official` or `community`, and `hub` when the recipe has launcher tabs.
    pub tags: Vec<String>,
    pub homepage: Option<String>,
    /// Place in the editorial popular list, 0 for the first; none when it is not on the list.
    pub popular_rank: Option<u32>,
    /// True for the recipes the latest release added.
    pub is_new: bool,
    pub installed_version: Option<String>,
    pub update_available: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Listing {
    pub items: Vec<LibraryItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingOption {
    pub recipe_id: String,
    pub name: String,
    pub summary: String,
    pub homepage: String,
    pub tags: Vec<String>,
    /// Place in the editorial popular list, 0 for the first; none when it is not on the list.
    pub popular_rank: Option<u32>,
    /// True for the recipes the latest release added.
    pub is_new: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OnboardingResult {
    pub installed: Vec<String>,
    pub failed: Vec<String>,
}

fn is_newer(candidate: &str, installed: &str) -> bool {
    let parse = |version: &str| -> Option<Vec<u32>> {
        version.split('.').map(|part| part.parse().ok()).collect()
    };
    matches!((parse(candidate), parse(installed)), (Some(a), Some(b)) if a > b)
}

fn item_of(bundled: &Bundled, installed_version: Option<String>) -> LibraryItem {
    let recipe = &bundled.recipe;
    LibraryItem {
        id: recipe.id.clone(),
        name: recipe.name.clone(),
        version: recipe.version.clone(),
        author: recipe
            .meta
            .as_ref()
            .and_then(|meta| meta.author.clone())
            .unwrap_or_default(),
        summary: bundled.summary().to_owned(),
        hosts: bundled.hosts(),
        tags: bundled.tags(),
        homepage: recipe.homepage().map(str::to_owned),
        popular_rank: bundled::popular_rank(&recipe.id),
        is_new: bundled::is_new(&recipe.id),
        update_available: installed_version
            .as_deref()
            .is_some_and(|installed| is_newer(&recipe.version, installed)),
        installed_version,
    }
}

/// Official recipes for this platform first, then the other official ones, then community ones;
/// each group by name.
fn listing(
    entries: &[Bundled],
    platform: &str,
    installed_version: impl Fn(&str) -> Option<String>,
) -> Vec<LibraryItem> {
    let rank = |bundled: &Bundled| match (bundled.is_official(), bundled.has_tag(platform)) {
        (true, true) => 0,
        (true, false) => 1,
        (false, _) => 2,
    };
    let mut sorted: Vec<&Bundled> = entries.iter().collect();
    sorted.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.recipe.name.cmp(&b.recipe.name))
            .then_with(|| a.recipe.id.cmp(&b.recipe.id))
    });
    sorted
        .into_iter()
        .map(|bundled| item_of(bundled, installed_version(&bundled.recipe.id)))
        .collect()
}

fn bundled_recipe(id: &str) -> Result<&'static Bundled> {
    bundled::find(id).ok_or_else(|| Error::Library("not in the recipe library".into()))
}

fn install(recipes: &Recipes, id: &str) -> Result<()> {
    recipes.save_bundled(bundled_recipe(id)?.recipe.clone())?;
    Ok(())
}

/// Official entries for this platform that can become a favorite (they have a homepage).
fn options_for(entries: &[Bundled], platform: &str) -> Vec<OnboardingOption> {
    let mut options: Vec<OnboardingOption> = entries
        .iter()
        .filter(|bundled| bundled.is_official() && bundled.has_tag(platform))
        .filter_map(|bundled| {
            Some(OnboardingOption {
                recipe_id: bundled.recipe.id.clone(),
                name: bundled.recipe.name.clone(),
                summary: bundled.summary().to_owned(),
                homepage: bundled.recipe.homepage()?.to_owned(),
                tags: bundled.tags(),
                popular_rank: bundled::popular_rank(&bundled.recipe.id),
                is_new: bundled::is_new(&bundled.recipe.id),
            })
        })
        .collect();
    options.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.recipe_id.cmp(&b.recipe_id))
    });
    options
}

/// How many picks this person may apply: four, or six with Pro.
fn pick_limit(pro: bool) -> usize {
    if pro {
        PRO_FAVORITE_LIMIT
    } else {
        FREE_FAVORITE_LIMIT
    }
}

fn favorite_for(option: &OnboardingOption) -> FavoriteInput {
    FavoriteInput {
        name: option.name.chars().take(MAX_FAVORITE_NAME_CHARS).collect(),
        url: option.homepage.clone(),
        notify: true,
        landing: None,
    }
}

/// Installs the picks and puts each installed recipe's homepage in quick access. The list of
/// picks is checked first (no repeats, no more than 4, or 6 with Pro); a pick that is not an
/// official option, or that fails to save, is reported in `failed` and gets no favorite. Quick
/// access becomes exactly the installed picks, and is left alone when none installed.
fn apply_picks(
    entries: &[Bundled],
    recipes: &Recipes,
    library: &Library,
    ids: &[String],
    pro: bool,
) -> Result<OnboardingResult> {
    if ids.len() > PRO_FAVORITE_LIMIT {
        return Err(Error::Library("choose fewer sites".into()));
    }
    if ids.len() > pick_limit(pro) {
        return Err(Error::ProRequired);
    }
    if ids
        .iter()
        .enumerate()
        .any(|(position, id)| ids[..position].contains(id))
    {
        return Err(Error::Library("a site was chosen twice".into()));
    }
    let options = options_for(entries, current_platform_tag());
    let mut installed = Vec::new();
    let mut failed = Vec::new();
    let mut favorites = Vec::new();
    for id in ids {
        let Some(option) = options.iter().find(|option| &option.recipe_id == id) else {
            failed.push(id.clone());
            continue;
        };
        match install(recipes, id) {
            Ok(()) => {
                installed.push(id.clone());
                favorites.push(favorite_for(option));
            }
            Err(_) => failed.push(id.clone()),
        }
    }
    if !favorites.is_empty() {
        library.set_favorites(favorites)?;
    }
    Ok(OnboardingResult { installed, failed })
}

/// Every bundled recipe, with what this device has installed.
#[tauri::command]
pub fn library_list(recipes: State<'_, Recipes>) -> Listing {
    Listing {
        items: listing(bundled::all(), current_platform_tag(), |id| {
            recipes.imported_version(id)
        }),
    }
}

/// What adding the recipe would add, rule by rule, scripts in full. Saves nothing.
#[tauri::command]
pub fn library_preview(recipes: State<'_, Recipes>, recipe_id: String) -> Result<RecipePreview> {
    let bundled = bundled_recipe(&recipe_id)?;
    Ok(preview_recipe(
        &bundled.recipe,
        recipes.imported_version(&recipe_id).as_deref(),
    ))
}

/// The recipe as installed on this device, rule by rule, scripts in full. Saves nothing.
#[tauri::command]
pub fn recipe_preview(recipes: State<'_, Recipes>, recipe_id: String) -> Result<RecipePreview> {
    let recipe = recipes.get(&recipe_id).ok_or(Error::UnknownSite)?;
    Ok(preview_recipe(&recipe, None))
}

/// Async so the page views are reloaded off the main thread.
#[tauri::command]
pub async fn library_install(
    app: AppHandle,
    recipes: State<'_, Recipes>,
    library: State<'_, Library>,
    recipe_id: String,
) -> Result<()> {
    install(&recipes, &recipe_id)?;
    reload_script(&app, &library, &recipes)
}

#[tauri::command]
pub async fn library_uninstall(
    app: AppHandle,
    recipes: State<'_, Recipes>,
    library: State<'_, Library>,
    recipe_id: String,
) -> Result<()> {
    recipes.remove_imported(&recipe_id)?;
    reload_script(&app, &library, &recipes)
}

/// The official recipes for this platform, for the first-run quick access step.
#[tauri::command]
pub fn onboarding_options() -> Vec<OnboardingOption> {
    options_for(bundled::all(), current_platform_tag())
}

/// Installs the user's picks and makes them the quick access. The shell then completes
/// onboarding.
#[tauri::command]
pub async fn onboarding_apply(
    app: AppHandle,
    recipes: State<'_, Recipes>,
    library: State<'_, Library>,
    entitlement: State<'_, Entitlement>,
    recipe_ids: Vec<String>,
) -> Result<OnboardingResult> {
    let pro = entitlement.require_pro().is_ok();
    let result = apply_picks(bundled::all(), &recipes, &library, &recipe_ids, pro)?;
    if !result.installed.is_empty() {
        reload_script(&app, &library, &recipes)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> (tempfile::TempDir, Recipes, Library) {
        let dir = tempfile::tempdir().unwrap();
        let recipes = Recipes::load(dir.path().join("recipes")).unwrap();
        let library = Library::load(dir.path().join("library.json")).unwrap();
        (dir, recipes, library)
    }

    fn official_ids(platform: &str) -> Vec<String> {
        options_for(bundled::all(), platform)
            .into_iter()
            .map(|option| option.recipe_id)
            .collect()
    }

    #[test]
    fn versions_compare_numerically_not_as_text() {
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "2.0.0"));
        assert!(!is_newer("x", "1.0.0"));
    }

    #[test]
    fn the_listing_has_every_bundled_recipe_official_for_this_platform_first() {
        let items = listing(bundled::all(), "mobile", |_| None);
        assert_eq!(items.len(), bundled::all().len());
        let mobile_official = bundled::all()
            .iter()
            .filter(|b| b.is_official() && b.has_tag("mobile"))
            .count();
        assert!(mobile_official > 0);
        for item in &items[..mobile_official] {
            assert!(item.tags.contains(&"official".to_owned()));
            assert!(item.tags.contains(&"mobile".to_owned()));
        }
        let youtube = items
            .iter()
            .find(|item| item.id == "market.official.youtube");
        let youtube = youtube.unwrap();
        assert_eq!(youtube.author, "OpenMedia");
        assert!(!youtube.summary.is_empty());
        assert!(youtube.hosts.contains(&"youtube.com".to_owned()));
        assert_eq!(
            youtube.homepage.as_deref(),
            Some("https://www.youtube.com/")
        );
    }

    #[test]
    fn the_listing_marks_installed_recipes_and_available_updates() {
        let version = |installed: &'static str| {
            listing(bundled::all(), "mobile", move |_| {
                Some(installed.to_owned())
            })
        };
        let current = bundled::find("market.official.youtube")
            .unwrap()
            .recipe
            .version
            .clone();
        let items = version("0.0.1");
        assert!(items.iter().all(|item| item.update_available));
        assert_eq!(items[0].installed_version.as_deref(), Some("0.0.1"));
        let same = listing(bundled::all(), "mobile", |_| Some(current.clone()));
        assert!(same.iter().all(|item| item.installed_version.is_some()));
        assert!(
            same.iter()
                .filter(|item| item.id == "market.official.youtube")
                .all(|item| !item.update_available)
        );
    }

    #[test]
    fn installing_copies_the_bundled_recipe_and_uninstalling_removes_it() {
        let (_dir, recipes, _library) = temp();
        install(&recipes, "market.official.youtube").unwrap();
        let bundled = bundled::find("market.official.youtube").unwrap();
        assert_eq!(
            recipes.imported_version("market.official.youtube"),
            Some(bundled.recipe.version.clone())
        );
        recipes.remove_imported("market.official.youtube").unwrap();
        assert!(recipes.get("market.official.youtube").is_none());
        assert!(matches!(
            install(&recipes, "market.nothing"),
            Err(Error::Library(_))
        ));
    }

    #[test]
    fn an_installed_recipe_survives_a_restart() {
        let (dir, recipes, _library) = temp();
        install(&recipes, "market.official.reddit").unwrap();
        let again = Recipes::load(dir.path().join("recipes")).unwrap();
        assert!(again.get("market.official.reddit").is_some());
    }

    #[test]
    fn only_official_entries_for_this_platform_with_a_homepage_are_offered() {
        for platform in ["mobile", "desktop"] {
            let ids = official_ids(platform);
            assert!(!ids.is_empty(), "{platform}");
            assert!(ids.iter().all(|id| id.starts_with("market.official.")));
            for id in &ids {
                let bundled = bundled::find(id).unwrap();
                assert!(bundled.has_tag(platform) && bundled.recipe.homepage().is_some());
            }
            let mut sorted = ids.clone();
            sorted.sort_by_key(|id| bundled::find(id).unwrap().recipe.name.clone());
            assert_eq!(ids, sorted);
        }
    }

    #[test]
    fn a_favorite_is_the_recipe_name_cut_to_the_favorite_limit_and_its_homepage() {
        let option = OnboardingOption {
            recipe_id: "market.official.x".into(),
            name: "A very long recipe name indeed".into(),
            summary: String::new(),
            homepage: "https://x.example/".into(),
            tags: vec![],
            popular_rank: None,
            is_new: false,
        };
        let favorite = favorite_for(&option);
        assert_eq!(favorite.name.chars().count(), MAX_FAVORITE_NAME_CHARS);
        assert_eq!(favorite.url, "https://x.example/");
    }

    #[test]
    fn picks_are_limited_to_four_or_six_with_pro_and_may_not_repeat() {
        let (_dir, recipes, library) = temp();
        let ids = official_ids(current_platform_tag());
        let pick = |count: usize| ids[..count].to_vec();
        let apply =
            |ids: &[String], pro: bool| apply_picks(bundled::all(), &recipes, &library, ids, pro);
        assert!(matches!(apply(&pick(5), false), Err(Error::ProRequired)));
        assert!(matches!(
            apply(&pick(5), true).map(|r| r.installed.len()),
            Ok(5)
        ));
        let too_many = vec![ids[0].clone(); 7];
        assert!(matches!(apply(&too_many, true), Err(Error::Library(_))));
        let twice = [ids[0].clone(), ids[0].clone()];
        assert!(matches!(apply(&twice, false), Err(Error::Library(_))));
    }

    #[test]
    fn applying_installs_the_picks_and_makes_them_the_quick_access() {
        let (_dir, recipes, library) = temp();
        let ids = official_ids(current_platform_tag());
        let picks = vec![ids[0].clone(), "market.official.not-offered".to_owned()];
        let result = apply_picks(bundled::all(), &recipes, &library, &picks, false).unwrap();
        assert_eq!(result.installed, [ids[0].clone()]);
        assert_eq!(result.failed, ["market.official.not-offered"]);
        assert!(recipes.get(&ids[0]).is_some());
        let favorites = library.favorites().unwrap();
        assert_eq!(favorites.len(), 1);
        let homepage = bundled::find(&ids[0]).unwrap().recipe.homepage().unwrap();
        assert_eq!(favorites[0].url, homepage);
    }

    #[test]
    fn applying_nothing_leaves_quick_access_alone() {
        let (_dir, recipes, library) = temp();
        let before = library.favorites().unwrap();
        let result = apply_picks(bundled::all(), &recipes, &library, &[], false).unwrap();
        assert!(result.installed.is_empty() && result.failed.is_empty());
        assert_eq!(library.favorites().unwrap(), before);
    }
}
