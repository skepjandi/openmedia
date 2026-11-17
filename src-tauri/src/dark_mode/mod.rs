//! Dark mode for the pages the user opens: the colours of a page are rebuilt for a dark scheme,
//! by the page's own script at document start in every frame, after the recipe script. The user
//! can switch it off globally or per site, and a recipe can carry fixes for a site (see
//! `recipes`). This module holds the choices and turns them into that script.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const PAGE_SCRIPT: &str = include_str!("page.js");

/// How the colours of a page are changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DarkMethod {
    /// Every colour the page sets is rewritten for the dark scheme.
    #[default]
    Dynamic,
    /// The whole page is inverted, then images and video inverted back.
    Filter,
    /// As `Filter`, with the hues turned back so colours stay close to the original.
    #[serde(rename = "filterplus")]
    FilterPlus,
    /// One generated stylesheet of dark colours, with no watching of the page.
    Static,
}

/// When dark mode applies.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleKind {
    #[default]
    Always,
    /// Follows the page's `prefers-color-scheme`, which the app sets from its own theme.
    System,
    /// Between `from` and `to` in the device's local time, wrapping midnight.
    Time,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DarkSchedule {
    pub kind: ScheduleKind,
    /// `HH:MM`, 24-hour.
    pub from: String,
    pub to: String,
}

impl Default for DarkSchedule {
    fn default() -> Self {
        Self {
            kind: ScheduleKind::Always,
            from: "21:00".into(),
            to: "07:00".into(),
        }
    }
}

/// The dark mode choices for every site that has none of its own. Off until switched on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DarkMode {
    pub enabled: bool,
    pub method: DarkMethod,
    /// Percent, 50 to 150.
    pub brightness: u32,
    /// Percent, 50 to 150.
    pub contrast: u32,
    /// Percent, 0 to 100.
    pub sepia: u32,
    /// Percent, 0 to 100.
    pub grayscale: u32,
    /// `#rrggbb`: the background of the dark scheme.
    pub background: String,
    /// `#rrggbb`: the text colour of the dark scheme.
    pub text: String,
    pub schedule: DarkSchedule,
    /// Leaves a page alone when it is already dark.
    pub skip_dark_pages: bool,
    /// `color-scheme: dark`, so scrollbars, form controls and default colours are dark too.
    pub system_controls: bool,
    /// Themed scrollbars and text selection.
    pub scrollbars: bool,
    /// Looks at images: dark icons on transparent are inverted, large light diagrams toned down.
    pub images: bool,
    /// Tenths of a pixel, 0 to 10.
    pub text_stroke: u32,
}

impl Default for DarkMode {
    fn default() -> Self {
        Self {
            enabled: false,
            method: DarkMethod::Dynamic,
            brightness: 100,
            contrast: 100,
            sepia: 0,
            grayscale: 0,
            background: "#181a1b".into(),
            text: "#e8e6e3".into(),
            schedule: DarkSchedule::default(),
            skip_dark_pages: true,
            system_controls: true,
            scrollbars: true,
            images: true,
            text_stroke: 0,
        }
    }
}

/// Whether one site is forced on or off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SiteDarkMode {
    On,
    Off,
}

/// What the user chose for one site; a site without a choice follows the global settings.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SiteDark {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<SiteDarkMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<DarkMethod>,
}

impl SiteDark {
    pub fn is_empty(&self) -> bool {
        self.mode.is_none() && self.method.is_none()
    }
}

#[derive(Serialize)]
struct PageConfig<'a> {
    #[serde(flatten)]
    settings: &'a DarkMode,
    sites: &'a BTreeMap<String, SiteDark>,
}

fn in_range(value: u32, low: u32, high: u32, what: &'static str) -> Result<()> {
    if (low..=high).contains(&value) {
        Ok(())
    } else {
        Err(Error::InvalidDarkMode(what))
    }
}

