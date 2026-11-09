//! Purchases on macOS: RevenueCat over StoreKit 2, in a Swift package linked into the app
//! (`macos/Sources/Billing.swift`). The API is the one `mobile.rs` has.
//!
//! Every call blocks until the store answers, and a purchase sheet needs the main thread, so
//! none of them may run on it.

use std::{
    ffi::{CStr, CString, c_char},
    sync::OnceLock,
};

use serde::de::DeserializeOwned;
use tauri::{AppHandle, Emitter, Runtime, plugin::PluginApi};

use crate::models::*;
use crate::{Error, Result, SNAPSHOT_EVENT};

unsafe extern "C" {
    fn om_billing_request(command: *const c_char, payload: *const c_char) -> *mut c_char;
    fn om_billing_free(answer: *mut c_char);
    fn om_billing_set_listener(callback: extern "C" fn(*const c_char));
}

type Listener = Box<dyn Fn(&str) + Send + Sync>;

/// The Swift side holds one plain function pointer, so the app handle lives here.
static LISTENER: OnceLock<Listener> = OnceLock::new();

extern "C" fn on_store_event(json: *const c_char) {
    // SAFETY: Swift passes a NUL-terminated string that is valid for this call.
    let json = unsafe { CStr::from_ptr(json) }.to_string_lossy();
    if let Some(listener) = LISTENER.get() {
        listener(&json);
    }
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<Billing<R>> {
    let app = app.clone();
    let _ = LISTENER.set(Box::new(move |json| dispatch_event(&app, json)));
    // SAFETY: `on_store_event` has the signature Swift calls it with and lives forever.
    unsafe { om_billing_set_listener(on_store_event) };
    Ok(Billing(std::marker::PhantomData))
}

fn dispatch_event<R: Runtime>(app: &AppHandle<R>, json: &str) {
    let Ok(event) = serde_json::from_str::<BillingEvent>(json) else {
        return;
    };
    let _ = match event {
        BillingEvent::Snapshot(snapshot) => app.emit(SNAPSHOT_EVENT, snapshot),
    };
}

#[derive(serde::Deserialize)]
struct Answer {
    ok: Option<serde_json::Value>,
    error: Option<String>,
}

pub struct Billing<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> Billing<R> {
    fn run<T: DeserializeOwned>(&self, command: &str, payload: serde_json::Value) -> Result<T> {
        let command = CString::new(command).map_err(|_| Error::BadAnswer)?;
        let payload = CString::new(payload.to_string()).map_err(|_| Error::BadAnswer)?;
        // SAFETY: both arguments are NUL-terminated and outlive the call. The answer is a
        // malloc'd C string that is copied and then freed exactly once.
        let text = unsafe {
            let answer = om_billing_request(command.as_ptr(), payload.as_ptr());
            let text = CStr::from_ptr(answer).to_string_lossy().into_owned();
            om_billing_free(answer);
            text
        };
        let answer: Answer = serde_json::from_str(&text).map_err(|_| Error::BadAnswer)?;
        if let Some(message) = answer.error {
            return Err(Error::Store(message));
        }
        serde_json::from_value(answer.ok.ok_or(Error::BadAnswer)?).map_err(|_| Error::BadAnswer)
    }

    /// Hands the public SDK key to RevenueCat and starts the stream of entitlement changes.
    pub fn configure(&self, request: ConfigureRequest) -> Result<()> {
        let _: bool = self.run(
            "configure",
            serde_json::json!({
                "apiKey": request.api_key,
                "entitlementId": request.entitlement_id,
            }),
        )?;
        Ok(())
    }

    pub fn customer_info(&self) -> Result<Snapshot> {
        self.run("customerInfo", serde_json::json!({}))
    }

    pub fn offerings(&self) -> Result<Vec<Package>> {
        let response: OfferingsResponse = self.run("offerings", serde_json::json!({}))?;
        Ok(response.packages)
    }

    pub fn purchase(&self, package_id: &str) -> Result<PurchaseOutcome> {
        let package_id = validate_package_id(package_id)?;
        let outcome: PurchaseWire =
            self.run("purchase", serde_json::json!({ "packageId": package_id }))?;
        Ok(match outcome {
            PurchaseWire::Purchased { snapshot } => PurchaseOutcome::Purchased {
                snapshot: match snapshot {
                    Some(snapshot) => snapshot,
                    None => self.customer_info()?,
                },
            },
            PurchaseWire::Cancelled => PurchaseOutcome::Cancelled,
            PurchaseWire::Pending => PurchaseOutcome::Pending,
        })
    }

    pub fn restore(&self) -> Result<Snapshot> {
        self.run("restore", serde_json::json!({}))
    }

    /// A Mac has no simulator, so the debug "force Pro" override never applies.
    pub fn is_simulator(&self) -> Result<bool> {
        Ok(false)
    }
}
