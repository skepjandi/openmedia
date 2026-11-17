//! The technology detector: what a page says it is built with.
//!
//! A fixed script collects evidence in the page (which known globals and selectors exist, the
//! script and stylesheet addresses, the generator tag and the cookie names) and Rust matches it
//! against [`TECHNOLOGIES`]. The page is hostile: it can only make a technology appear that the
//! table already names, never put its own text in front of the user. Response headers are not
//! visible from inside the page, so server-only technologies are not found.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

const SCRIPT_TEMPLATE: &str = include_str!("tech_detect.js");

/// How much of each list the page may hand back.
const MAX_ITEMS: usize = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Framework,
    Platform,
    Analytics,
    Service,
    Design,
    Delivery,
}

/// What shows a technology is on the page. Any one hit is enough.
struct Technology {
    name: &'static str,
    category: Category,
    /// Dotted paths under `window`.
    globals: &'static [&'static str],
    /// CSS selectors.
    selectors: &'static [&'static str],
    /// Lowercase fragments of a script or stylesheet address.
    urls: &'static [&'static str],
    /// Lowercase fragments of the generator tag.
    generator: &'static [&'static str],
    /// Cookie name prefixes.
    cookies: &'static [&'static str],
}

const NONE: &[&str] = &[];

const fn tech(name: &'static str, category: Category) -> Technology {
    Technology {
        name,
        category,
        globals: NONE,
        selectors: NONE,
        urls: NONE,
        generator: NONE,
        cookies: NONE,
    }
}

use Category::{Analytics, Delivery, Design, Framework, Platform, Service};