fn is_color(value: &str) -> bool {
    let digits = value.strip_prefix('#').unwrap_or("");
    digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_clock(value: &str) -> bool {
    let Some((hours, minutes)) = value.split_once(':') else {
        return false;
    };
    let two_digits = |part: &str, max: u32| {
        part.len() == 2
            && part.bytes().all(|b| b.is_ascii_digit())
            && part.parse::<u32>().is_ok_and(|n| n <= max)
    };
    two_digits(hours, 23) && two_digits(minutes, 59)
}

impl DarkMode {
    /// Rejects values outside the ranges the shell offers. Colours may be written in either
    /// case; `normalized` stores them in lowercase.
    pub fn validate(&self) -> Result<()> {
        in_range(self.brightness, 50, 150, "brightness must be 50-150")?;
        in_range(self.contrast, 50, 150, "contrast must be 50-150")?;
        in_range(self.sepia, 0, 100, "sepia must be 0-100")?;
        in_range(self.grayscale, 0, 100, "grayscale must be 0-100")?;
        in_range(self.text_stroke, 0, 10, "text stroke must be 0-10")?;
        if !is_color(&self.background) || !is_color(&self.text) {
            return Err(Error::InvalidDarkMode("colours must be #rrggbb"));
        }
        if !is_clock(&self.schedule.from) || !is_clock(&self.schedule.to) {
            return Err(Error::InvalidDarkMode("times must be HH:MM"));
        }
        Ok(())
    }

    pub fn normalized(mut self) -> Self {
        self.background.make_ascii_lowercase();
        self.text.make_ascii_lowercase();
        self
    }

    /// The script for every page. With dark mode off it still runs, to take away what an
    /// earlier run left on a page that is already open.
    pub fn page_script(&self, sites: &BTreeMap<String, SiteDark>) -> String {
        let config = serde_json::to_string(&PageConfig {
            settings: self,
            sites,
        })
        .unwrap_or_else(|_| "{}".into());
        format!("({PAGE_SCRIPT})({config});")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_of(settings: &DarkMode, sites: &BTreeMap<String, SiteDark>) -> serde_json::Value {
        let script = settings.page_script(sites);
        let json = script
            .strip_prefix(&format!("({PAGE_SCRIPT})("))
            .and_then(|rest| rest.strip_suffix(");"))
            .expect("the script is the page function called with the config");
        serde_json::from_str(json).expect("the config is JSON")
    }

    #[test]
    fn it_is_off_with_the_documented_defaults() {
        let dark = DarkMode::default();
        assert!(!dark.enabled);
        assert_eq!(dark.method, DarkMethod::Dynamic);
        assert_eq!((dark.brightness, dark.contrast), (100, 100));
        assert_eq!((dark.sepia, dark.grayscale, dark.text_stroke), (0, 0, 0));
        assert_eq!(dark.background, "#181a1b");
        assert_eq!(dark.text, "#e8e6e3");
        assert_eq!(dark.schedule.kind, ScheduleKind::Always);
        assert_eq!(
            (dark.schedule.from.as_str(), dark.schedule.to.as_str()),
            ("21:00", "07:00")
        );
        assert!(dark.skip_dark_pages && dark.system_controls && dark.scrollbars && dark.images);
        assert!(dark.validate().is_ok());
    }

    #[test]
    fn the_config_has_exactly_the_contract_keys() {
        let mut sites = BTreeMap::new();
        sites.insert(
            "youtube.com".to_string(),
            SiteDark {
                mode: Some(SiteDarkMode::Off),
                method: None,
            },
        );
        let config = config_of(&DarkMode::default(), &sites);
        assert_eq!(
            config,
            serde_json::json!({
                "enabled": false,
                "method": "dynamic",
                "brightness": 100,
                "contrast": 100,
                "sepia": 0,
                "grayscale": 0,
                "background": "#181a1b",
                "text": "#e8e6e3",
                "schedule": { "kind": "always", "from": "21:00", "to": "07:00" },
                "skipDarkPages": true,
                "systemControls": true,
                "scrollbars": true,
                "images": true,
                "textStroke": 0,
                "sites": { "youtube.com": { "mode": "off" } }
            })
        );
    }

    #[test]
    fn method_names_match_the_shell() {
        for (name, method) in [
            ("dynamic", DarkMethod::Dynamic),
            ("filter", DarkMethod::Filter),
            ("filterplus", DarkMethod::FilterPlus),
            ("static", DarkMethod::Static),
        ] {
            let parsed: DarkMethod = serde_json::from_value(serde_json::json!(name)).unwrap();
            assert_eq!(parsed, method);
            assert_eq!(serde_json::to_value(method).unwrap(), name);
        }
    }

    #[test]
    fn unknown_choices_are_rejected() {
        assert!(serde_json::from_str::<DarkMode>(r#"{"method":"sepia"}"#).is_err());
        assert!(serde_json::from_str::<DarkMode>(r#"{"schedule":{"kind":"sunset"}}"#).is_err());
        assert!(serde_json::from_str::<DarkMode>(r#"{"bogus":1}"#).is_err());
        assert!(serde_json::from_str::<SiteDark>(r#"{"mode":"auto"}"#).is_err());
        assert!(serde_json::from_str::<SiteDark>(r#"{"method":"x"}"#).is_err());
        let parsed: DarkMode = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(parsed.enabled && parsed.images);
    }

    fn rejected(change: impl FnOnce(&mut DarkMode)) -> bool {
        let mut dark = DarkMode::default();
        change(&mut dark);
        dark.validate().is_err()
    }

    #[test]
    fn values_outside_the_ranges_are_rejected() {
        assert!(rejected(|d| d.brightness = 49));
        assert!(rejected(|d| d.brightness = 151));
        assert!(rejected(|d| d.contrast = 0));
        assert!(rejected(|d| d.sepia = 101));
        assert!(rejected(|d| d.grayscale = 101));
        assert!(rejected(|d| d.text_stroke = 11));
        assert!(rejected(|d| d.background = "181a1b".into()));
        assert!(rejected(|d| d.background = "#181a1".into()));
        assert!(rejected(|d| d.text = "#gggggg".into()));
        assert!(rejected(|d| d.text = "red".into()));
        assert!(rejected(|d| d.schedule.from = "24:00".into()));
        assert!(rejected(|d| d.schedule.to = "7:00".into()));
        assert!(rejected(|d| d.schedule.to = "07:60".into()));
        assert!(rejected(|d| d.schedule.from = "0700".into()));
    }

    #[test]
    fn the_edges_of_the_ranges_are_accepted() {
        let dark = DarkMode {
            brightness: 50,
            contrast: 150,
            sepia: 100,
            grayscale: 100,
            text_stroke: 10,
            background: "#ABCDEF".into(),
            schedule: DarkSchedule {
                kind: ScheduleKind::Time,
                from: "00:00".into(),
                to: "23:59".into(),
            },
            ..DarkMode::default()
        };
        assert!(dark.validate().is_ok());
        assert_eq!(dark.normalized().background, "#abcdef");
    }

    #[test]
    fn a_site_choice_with_nothing_in_it_is_empty() {
        assert!(SiteDark::default().is_empty());
        assert!(
            !SiteDark {
                mode: Some(SiteDarkMode::On),
                method: None
            }
            .is_empty()
        );
        assert!(
            !SiteDark {
                mode: None,
                method: Some(DarkMethod::Static)
            }
            .is_empty()
        );
    }
}
