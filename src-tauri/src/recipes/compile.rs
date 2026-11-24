use std::collections::BTreeMap;
use std::fmt::Write;

use serde::Serialize;

use super::crowd::{self, CROWD_RUNTIME, PageCrowd};
use super::matcher::Matcher;
use super::prune::{self, PRUNE_RUNTIME, PagePrune};
use super::route::RouteGlob;
use super::schema::{
    DarkFixMethod, DarkFixMode, OptionValue, Recipe, Rule, Selected, VideoMenuKind,
};
use super::script_policy::wrap;
use crate::error::{Error, Result};

/// The user's saved settings: recipe id, then option id. An option with no entry keeps the
/// recipe's own default.
pub type OptionChoices = BTreeMap<String, BTreeMap<String, OptionValue>>;

#[derive(Serialize)]
struct PageRecipe {
    id: String,
    matchers: Vec<Matcher>,
    css: String,
    scripts: Vec<usize>,
    menus: Vec<PageMenu>,
    prunes: Vec<PagePrune>,
    redirects: Vec<PageRedirect>,
    crowds: Vec<PageCrowd>,
    darks: Vec<PageDark>,
}

/// A `dark` rule as the dark mode engine reads it from `openmedia.darkFixes`.
#[derive(Serialize)]
struct PageDark {
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<DarkFixMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<DarkFixMethod>,
    invert: Vec<String>,
}

/// A `redirect` rule as the page's runtime reads it (`route_redirect.js`): the compiled path glob
/// and the same-site path to go to.
#[derive(Serialize)]
struct PageRedirect {
    id: String,
    #[serde(flatten)]
    glob: RouteGlob,
    to: String,
}

/// A `videoMenu` rule as the page's runtime reads it (`video_menu.js`): selectors and one way to
/// tell the entry in use, nothing that runs.
#[derive(Serialize)]
struct PageMenu {
    kind: VideoMenuKind,
    title: String,
    open: Vec<String>,
    items: String,
    selected: Selected,
    close: Option<String>,
}

/// The runtime of the `videoMenu` rules, embedded only in a page script that has some.
const MENU_RUNTIME: &str = include_str!("../video_menu.js");

/// The runtime of the `redirect` rules, embedded only in a page script that has some.
const REDIRECT_RUNTIME: &str = include_str!("../route_redirect.js");

/// CSS for the rules of one recipe that currently apply. Hiding is `display: none`, so the
/// element stays in the DOM and the site's own scripts keep working.
#[cfg(test)]
pub fn recipe_css(recipe: &Recipe, choices: &OptionChoices) -> String {
    let saved = choices.get(&recipe.id);
    css_of(
        recipe
            .rules
            .iter()
            .filter(|rule| recipe.rule_applies(rule, saved)),
    )
}

fn css_of<'a>(rules: impl Iterator<Item = &'a Rule>) -> String {
    let mut css = String::new();
    for rule in rules {
        let _ = match rule {
            Rule::Hide { target, .. } => writeln!(css, "{}{{display:none!important}}", target.css),
            Rule::Script { .. }
            | Rule::VideoMenu { .. }
            | Rule::Prune { .. }
            | Rule::Redirect { .. }
            | Rule::SponsorBlock { .. }
            | Rule::DislikeCount { .. }
            | Rule::Dark { .. } => Ok(()),
            Rule::Css {
                target,
                declarations,
                ..
            } => {
                let body: String = declarations
                    .iter()
                    .map(|(property, value)| format!("{property}:{value}!important;"))
                    .collect();
                writeln!(css, "{}{{{body}}}", target.css)
            }
        };
    }
    css
}

fn matchers_of(patterns: &[String]) -> Result<Vec<Matcher>> {
    patterns
        .iter()
        .map(|pattern| Matcher::parse(pattern))
        .collect()
}