static TECHNOLOGIES: &[Technology] = &[
    Technology {
        globals: &["React", "__REACT_DEVTOOLS_GLOBAL_HOOK__"],
        selectors: &["[data-reactroot]"],
        urls: &["/react.", "react-dom"],
        ..tech("React", Framework)
    },
    Technology {
        globals: &["Vue", "__VUE__"],
        selectors: &["[data-v-app]"],
        urls: &["/vue.", "vue.runtime"],
        ..tech("Vue.js", Framework)
    },
    Technology {
        globals: &["getAllAngularRootElements"],
        selectors: &["[ng-version]", "[ng-app]"],
        urls: &["angular"],
        ..tech("Angular", Framework)
    },
    Technology {
        globals: &["__SVELTE_HMR"],
        selectors: &["[class*='svelte-']"],
        urls: &["svelte"],
        ..tech("Svelte", Framework)
    },
    Technology {
        globals: &["__NEXT_DATA__", "next.version"],
        selectors: &["#__next"],
        urls: &["/_next/"],
        ..tech("Next.js", Framework)
    },
    Technology {
        globals: &["__NUXT__", "$nuxt"],
        selectors: &["#__nuxt"],
        urls: &["/_nuxt/"],
        ..tech("Nuxt", Framework)
    },
    Technology {
        globals: &["___gatsby"],
        selectors: &["#___gatsby"],
        ..tech("Gatsby", Framework)
    },
    Technology {
        globals: &["__remixContext"],
        ..tech("Remix", Framework)
    },
    Technology {
        selectors: &["astro-island", "[data-astro-cid]"],
        generator: &["astro"],
        ..tech("Astro", Framework)
    },
    Technology {
        globals: &["jQuery", "jQuery.fn.jquery"],
        urls: &["jquery"],
        ..tech("jQuery", Framework)
    },
    Technology {
        globals: &["Alpine"],
        selectors: &["[x-data]"],
        urls: &["alpine"],
        ..tech("Alpine.js", Framework)
    },
    Technology {
        globals: &["htmx"],
        selectors: &["[hx-get]", "[hx-post]"],
        urls: &["htmx"],
        ..tech("htmx", Framework)
    },
    Technology {
        globals: &["Ember"],
        selectors: &[".ember-application"],
        ..tech("Ember.js", Framework)
    },
    Technology {
        globals: &["Backbone"],
        ..tech("Backbone.js", Framework)
    },
    Technology {
        globals: &["_.VERSION", "lodash"],
        urls: &["lodash"],
        ..tech("Lodash", Framework)
    },
    Technology {
        globals: &["moment"],
        urls: &["moment.min", "/moment."],
        ..tech("Moment.js", Framework)
    },
    Technology {
        globals: &["THREE"],
        urls: &["three.min", "three.module"],
        ..tech("Three.js", Framework)
    },
    Technology {
        globals: &["gsap"],
        urls: &["gsap"],
        ..tech("GSAP", Framework)
    },
    Technology {
        urls: &["turbo"],
        selectors: &["turbo-frame"],
        ..tech("Hotwire Turbo", Framework)
    },
    Technology {
        generator: &["wordpress"],
        urls: &["/wp-content/", "/wp-includes/"],
        selectors: &["link[rel='https://api.w.org/']"],
        ..tech("WordPress", Platform)
    },
    Technology {
        globals: &["Shopify"],
        urls: &["cdn.shopify.com"],
        ..tech("Shopify", Platform)
    },
    Technology {
        generator: &["drupal"],
        globals: &["Drupal"],
        ..tech("Drupal", Platform)
    },
    Technology {
        generator: &["joomla"],
        ..tech("Joomla", Platform)
    },
    Technology {
        generator: &["wix"],
        urls: &["static.parastorage.com", "wixstatic.com"],
        ..tech("Wix", Platform)
    },
    Technology {
        urls: &["squarespace.com", "static1.squarespace"],
        globals: &["Static.SQUARESPACE_CONTEXT"],
        ..tech("Squarespace", Platform)
    },
    Technology {
        generator: &["webflow"],
        urls: &["webflow.com"],
        selectors: &["html[data-wf-site]"],
        ..tech("Webflow", Platform)
    },
    Technology {
        generator: &["ghost"],
        ..tech("Ghost", Platform)
    },
    Technology {
        generator: &["hugo"],
        ..tech("Hugo", Platform)
    },
    Technology {
        generator: &["jekyll"],
        ..tech("Jekyll", Platform)
    },
    Technology {
        generator: &["mediawiki"],
        globals: &["mw.config"],
        ..tech("MediaWiki", Platform)
    },
    Technology {
        urls: &["woocommerce"],
        globals: &["wc_add_to_cart_params"],
        ..tech("WooCommerce", Platform)
    },
    Technology {
        urls: &["cdn.bigcommerce.com"],
        ..tech("BigCommerce", Platform)
    },
    Technology {
        generator: &["blogger"],
        urls: &["blogger.com"],
        ..tech("Blogger", Platform)
    },
    Technology {
        globals: &["GoogleAnalyticsObject"],
        urls: &[
            "google-analytics.com/analytics.js",
            "google-analytics.com/ga.js",
        ],
        cookies: &["_ga"],
        ..tech("Google Analytics", Analytics)
    },
    Technology {
        urls: &["googletagmanager.com/gtag/js"],
        globals: &["gtag"],
        ..tech("Google Analytics 4 / gtag", Analytics)
    },
    Technology {
        globals: &["google_tag_manager"],
        urls: &["googletagmanager.com/gtm.js"],
        ..tech("Google Tag Manager", Analytics)
    },
    Technology {
        globals: &["fbq"],
        urls: &["connect.facebook.net/en_us/fbevents"],
        ..tech("Meta Pixel", Analytics)
    },
    Technology {
        globals: &["hj", "_hjSettings"],
        urls: &["static.hotjar.com"],
        ..tech("Hotjar", Analytics)
    },
    Technology {
        globals: &["analytics.SNIPPET_VERSION"],
        urls: &["cdn.segment.com"],
        ..tech("Segment", Analytics)
    },
    Technology {
        globals: &["mixpanel"],
        urls: &["cdn.mxpnl.com", "mixpanel"],
        ..tech("Mixpanel", Analytics)
    },
    Technology {
        globals: &["plausible"],
        urls: &["plausible.io/js"],
        ..tech("Plausible", Analytics)
    },
    Technology {
        globals: &["_paq"],
        urls: &["matomo", "piwik"],
        ..tech("Matomo", Analytics)
    },
    Technology {
        urls: &["clarity.ms"],
        ..tech("Microsoft Clarity", Analytics)
    },
    Technology {
        globals: &["amplitude"],
        urls: &["amplitude.com"],
        ..tech("Amplitude", Analytics)
    },
    Technology {
        globals: &["_linkedin_data_partner_ids"],
        urls: &["snap.licdn.com"],
        ..tech("LinkedIn Insight", Analytics)
    },
    Technology {
        globals: &["twq"],
        urls: &["static.ads-twitter.com"],
        ..tech("X Ads", Analytics)
    },
    Technology {
        globals: &["ttq"],
        urls: &["analytics.tiktok.com"],
        ..tech("TikTok Pixel", Analytics)
    },
    Technology {
        globals: &["adsbygoogle"],
        urls: &["pagead2.googlesyndication.com"],
        ..tech("Google AdSense", Analytics)
    },
    Technology {
        urls: &["doubleclick.net"],
        ..tech("DoubleClick", Analytics)
    },
    Technology {
        globals: &["Stripe"],
        urls: &["js.stripe.com"],
        ..tech("Stripe", Service)
    },
    Technology {
        globals: &["paypal"],
        urls: &["paypal.com/sdk", "paypalobjects.com"],
        ..tech("PayPal", Service)
    },
    Technology {
        globals: &["grecaptcha"],
        urls: &["recaptcha"],
        ..tech("reCAPTCHA", Service)
    },
    Technology {
        globals: &["hcaptcha"],
        urls: &["hcaptcha.com"],
        ..tech("hCaptcha", Service)
    },
    Technology {
        urls: &["challenges.cloudflare.com"],
        globals: &["turnstile"],
        ..tech("Cloudflare Turnstile", Service)
    },
    Technology {
        globals: &["Sentry", "__SENTRY__"],
        urls: &["sentry.io", "sentry-cdn.com"],
        ..tech("Sentry", Service)
    },
    Technology {
        globals: &["Intercom"],
        urls: &["widget.intercom.io"],
        ..tech("Intercom", Service)
    },
    Technology {
        globals: &["$crisp"],
        urls: &["client.crisp.chat"],
        ..tech("Crisp", Service)
    },
    Technology {
        globals: &["HubSpotConversations", "_hsq"],
        urls: &["js.hs-scripts.com", "hubspot.com"],
        ..tech("HubSpot", Service)
    },
    Technology {
        urls: &["js.driftt.com"],
        ..tech("Drift", Service)
    },
    Technology {
        globals: &["zE", "zEmbed"],
        urls: &["static.zdassets.com"],
        ..tech("Zendesk", Service)
    },
    Technology {
        globals: &["Tawk_API"],
        urls: &["embed.tawk.to"],
        ..tech("Tawk.to", Service)
    },
    Technology {
        globals: &["DISQUS"],
        urls: &["disqus.com"],
        ..tech("Disqus", Service)
    },
    Technology {
        urls: &["algolia"],
        globals: &["algoliasearch"],
        ..tech("Algolia", Service)
    },
    Technology {
        urls: &["player.vimeo.com", "vimeo.com/api"],
        selectors: &["iframe[src*='vimeo.com']"],
        ..tech("Vimeo", Service)
    },
    Technology {
        selectors: &[
            "iframe[src*='youtube.com']",
            "iframe[src*='youtube-nocookie.com']",
        ],
        urls: &["youtube.com/iframe_api"],
        ..tech("YouTube embed", Service)
    },
    Technology {
        globals: &["OneTrust"],
        urls: &["cdn.cookielaw.org"],
        ..tech("OneTrust", Service)
    },
    Technology {
        urls: &["cookiebot.com"],
        globals: &["Cookiebot"],
        ..tech("Cookiebot", Service)
    },
    Technology {
        selectors: &["[class*='bootstrap']"],
        urls: &["bootstrap"],
        globals: &["bootstrap"],
        ..tech("Bootstrap", Design)
    },
    Technology {
        urls: &["tailwind"],
        ..tech("Tailwind CSS", Design)
    },
    Technology {
        urls: &["font-awesome", "fontawesome"],
        selectors: &["i[class*='fa-']"],
        ..tech("Font Awesome", Design)
    },
    Technology {
        urls: &["fonts.googleapis.com", "fonts.gstatic.com"],
        ..tech("Google Fonts", Design)
    },
    Technology {
        urls: &["use.typekit.net"],
        ..tech("Adobe Fonts", Design)
    },
    Technology {
        selectors: &["[class*='Mui']"],
        ..tech("Material UI", Design)
    },
    Technology {
        urls: &["bulma"],
        ..tech("Bulma", Design)
    },
    Technology {
        urls: &["foundation"],
        ..tech("Foundation", Design)
    },
    Technology {
        urls: &["cdnjs.cloudflare.com"],
        ..tech("cdnjs", Delivery)
    },
    Technology {
        urls: &["cdn.jsdelivr.net"],
        ..tech("jsDelivr", Delivery)
    },
    Technology {
        urls: &["unpkg.com"],
        ..tech("unpkg", Delivery)
    },
    Technology {
        urls: &["/cdn-cgi/"],
        cookies: &["__cf", "cf_clearance"],
        ..tech("Cloudflare", Delivery)
    },
    Technology {
        urls: &["cloudfront.net"],
        ..tech("Amazon CloudFront", Delivery)
    },
    Technology {
        urls: &["fastly.net", "fastly.com"],
        ..tech("Fastly", Delivery)
    },
    Technology {
        urls: &["akamai", "akamaihd.net"],
        ..tech("Akamai", Delivery)
    },
    Technology {
        urls: &["vercel.app", "/_vercel/"],
        ..tech("Vercel", Delivery)
    },
    Technology {
        urls: &["netlify"],
        ..tech("Netlify", Delivery)
    },
    Technology {
        urls: &["github.io"],
        ..tech("GitHub Pages", Delivery)
    },
    Technology {
        urls: &["imgix.net"],
        ..tech("imgix", Delivery)
    },
    Technology {
        urls: &["res.cloudinary.com"],
        ..tech("Cloudinary", Delivery)
    },
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Detected {
    pub name: &'static str,
    pub category: Category,
}

/// The script to run in the page: the table's globals and selectors go in as the probe list.
pub fn script() -> String {
    let globals: BTreeSet<&str> = TECHNOLOGIES
        .iter()
        .flat_map(|t| t.globals.iter().copied())
        .collect();
    let selectors: BTreeSet<&str> = TECHNOLOGIES
        .iter()
        .flat_map(|t| t.selectors.iter().copied())
        .collect();
    let probes = serde_json::json!({ "globals": globals, "selectors": selectors });
    SCRIPT_TEMPLATE.replace("__PROBES__", &probes.to_string())
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Evidence {
    globals: Vec<String>,
    selectors: Vec<String>,
    urls: Vec<String>,
    generator: String,
    cookies: Vec<String>,
}

/// Matches the page's evidence to the table. Unreadable evidence finds nothing.
pub fn detect(json: &str) -> Vec<Detected> {
    let Ok(mut evidence) = serde_json::from_str::<Evidence>(json) else {
        return Vec::new();
    };
    evidence.globals.truncate(MAX_ITEMS);
    evidence.selectors.truncate(MAX_ITEMS);
    evidence.urls.truncate(MAX_ITEMS);
    evidence.cookies.truncate(MAX_ITEMS);
    let urls: Vec<String> = evidence.urls.iter().map(|u| u.to_lowercase()).collect();
    let generator = evidence.generator.to_lowercase();

    let mut found: Vec<Detected> = TECHNOLOGIES
        .iter()
        .filter(|t| {
            t.globals
                .iter()
                .any(|g| evidence.globals.iter().any(|e| e == g))
                || t.selectors
                    .iter()
                    .any(|s| evidence.selectors.iter().any(|e| e == s))
                || t.urls.iter().any(|f| urls.iter().any(|u| u.contains(f)))
                || t.generator.iter().any(|f| generator.contains(f))
                || t.cookies
                    .iter()
                    .any(|p| evidence.cookies.iter().any(|c| c.starts_with(p)))
        })
        .map(|t| Detected {
            name: t.name,
            category: t.category,
        })
        .collect();
    found.sort_by(|a, b| (a.category, a.name).cmp(&(b.category, b.name)));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_names_the_technologies_it_shows() {
        let found = detect(
            r##"{"globals":["React"],"selectors":["#__next"],
                "urls":["https://x.com/_next/static/a.js","https://fonts.googleapis.com/css"],
                "generator":"WordPress 6.4","cookies":["_ga_ABC"]}"##,
        );
        let names: Vec<_> = found.iter().map(|d| d.name).collect();
        for expected in [
            "React",
            "Next.js",
            "Google Fonts",
            "WordPress",
            "Google Analytics",
        ] {
            assert!(names.contains(&expected), "{expected} in {names:?}");
        }
        assert!(!names.contains(&"Vue.js"));
    }

    #[test]
    fn results_group_by_category_then_name() {
        let found =
            detect(r#"{"globals":["jQuery","React"],"urls":["https://cdn.jsdelivr.net/a.js"]}"#);
        let order: Vec<_> = found.iter().map(|d| (d.category, d.name)).collect();
        let mut sorted = order.clone();
        sorted.sort();
        assert_eq!(order, sorted);
    }

    #[test]
    fn a_page_cannot_add_a_name_the_table_lacks() {
        let found = detect(
            r#"{"globals":["Free iPhone"],"generator":"Totally Legit","urls":["x"],"cookies":["a"]}"#,
        );
        assert!(found.is_empty());
        assert!(detect("not json").is_empty());
    }

    #[test]
    fn the_script_carries_the_probes_and_nothing_unreplaced() {
        let script = script();
        assert!(!script.contains("__PROBES__"));
        assert!(script.contains("\"__NEXT_DATA__\""));
        assert!(script.contains("\"#__next\""));
    }

    #[test]
    fn every_technology_has_a_signature_and_a_unique_name() {
        let mut names = BTreeSet::new();
        for t in TECHNOLOGIES {
            assert!(names.insert(t.name), "{} twice", t.name);
            assert!(
                !(t.globals.is_empty()
                    && t.selectors.is_empty()
                    && t.urls.is_empty()
                    && t.generator.is_empty()
                    && t.cookies.is_empty()),
                "{} has no signature",
                t.name
            );
            for f in t.urls.iter().chain(t.generator) {
                assert_eq!(
                    *f,
                    f.to_lowercase(),
                    "{} fragment {f} must be lowercase",
                    t.name
                );
            }
        }
    }
}
