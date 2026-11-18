//! The events the plugin emits to the shell. Every platform sends the same names and payloads.

pub const STATE_EVENT: &str = "siteview:state";
#[cfg(mobile)]
pub const ERROR_EVENT: &str = "siteview:error";
#[cfg(mobile)]
pub const BRIDGE_EVENT: &str = "siteview:bridge";
#[cfg(mobile)]
pub const CLOSED_EVENT: &str = "siteview:closed";
#[cfg(mobile)]
pub const MEMORY_EVENT: &str = "siteview:memory";
pub const POPUP_BLOCKED_EVENT: &str = "siteview:popup-blocked";
pub const NOTIFICATION_TAP_EVENT: &str = "siteview:notification-tap";