/// The page entries of one recipe: the rules with no `on` apply wherever the recipe matches, and
/// the rules limited to some patterns form one entry for those patterns.
fn page_recipes(
    recipe: &Recipe,
    choices: &OptionChoices,
    scripts: &mut Vec<String>,
) -> Result<Vec<PageRecipe>> {
    let saved = choices.get(&recipe.id);
    let applying: Vec<&Rule> = recipe
        .rules
        .iter()
        .filter(|rule| recipe.rule_applies(rule, saved))
        .collect();
    let mut scopes: Vec<Option<&[String]>> = Vec::new();
    for rule in &applying {
        if !scopes.contains(&rule.on()) {
            scopes.push(rule.on());
        }
    }
    if scopes.is_empty() {
        scopes.push(None);
    }
    scopes
        .into_iter()
        .map(|scope| {
            let scoped = || applying.iter().copied().filter(|rule| rule.on() == scope);
            let indices = scoped()
                .filter_map(|rule| match rule {
                    Rule::Script { code, .. } => Some(code),
                    _ => None,
                })
                .map(|code| {
                    scripts.push(wrap(code));
                    scripts.len() - 1
                })
                .collect();
            let menus = scoped()
                .filter_map(|rule| match rule {
                    Rule::VideoMenu {
                        kind,
                        title,
                        open,
                        items,
                        selected,
                        close,
                        ..
                    } => Some(PageMenu {
                        kind: *kind,
                        title: title.trim().to_owned(),
                        open: open.iter().map(|target| target.css.clone()).collect(),
                        items: items.css.clone(),
                        selected: selected.clone(),
                        close: close.as_ref().map(|target| target.css.clone()),
                    }),
                    _ => None,
                })
                .collect();
            let prunes = scoped()
                .filter_map(|rule| match rule {
                    Rule::Prune { urls, remove, .. } => Some(prune::page_rule(urls, remove)),
                    _ => None,
                })
                .collect();
            let redirects = scoped()
                .filter_map(|rule| match rule {
                    Rule::Redirect { id, when, to, .. } => {
                        Some(RouteGlob::parse(&when.path).map(|glob| PageRedirect {
                            id: id.clone(),
                            glob,
                            to: to.clone(),
                        }))
                    }
                    _ => None,
                })
                .collect::<Result<Vec<_>>>()?;
            let crowds = scoped()
                .filter_map(|rule| match rule {
                    Rule::SponsorBlock {
                        id,
                        video_id,
                        categories,
                        ..
                    } => Some(crowd::sponsor_block_page(id, video_id, categories)),
                    Rule::DislikeCount {
                        id,
                        video_id,
                        target,
                        ..
                    } => Some(crowd::dislike_count_page(id, video_id, target)),
                    _ => None,
                })
                .collect();
            let darks = scoped()
                .filter_map(|rule| match rule {
                    Rule::Dark {
                        mode,
                        method,
                        invert,
                        ..
                    } => Some(PageDark {
                        mode: *mode,
                        method: *method,
                        invert: invert.clone(),
                    }),
                    _ => None,
                })
                .collect();
            Ok(PageRecipe {
                id: recipe.id.clone(),
                matchers: matchers_of(scope.unwrap_or(&recipe.matches))?,
                css: css_of(scoped()),
                scripts: indices,
                menus,
                prunes,
                redirects,
                crowds,
                darks,
            })
        })
        .collect()
}

