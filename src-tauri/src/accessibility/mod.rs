//! Accessibility choices that reach the pages the user opens: epilepsy protection and the
//! reading aids for dyslexia. The shell applies the same choices to its own screens; this module
//! turns them into one script that runs at document start in every frame, after the recipe script.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};

const PAGE_SCRIPT: &str = include_str!("page.js");

const OPEN_DYSLEXIC_REGULAR: &[u8] = include_bytes!("fonts/OpenDyslexic-Regular.woff2");
const HYPERLEGIBLE_REGULAR: &[u8] = include_bytes!("fonts/AtkinsonHyperlegible-Regular.woff2");
const HYPERLEGIBLE_BOLD: &[u8] = include_bytes!("fonts/AtkinsonHyperlegible-Bold.woff2");

/// The family the injected faces are registered under. Nothing else on a page uses this name.
const FONT_FAMILY: &str = "OpenMedia Reading";

/// Every duration is cut to 1 ms and every animation plays once, so an element still ends in its
/// final state: `animation: none` would leave one that fades in from `opacity: 0` invisible.
const CALM_CSS: &str = "*,*::before,*::after{animation-duration:1ms!important;\
animation-delay:0s!important;animation-iteration-count:1!important;\
transition-duration:1ms!important;transition-delay:0s!important;\
scroll-behavior:auto!important}";

/// Elements whose text is drawn with an icon font or a fixed-width face, which a new font or
/// wider spacing would turn into stray letters or break.
const GLYPH_ELEMENTS: &str = "i,svg,svg *,code,pre,kbd,samp,.fa,[class^=\"fa-\"],[class*=\" fa-\"],\
[class*=\"icon\" i],[class*=\"material\" i],[class*=\"glyph\" i]";

/// A reading font for pages and the app. The files hold the Latin letters; other scripts keep the
/// page's own font.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadingFont {
    #[default]
    Off,
    OpenDyslexic,
    Hyperlegible,
}

/// A colour laid over the page to cut glare: a pastel multiplied into whatever is underneath.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tint {
    #[default]
    Off,
    Cream,
    Mint,
    Blue,
}

impl Tint {
    fn color(self) -> Option<&'static str> {
        match self {
            Tint::Off => None,
            Tint::Cream => Some("rgb(255 240 180 / 0.5)"),
            Tint::Mint => Some("rgb(200 245 215 / 0.5)"),
            Tint::Blue => Some("rgb(200 228 255 / 0.5)"),
        }
    }
}

/// What the user switched on. Everything is off until chosen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Accessibility {
    /// Stops animation, transitions, autoplaying video and animated GIFs.
    pub epilepsy_protection: bool,
    pub font: ReadingFont,
    /// Wider letters, words and lines (the WCAG 1.4.12 text-spacing values).
    pub spacing: bool,
    pub tint: Tint,
}

#[derive(Serialize)]
struct Face {
    weight: &'static str,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageConfig {
    family: &'static str,
    css: String,
    /// Applied in the top frame only: the tint would otherwise multiply once per nested frame.
    top_css: String,
    fonts: Vec<Face>,
    calm: bool,
}

impl Accessibility {
    /// The script for every page. With every choice off it still runs, to take away what an
    /// earlier run left on a page that is already open.
    pub fn page_script(&self) -> String {
        let config = serde_json::to_string(&self.page_config()).unwrap_or_else(|_| "{}".into());
        format!("({PAGE_SCRIPT})({config});")
    }

    fn page_config(&self) -> PageConfig {
        PageConfig {
            family: FONT_FAMILY,
            css: self.css(),
            top_css: self.tint.color().map(tint_css).unwrap_or_default(),
            fonts: self.faces(),
            calm: self.epilepsy_protection,
        }
    }

    fn css(&self) -> String {
        let mut css = String::new();
        if self.epilepsy_protection {
            css.push_str(CALM_CSS);
        }
        if self.font != ReadingFont::Off {
            css.push_str(&format!(
                ":not(:is({GLYPH_ELEMENTS})){{font-family:\"{FONT_FAMILY}\",sans-serif!important}}"
            ));
        }
        if self.spacing {
            // Spacing inherits, so the glyph elements are reset: letter-spacing switches off the
            // ligatures an icon font draws its icons with.
            css.push_str(&format!(
                ":not(:is({GLYPH_ELEMENTS})){{letter-spacing:.12em!important;\
word-spacing:.16em!important}}\
:is({GLYPH_ELEMENTS}){{letter-spacing:normal!important;word-spacing:normal!important}}\
p,li,dd,dt,blockquote,td,th,figcaption{{line-height:1.5!important}}"
            ));
        }
        css
    }

