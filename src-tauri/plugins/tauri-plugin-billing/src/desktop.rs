use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use tauri::{AppHandle, Runtime, plugin::PluginApi};

use crate::models::*;
use crate::{Error, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<Billing<R>> {
    Ok(Billing(PhantomData))
}

/// Purchases exist on iOS, Android and macOS; on Windows and Linux every call fails.
pub struct Billing<R: Runtime>(PhantomData<fn() -> R>);

impl<R: Runtime> Billing<R> {
    pub fn configure(&self, _request: ConfigureRequest) -> Result<()> {
        Err(Error::Unsupported)
    }

    pub fn customer_info(&self) -> Result<Snapshot> {
        Err(Error::Unsupported)
    }

    pub fn offerings(&self) -> Result<Vec<Package>> {
        Err(Error::Unsupported)
    }

    pub fn purchase(&self, _package_id: &str) -> Result<PurchaseOutcome> {
        Err(Error::Unsupported)
    }

    pub fn restore(&self) -> Result<Snapshot> {
        Err(Error::Unsupported)
    }

    pub fn is_simulator(&self) -> Result<bool> {
        Ok(false)
    }
}
