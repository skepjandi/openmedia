//! Downloads: a list of files being fetched, with pause and resume, naming masks and rules, batch
//! addresses, and a sniffer that lists the media on the page in front.
//!
//! Everything here runs in Rust and starts from the shell, on the user's tap: a page can only be
//! read (`sniff`), never made to start a download, and it never sees the list.

mod commands;
mod kind;
mod manager;
mod model;
mod naming;
mod pattern;
mod settings;
mod sniff;
mod transfer;

pub use commands::*;
pub use manager::Manager;

#[cfg(test)]
mod tests;