    fn faces(&self) -> Vec<Face> {
        let face = |weight, bytes: &[u8]| Face {
            weight,
            data: STANDARD.encode(bytes),
        };
        match self.font {
            ReadingFont::Off => Vec::new(),
            ReadingFont::OpenDyslexic => vec![face("400", OPEN_DYSLEXIC_REGULAR)],
            ReadingFont::Hyperlegible => vec![
                face("400", HYPERLEGIBLE_REGULAR),
                face("700", HYPERLEGIBLE_BOLD),
            ],
        }
    }
}

fn tint_css(color: &str) -> String {
    format!(
        "html::after{{content:\"\";position:fixed;inset:0;pointer-events:none;\
z-index:2147483647;background:{color};mix-blend-mode:multiply}}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_of(settings: Accessibility) -> serde_json::Value {
        let script = settings.page_script();
        let json = script
            .strip_prefix(&format!("({PAGE_SCRIPT})("))
            .and_then(|rest| rest.strip_suffix(");"))
            .expect("the script is the page function called with the config");
        serde_json::from_str(json).expect("the config is JSON")
    }

    #[test]
    fn everything_is_off_until_chosen() {
        let config = config_of(Accessibility::default());
        assert_eq!(config["calm"], false);
        assert_eq!(config["css"], "");
        assert_eq!(config["topCss"], "");
        assert_eq!(config["fonts"], serde_json::json!([]));
    }

    #[test]
    fn epilepsy_protection_stills_motion_without_hiding_final_states() {
        let config = config_of(Accessibility {
            epilepsy_protection: true,
            ..Accessibility::default()
        });
        let css = config["css"].as_str().unwrap();
        assert!(css.contains("animation-duration:1ms!important"));
        assert!(css.contains("transition-duration:1ms!important"));
        assert!(css.contains("animation-iteration-count:1!important"));
        assert!(!css.contains("animation:none"));
        assert_eq!(config["calm"], true);
    }

    #[test]
    fn a_reading_font_ships_its_faces_and_spares_icon_fonts() {
        let atkinson = config_of(Accessibility {
            font: ReadingFont::Hyperlegible,
            ..Accessibility::default()
        });
        let faces = atkinson["fonts"].as_array().unwrap();
        assert_eq!(faces.len(), 2);
        for face in faces {
            let bytes = STANDARD.decode(face["data"].as_str().unwrap()).unwrap();
            assert_eq!(&bytes[..4], b"wOF2");
        }
        let css = atkinson["css"].as_str().unwrap();
        assert!(css.contains("\"OpenMedia Reading\",sans-serif!important"));
        assert!(css.contains("[class*=\"icon\" i]"));

        let dyslexic = config_of(Accessibility {
            font: ReadingFont::OpenDyslexic,
            ..Accessibility::default()
        });
        assert_eq!(dyslexic["fonts"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn spacing_uses_the_wcag_text_spacing_values() {
        let config = config_of(Accessibility {
            spacing: true,
            ..Accessibility::default()
        });
        let css = config["css"].as_str().unwrap();
        assert!(css.contains("letter-spacing:.12em!important"));
        assert!(css.contains("word-spacing:.16em!important"));
        assert!(css.contains("{letter-spacing:normal!important;word-spacing:normal!important}"));
        assert!(css.contains("line-height:1.5!important"));
        assert_eq!(config["fonts"], serde_json::json!([]));
    }

    #[test]
    fn the_tint_goes_on_the_top_frame_only() {
        let config = config_of(Accessibility {
            tint: Tint::Cream,
            ..Accessibility::default()
        });
        assert_eq!(config["css"], "");
        let top = config["topCss"].as_str().unwrap();
        assert!(top.contains("mix-blend-mode:multiply"));
        assert!(top.contains("pointer-events:none"));
    }

    #[test]
    fn a_saved_choice_from_an_older_file_keeps_unlisted_options_off() {
        let parsed: Accessibility = serde_json::from_str(r#"{"epilepsyProtection":true}"#).unwrap();
        assert!(parsed.epilepsy_protection);
        assert_eq!(parsed.font, ReadingFont::Off);
        assert!(serde_json::from_str::<Accessibility>(r#"{"font":"comic"}"#).is_err());
    }
}
