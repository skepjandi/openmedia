use std::collections::BTreeMap;
use std::fmt::Write;

use serde::Serialize;

use super::matcher::Matcher;
use super::schema::{Recipe, Rule};
use super::script_policy::wrap;
use crate::error::{Error, Result};

/// The user's saved toggles: recipe id, then option id. An option with no entry keeps the
/// recipe's own default.
pub type OptionChoices = BTreeMap<String, BTreeMap<String, bool>>;

#[derive(Serialize)]
struct PageRecipe {
    id: String,
    matchers: Vec<Matcher>,
    css: String,
    scripts: Vec<usize>,
}

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
            Rule::Script { .. } => Ok(()),
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
            Ok(PageRecipe {
                id: recipe.id.clone(),
                matchers: matchers_of(scope.unwrap_or(&recipe.matches))?,
                css: css_of(scoped()),
                scripts: indices,
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
    let scripts = scripts.join(",\n");
    Ok(format!(
        r#"(() => {{
  try {{
    const scripts = [{scripts}];
    const recipes = {json};
    const here = window.location;
    const found = recipes.filter((recipe) => recipe.matchers.some((m) =>
      (m.scheme === "*" || m.scheme + ":" === here.protocol) &&
      new RegExp(m.host).test(here.hostname) &&
      new RegExp(m.path).test(here.pathname)));
    const css = found.map((recipe) => recipe.css).join("\n");
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
