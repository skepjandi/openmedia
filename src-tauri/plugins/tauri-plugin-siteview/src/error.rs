use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid url: {0}")]
    InvalidUrl(String),
    #[error("only http and https urls can be opened")]
    UnsupportedScheme,
    #[error("invalid profile id")]
    InvalidProfile,
    #[error("invalid session id")]
    InvalidSession,
    #[error("the notification text is empty or longer than {0} characters")]
    InvalidNotification(usize),
    #[error("invalid content rule list")]
    InvalidRuleList,
    #[error("bridge message is larger than {0} bytes")]
    BridgeMessageTooLarge(usize),
    #[error("bridge message is not valid json")]
    BridgeMessageInvalid,
    #[error("the script is empty or larger than {0} bytes")]
    InvalidScript(usize),
    #[error("the script result is larger than {0} bytes")]
    EvaluateResultTooLarge(usize),
    #[error("the reason for the check must be 1-{0} characters without control characters")]
    InvalidAuthReason(usize),
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[cfg(desktop)]
    #[error("{0} is not available on desktop yet")]
    DesktopUnsupported(&'static str),
    #[cfg(target_os = "macos")]
    #[error("the main window is not open")]
    MainWindowMissing,
    #[cfg(target_os = "macos")]
    #[error("this Mac has no password or Touch ID to check with")]
    OwnerCheckUnavailable,
    #[cfg(target_os = "macos")]
    #[error("notifications need the app to run from its .app bundle")]
    NotBundled,
    #[cfg(target_os = "macos")]
    #[error("no such site view")]
    UnknownSession,
    #[cfg(target_os = "macos")]
    #[error("the page did not answer in time")]
    PageTimeout,
    #[cfg(target_os = "macos")]
    #[error("the site view failed: {0}")]
    Webview(#[from] tauri::Error),
    #[cfg(target_os = "macos")]
    #[error("could not start the page state poller: {0}")]
    Poller(#[from] std::io::Error),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
