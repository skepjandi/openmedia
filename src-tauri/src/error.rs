use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

/// Messages here reach the UI, so none of them may contain a key, a header, or a response body.
/// `ProRequired` serializes as the stable code `pro-required`, which the shell matches to open
/// the paywall; `UsageLocked` as `usage-locked`, which the shell shows as the settings lock's
/// own message.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("a favorite needs a name of 1-20 characters")]
    InvalidFavoriteName,
    #[error("a landing page must be an address on the favorite's own site")]
    InvalidLanding,
    #[error("no such site to favorite")]
    UnknownSite,
    #[error("the bottom margin can be at most {0} pixels")]
    InvalidMargin(u32),
    #[error("invalid dark mode choice: {0}")]
    InvalidDarkMode(&'static str),
    #[error("invalid usage record: {0}")]
    InvalidUsage(&'static str),
    #[error("usage-locked")]
    UsageLocked,
    #[error("invalid chat: {0}")]
    InvalidChat(&'static str),
    #[error("no such site option")]
    UnknownOption,
    #[error(transparent)]
    Billing(#[from] tauri_plugin_billing::Error),
    #[error("pro-required")]
    ProRequired,
    #[error("Purchases are not available in this build.")]
    BillingNotConfigured,
    #[error(transparent)]
    SiteView(#[from] tauri_plugin_siteview::Error),
    #[error("could not read or write the library: {0}")]
    Storage(#[from] std::io::Error),
    #[error("the library file is corrupt: {0}")]
    Corrupt(#[from] serde_json::Error),
    #[error("the library file has unsupported version {0}")]
    UnsupportedVersion(u32),
    #[error("invalid recipe: {0}")]
    Recipe(String),
    #[error("recipe library: {0}")]
    Library(String),
    #[error("{0}")]
    Share(String),
    #[error("invalid provider: {0}")]
    InvalidProvider(String),
    #[error("provider not found")]
    ProviderNotFound,
    #[error("at most {0} providers are allowed")]
    TooManyProviders(usize),
    #[error("invalid api key: {0}")]
    InvalidKey(&'static str),
    #[error("no api key is saved for this provider")]
    NoKey,
    #[error("secure storage failed: {0}")]
    Secret(String),
    #[error("{0}")]
    Connection(String),
    #[error("over-the-air update: {0}")]
    Ota(String),
    #[error("This build is updated through its store.")]
    SelfUpdateUnavailable,
    #[error("ad blocking failed: {0}")]
    AdBlock(String),
    #[error("{0}")]
    Download(String),
    #[error("library lock poisoned")]
    Poisoned,
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