/// One script for every recipe, run at document start in each frame. The page matches its own
/// location against the recipes, so a single script stays correct across navigations. Script
/// rules are embedded as raw function expressions, each validated to be exactly one, so the page
/// needs neither `eval` nor `new Function`.
pub fn page_script(recipes: &[Recipe], choices: &OptionChoices) -> Result<String> {
    let mut scripts = Vec::new();
    let page: Vec<PageRecipe> = recipes
        .iter()
        .map(|recipe| page_recipes(recipe, choices, &mut scripts))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect();
    let json = serde_json::to_string(&page).map_err(|e| Error::Recipe(e.to_string()))?;
    let menu_runtime = if page.iter().any(|recipe| !recipe.menus.is_empty()) {
        MENU_RUNTIME.trim()
    } else {
        "null"
    };
    let prune_runtime = if page.iter().any(|recipe| !recipe.prunes.is_empty()) {
        PRUNE_RUNTIME.trim()
    } else {
        "null"
    };
    let redirect_runtime = if page.iter().any(|recipe| !recipe.redirects.is_empty()) {
        REDIRECT_RUNTIME.trim()
    } else {
        "null"
    };
    let crowd_runtime = if page.iter().any(|recipe| !recipe.crowds.is_empty()) {
        CROWD_RUNTIME.trim()
    } else {
        "null"
    };
    let scripts = scripts.join(",\n");
    Ok(format!(
        r#"(() => {{
  try {{
    const cleanupKey = Symbol.for("openmedia.cleanup");
    const cleanups = window[cleanupKey];
    if (cleanups) {{
      window[cleanupKey] = [];
      cleanups.forEach((cleanup) => {{ try {{ cleanup(); }} catch (_) {{}} }});
    }}
    const scripts = [{scripts}];
    const recipes = {json};
    const here = window.location;
    const found = recipes.filter((recipe) => recipe.matchers.some((m) =>
      (m.scheme === "*" || m.scheme + ":" === here.protocol) &&
      new RegExp(m.host).test(here.hostname) &&
      new RegExp(m.path).test(here.pathname)));
    const css = found.map((recipe) => recipe.css).join("\n");
    const redirectRuntime = {redirect_runtime};
    const redirects = recipes.reduce((all, recipe) => all.concat(recipe.redirects.map((rule) =>
      Object.assign({{ key: recipe.id + "/" + rule.id, matchers: recipe.matchers }}, rule))), []);
    if (redirectRuntime && redirects.length) {{
      try {{ redirectRuntime(redirects); }} catch (_) {{}}
    }}
    const menuRuntime = {menu_runtime};
    const menus = found.reduce((all, recipe) => all.concat(recipe.menus), []);
    if (menuRuntime && menus.length) {{
      try {{ menuRuntime(menus); }} catch (_) {{}}
    }}
    const pruneRuntime = {prune_runtime};
    const prunes = found.reduce((all, recipe) => all.concat(recipe.prunes), []);
    const pruneState = window[Symbol.for("openmedia.prune")];
    if (pruneRuntime && prunes.length) {{
      try {{ pruneRuntime(prunes); }} catch (_) {{}}
    }} else if (pruneState) {{
      try {{ pruneState.rules = []; }} catch (_) {{}}
    }}
    const crowdRuntime = {crowd_runtime};
    const crowds = found.reduce((all, recipe) => all.concat(recipe.crowds), []);
    const crowdState = window[Symbol.for("openmedia.crowd")];
    if (crowdRuntime && crowds.length) {{
      try {{ crowdRuntime(crowds); }} catch (_) {{}}
    }} else if (crowdState) {{
      try {{ crowdState.set([]); }} catch (_) {{}}
    }}
    const darkFixes = found.reduce((all, recipe) => all.concat(recipe.darks), []);
    const darkKey = Symbol.for("openmedia.darkFixes");
    if (darkFixes.length) document[darkKey] = darkFixes;
    else delete document[darkKey];
    const run = (index) => {{
      try {{ scripts[index].call(undefined); }} catch (_) {{}}
    }};
    const indices = found.reduce((all, recipe) => all.concat(recipe.scripts), []);
    if (indices.length) {{
      if (document.readyState === "loading") {{
        document.addEventListener("DOMContentLoaded", () => indices.forEach(run), {{ once: true }});
      }} else indices.forEach(run);
    }}
    if (!css) return;
    const style = document.createElement("style");
    style.setAttribute("data-openmedia", "");
    style.textContent = css;
    const attach = () => (document.head || document.documentElement).appendChild(style);
    if (document.documentElement) attach();
    else new MutationObserver((_, observer) => {{
      if (document.documentElement) {{ observer.disconnect(); attach(); }}
    }}).observe(document, {{ childList: true }});
  }} catch (_) {{}}
}})();"#
    ))
}
