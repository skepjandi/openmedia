use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

/// Messages here reach the UI, so none of them may contain a key or a receipt.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[cfg(all(desktop, not(target_os = "macos")))]
    #[error("purchases are not supported on this desktop")]
    Unsupported,
    /// What the store layer said; its messages are fixed strings and never carry a key or receipt.
    #[cfg(target_os = "macos")]
    #[error("{0}")]
    Store(String),
    #[cfg(target_os = "macos")]
    #[error("the store sent an answer the app could not read")]
    BadAnswer,
    #[error("unknown package")]
    InvalidPackage,
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
