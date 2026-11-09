//! Whether the user has Pro, and the commands that read, buy and restore it.
//!
//! RevenueCat is the source of truth; this module keeps the last answer in memory and tells the
//! shell when it changes. Identity is RevenueCat's anonymous app user id: there is no login, and
//! a purchase moves to another device through Restore Purchases, which is store-account based.
//!
//! The state machine ([`Machine`]) has no Tauri types so its rules are unit tested:
//! - Startup never waits for the store. The status begins `Loading` (locked) and becomes `Free`
//!   only once the store answered or the retries ran out.
//! - A failed call never changes a known status; an answer from the store always does.
//! - A restore or purchase result beats any fetch that started before it, so a stale negative
//!   cannot overwrite it.
//! - Without a key the status is `Free` and restore is an error, never a grant.
//!
//! The commands are app commands, not plugin commands: the plugin is Rust-only, so no webview
//! can start a purchase itself.

use std::{
    sync::{
        Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tauri_plugin_billing::{
    BillingExt, ConfigureRequest, Package, PurchaseOutcome, SNAPSHOT_EVENT, Snapshot,
};

use crate::error::{Error, Result};
use crate::incognito;

pub const ENTITLEMENT_ID: &str = "pro";
pub const CHANGED_EVENT: &str = "entitlement:changed";

const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(7),
];

#[cfg(target_os = "ios")]
const SDK_KEY: Option<&str> = option_env!("OPENMEDIA_RC_KEY_IOS");
/// The Mac app is the same App Store app as the iPhone one, so it shares the `appl_` key unless
/// `OPENMEDIA_RC_KEY_MACOS` gives it its own (`build.rs` resolves which).
#[cfg(target_os = "macos")]
const SDK_KEY: Option<&str> = option_env!("OPENMEDIA_RC_KEY_MACOS");
#[cfg(target_os = "android")]
const SDK_KEY: Option<&str> = option_env!("OPENMEDIA_RC_KEY_ANDROID");
#[cfg(not(any(target_os = "ios", target_os = "android", target_os = "macos")))]
const SDK_KEY: Option<&str> = None;

#[cfg(any(target_os = "ios", target_os = "android", target_os = "macos"))]
const DEV_OVERRIDE: Option<&str> = option_env!("OPENMEDIA_DEV_ENTITLEMENT");

#[cfg(any(target_os = "ios", target_os = "android"))]
const SIMULATOR_PRO_OVERRIDE: Option<&str> =
    option_env!("EXPO_PUBLIC_FORCE_ENABLE_PRO_ON_SIMULATOR");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Loading,
    Free,
    Pro,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementView {
    pub status: Status,
    pub configured: bool,
    pub snapshot: Option<Snapshot>,
}

/// What a state change did, so the caller knows whom to tell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Transition {
    changed: bool,
    pro_lost: bool,
}

/// A missing, empty or placeholder key means purchases are not configured.
fn usable_key(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim)
        .filter(|key| !key.is_empty() && !key.contains("<PLACEHOLDER>"))
}

/// `pro` or `free` forces the status, in debug builds only. A release build ignores it.
#[cfg(any(test, target_os = "ios", target_os = "android", target_os = "macos"))]
fn dev_override(raw: Option<&str>, debug_build: bool) -> Option<Status> {
    if !debug_build {
        return None;
    }
    match raw?.trim() {
        "pro" => Some(Status::Pro),
        "free" => Some(Status::Free),
        _ => None,
    }
}

/// This override is opt-in, debug-only, and later accepted only when native code confirms a
/// simulator/emulator.
#[cfg(any(test, target_os = "ios", target_os = "android"))]
fn simulator_pro_override_requested(raw: Option<&str>, debug_build: bool) -> bool {
    debug_build && raw.is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
}

struct Machine {
    status: Status,
    configured: bool,
    snapshot: Option<Snapshot>,
    epoch: u64,
    forced: Option<Status>,
}

impl Machine {
    fn new(configured: bool, forced: Option<Status>) -> Self {
        Self {
            status: if configured {
                Status::Loading
            } else {
                Status::Free
            },
            configured,
            snapshot: None,
            epoch: 0,
            forced,
        }
    }

    fn status(&self) -> Status {
        self.forced.unwrap_or(self.status)
    }

    fn view(&self) -> EntitlementView {
        EntitlementView {
            status: self.status(),
            configured: self.configured,
            snapshot: self.snapshot.clone(),
        }
    }

    fn require_configured(&self) -> Result<()> {
        if self.configured {
            Ok(())
        } else {
            Err(Error::BillingNotConfigured)
        }
    }

    fn begin_fetch(&self) -> u64 {
        self.epoch
    }

    /// A fetched answer. A negative one that started before a restore, purchase or store update
    /// is stale and dropped; a positive one is always true.
    fn apply_fetched(&mut self, started_at: u64, snapshot: Snapshot) -> Transition {
        if !snapshot.active && started_at != self.epoch {
            return Transition::default();
        }
        self.apply(snapshot)
    }

    /// A restore, purchase or store update: newer than any fetch in flight.
    fn apply_authoritative(&mut self, snapshot: Snapshot) -> Transition {
        self.epoch += 1;
        self.apply(snapshot)
    }

    /// The store never answered. Only a status still loading falls to Free; a known one stays.
    fn give_up(&mut self) -> Transition {
        self.transition(|machine| {
            if machine.status == Status::Loading {
                machine.status = Status::Free;
            }
        })
    }

    fn apply(&mut self, snapshot: Snapshot) -> Transition {
        self.transition(|machine| {
            machine.status = if snapshot.active {
                Status::Pro
            } else {
                Status::Free
            };
            machine.snapshot = Some(snapshot);
        })
    }

    fn transition(&mut self, change: impl FnOnce(&mut Self)) -> Transition {
        let before = self.view();
        change(self);
        let after = self.view();
        Transition {
            changed: before != after,
            pro_lost: before.status == Status::Pro && after.status != Status::Pro,
        }
    }
}

pub struct Entitlement {
    machine: Mutex<Machine>,
    api_key: Option<String>,
    simulator_override_requested: bool,
    simulator_override: AtomicBool,
    /// Held while configuring so two callers never configure the store twice.
    native_ready: Mutex<bool>,
}

impl Entitlement {
    /// Pro is decided by the store on iOS, Android and macOS. Windows and Linux have no store,
    /// so they are forced to Pro.
    pub fn from_build() -> Self {
        #[cfg(any(target_os = "ios", target_os = "android", target_os = "macos"))]
        let forced = dev_override(DEV_OVERRIDE, cfg!(debug_assertions));
        #[cfg(not(any(target_os = "ios", target_os = "android", target_os = "macos")))]
        let forced = Some(Status::Pro);
        #[cfg(any(target_os = "ios", target_os = "android"))]
        let mut entitlement = Self::new(SDK_KEY, forced);
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        let entitlement = Self::new(SDK_KEY, forced);
        #[cfg(any(target_os = "ios", target_os = "android"))]
        {
            entitlement.simulator_override_requested =
                simulator_pro_override_requested(SIMULATOR_PRO_OVERRIDE, cfg!(debug_assertions));
        }
        entitlement
    }

    fn new(raw_key: Option<&str>, forced: Option<Status>) -> Self {
        let api_key = usable_key(raw_key).map(str::to_owned);
        Self {
            machine: Mutex::new(Machine::new(api_key.is_some(), forced)),
            api_key,
            simulator_override_requested: false,
            simulator_override: AtomicBool::new(false),
            native_ready: Mutex::new(false),
        }
    }

    pub fn view(&self) -> EntitlementView {
        let mut view = self.machine().view();
        if self.simulator_override.load(Ordering::Acquire) {
            view.status = Status::Pro;
        }
        view
    }

    pub fn require_pro(&self) -> Result<()> {
        if self.simulator_override.load(Ordering::Acquire) {
            return Ok(());
        }
        match self.machine().status() {
            Status::Pro => Ok(()),
            Status::Loading | Status::Free => Err(Error::ProRequired),
        }
    }

    fn enable_simulator_override(&self) {
        self.simulator_override.store(true, Ordering::Release);
    }

    fn machine(&self) -> MutexGuard<'_, Machine> {
        self.machine.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn update(&self, change: impl FnOnce(&mut Machine) -> Transition) -> Transition {
        change(&mut self.machine())
    }
}

fn with_retry<T, E>(
    delays: &[Duration],
    mut sleep: impl FnMut(Duration),
    mut attempt: impl FnMut() -> std::result::Result<T, E>,
) -> std::result::Result<T, E> {
    let mut result = attempt();
    for delay in delays {
        if result.is_ok() {
            break;
        }
        sleep(*delay);
        result = attempt();
    }
    result
}

fn publish(app: &AppHandle, transition: Transition) {
    if transition.changed {
        let _ = app.emit(CHANGED_EVENT, app.state::<Entitlement>().view());
    }
    if transition.pro_lost {
        // Switching incognito off calls into native code, which must not run on the thread
        // that delivered a store event.
        let handle = AppHandle::clone(app);
        tauri::async_runtime::spawn_blocking(move || incognito::leave_incognito(&handle));
    }
}

fn ensure_configured(app: &AppHandle, entitlement: &Entitlement) -> Result<()> {
    let key = entitlement
        .api_key
        .as_deref()
        .ok_or(Error::BillingNotConfigured)?;
    let mut ready = entitlement
        .native_ready
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if !*ready {
        app.billing().configure(ConfigureRequest {
            api_key: key.to_owned(),
            entitlement_id: ENTITLEMENT_ID.to_owned(),
        })?;
        *ready = true;
    }
    Ok(())
}

fn fetch_customer_info(app: &AppHandle, entitlement: &Entitlement) -> Result<()> {
    ensure_configured(app, entitlement)?;
    let started_at = entitlement.machine().begin_fetch();
    let snapshot = app.billing().customer_info()?;
    let transition = entitlement.update(|machine| machine.apply_fetched(started_at, snapshot));
    publish(app, transition);
    Ok(())
}

/// Resolves the entitlement in the background; the shell renders locked meanwhile.
pub fn start(app: &AppHandle) {
    let handle = AppHandle::clone(app);
    handle.listen(SNAPSHOT_EVENT, {
        let handle = handle.clone();
        move |event| {
            if let Ok(snapshot) = serde_json::from_str::<Snapshot>(event.payload()) {
                let entitlement = handle.state::<Entitlement>();
                let transition =
                    entitlement.update(|machine| machine.apply_authoritative(snapshot));
                publish(&handle, transition);
            }
        }
    });
    if handle.state::<Entitlement>().simulator_override_requested {
        let simulator_handle = handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let entitlement = simulator_handle.state::<Entitlement>();
            if simulator_handle.billing().is_simulator().unwrap_or(false) {
                entitlement.enable_simulator_override();
                let _ = simulator_handle.emit(CHANGED_EVENT, entitlement.view());
            }
        });
    }
    if handle.state::<Entitlement>().api_key.is_none() {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let entitlement = handle.state::<Entitlement>();
        let answered = with_retry(&RETRY_DELAYS, thread::sleep, || {
            fetch_customer_info(&handle, &entitlement)
        });
        if answered.is_err() {
            let transition = entitlement.update(Machine::give_up);
            publish(&handle, transition);
        }
    });
}

#[tauri::command]
pub async fn get_entitlement(entitlement: State<'_, Entitlement>) -> Result<EntitlementView> {
    Ok(entitlement.view())
}

/// Asks the store again, for when the app comes back to the foreground. A failure keeps the
/// previous state.
#[tauri::command]
pub async fn refresh_entitlement(
    app: AppHandle,
    entitlement: State<'_, Entitlement>,
) -> Result<EntitlementView> {
    if entitlement.api_key.is_some() && fetch_customer_info(&app, &entitlement).is_err() {
        let transition = entitlement.update(Machine::give_up);
        publish(&app, transition);
    }
    Ok(entitlement.view())
}

/// Async because the plugin waits for native code that needs the main thread: a synchronous
/// command would deadlock the app.
#[tauri::command]
pub async fn get_offerings(
    app: AppHandle,
    entitlement: State<'_, Entitlement>,
) -> Result<Vec<Package>> {
    ensure_configured(&app, &entitlement)?;
    Ok(app.billing().offerings()?)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PurchaseKind {
    Purchased,
    Cancelled,
    Pending,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseResultView {
    pub outcome: PurchaseKind,
    pub view: EntitlementView,
}

#[tauri::command]
pub async fn purchase_package(
    app: AppHandle,
    entitlement: State<'_, Entitlement>,
    package_id: String,
) -> Result<PurchaseResultView> {
    ensure_configured(&app, &entitlement)?;
    let outcome = match app.billing().purchase(&package_id)? {
        PurchaseOutcome::Purchased { snapshot } => {
            let transition = entitlement.update(|machine| machine.apply_authoritative(snapshot));
            publish(&app, transition);
            PurchaseKind::Purchased
        }
        PurchaseOutcome::Cancelled => PurchaseKind::Cancelled,
        PurchaseOutcome::Pending => PurchaseKind::Pending,
    };
    Ok(PurchaseResultView {
        outcome,
        view: entitlement.view(),
    })
}

/// Only ever runs from the user's tap, never on launch. Without a key it is an error, never a
/// grant.
#[tauri::command]
pub async fn restore_purchases(
    app: AppHandle,
    entitlement: State<'_, Entitlement>,
) -> Result<EntitlementView> {
    entitlement.machine().require_configured()?;
    ensure_configured(&app, &entitlement)?;
    let snapshot = app.billing().restore()?;
    let transition = entitlement.update(|machine| machine.apply_authoritative(snapshot));
    publish(&app, transition);
    Ok(entitlement.view())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    fn snapshot(active: bool) -> Snapshot {
        Snapshot {
            active,
            product_id: active.then(|| "openmedia.annual".to_owned()),
            in_trial: false,
            expires_at_ms: None,
            will_renew: active,
        }
    }

    fn configured() -> Machine {
        Machine::new(true, None)
    }

    #[test]
    fn a_configured_machine_starts_loading_and_locked() {
        let entitlement = Entitlement::new(Some("appl_abc"), None);
        assert_eq!(entitlement.view().status, Status::Loading);
        assert!(entitlement.view().configured);
        assert!(matches!(entitlement.require_pro(), Err(Error::ProRequired)));
    }

    #[test]
    fn loading_becomes_free_only_after_an_answer_or_giving_up() {
        let mut machine = configured();
        assert_eq!(machine.status(), Status::Loading);
        machine.apply_fetched(machine.begin_fetch(), snapshot(false));
        assert_eq!(machine.status(), Status::Free);

        let mut machine = configured();
        assert_eq!(machine.status(), Status::Loading);
        let transition = machine.give_up();
        assert_eq!(machine.status(), Status::Free);
        assert!(transition.changed);
    }

    #[test]
    fn an_answer_with_the_entitlement_makes_pro() {
        let mut machine = configured();
        let transition = machine.apply_fetched(machine.begin_fetch(), snapshot(true));
        assert_eq!(machine.status(), Status::Pro);
        assert!(transition.changed && !transition.pro_lost);
        assert_eq!(machine.view().snapshot, Some(snapshot(true)));
    }

    #[test]
    fn giving_up_never_downgrades_a_known_pro() {
        let mut machine = configured();
        machine.apply_authoritative(snapshot(true));
        let transition = machine.give_up();
        assert_eq!(machine.status(), Status::Pro);
        assert_eq!(transition, Transition::default());
    }

    #[test]
    fn a_store_answer_that_ends_pro_reports_the_loss() {
        let mut machine = configured();
        machine.apply_authoritative(snapshot(true));
        let transition = machine.apply_authoritative(snapshot(false));
        assert_eq!(machine.status(), Status::Free);
        assert!(transition.pro_lost);
    }

    #[test]
    fn a_restore_beats_a_negative_fetch_that_started_before_it() {
        let mut machine = configured();
        let started_at = machine.begin_fetch();
        machine.apply_authoritative(snapshot(true));
        let transition = machine.apply_fetched(started_at, snapshot(false));
        assert_eq!(machine.status(), Status::Pro);
        assert_eq!(transition, Transition::default());
    }

    #[test]
    fn a_positive_fetch_is_applied_even_when_it_started_earlier() {
        let mut machine = configured();
        let started_at = machine.begin_fetch();
        machine.apply_authoritative(snapshot(false));
        machine.apply_fetched(started_at, snapshot(true));
        assert_eq!(machine.status(), Status::Pro);
    }

    #[test]
    fn restore_is_an_error_and_never_a_grant_without_a_key() {
        for raw in [None, Some(""), Some("  "), Some("appl_<PLACEHOLDER>")] {
            let entitlement = Entitlement::new(raw, None);
            assert_eq!(entitlement.view().status, Status::Free);
            assert!(!entitlement.view().configured);
            assert!(matches!(
                entitlement.machine().require_configured(),
                Err(Error::BillingNotConfigured)
            ));
            assert!(entitlement.api_key.is_none());
        }
    }

    #[test]
    fn a_real_key_is_usable() {
        assert_eq!(usable_key(Some(" appl_abc123 ")), Some("appl_abc123"));
        assert_eq!(usable_key(Some("goog_<PLACEHOLDER>")), None);
        assert_eq!(usable_key(None), None);
    }

    #[test]
    fn retry_stops_at_the_first_success() {
        let attempts = Cell::new(0);
        let sleeps = Cell::new(0);
        let result = with_retry(
            &RETRY_DELAYS,
            |_| sleeps.set(sleeps.get() + 1),
            || {
                attempts.set(attempts.get() + 1);
                if attempts.get() < 2 { Err(()) } else { Ok(7) }
            },
        );
        assert_eq!(result, Ok(7));
        assert_eq!((attempts.get(), sleeps.get()), (2, 1));
    }

    #[test]
    fn retry_is_bounded_and_backs_off_one_three_seven_seconds() {
        let attempts = Cell::new(0);
        let mut waited = Vec::new();
        let result: std::result::Result<(), ()> = with_retry(
            &RETRY_DELAYS,
            |delay| waited.push(delay),
            || {
                attempts.set(attempts.get() + 1);
                Err(())
            },
        );
        assert_eq!(result, Err(()));
        assert_eq!(attempts.get(), 4);
        assert_eq!(
            waited,
            [
                Duration::from_secs(1),
                Duration::from_secs(3),
                Duration::from_secs(7)
            ]
        );
    }

    #[test]
    fn the_dev_override_only_works_in_debug_builds() {
        assert_eq!(dev_override(Some("pro"), true), Some(Status::Pro));
        assert_eq!(dev_override(Some("free"), true), Some(Status::Free));
        assert_eq!(dev_override(Some("pro"), false), None);
        assert_eq!(dev_override(Some("free"), false), None);
        assert_eq!(dev_override(Some("other"), true), None);
        assert_eq!(dev_override(None, true), None);
    }

    #[test]
    fn simulator_override_requires_explicit_debug_opt_in() {
        assert!(simulator_pro_override_requested(Some(" true "), true));
        assert!(simulator_pro_override_requested(Some("TRUE"), true));
        assert!(!simulator_pro_override_requested(Some("true"), false));
        assert!(!simulator_pro_override_requested(Some("1"), true));
        assert!(!simulator_pro_override_requested(None, true));
    }

    #[test]
    fn simulator_override_grants_only_the_runtime_entitlement_view() {
        let entitlement = Entitlement::new(None, None);
        assert_eq!(entitlement.view().status, Status::Free);
        assert!(!entitlement.view().configured);
        assert!(matches!(entitlement.require_pro(), Err(Error::ProRequired)));

        entitlement.enable_simulator_override();

        assert_eq!(entitlement.view().status, Status::Pro);
        assert!(!entitlement.view().configured);
        assert!(entitlement.require_pro().is_ok());
    }

    #[test]
    fn a_forced_status_wins_over_the_store() {
        let entitlement = Entitlement::new(Some("appl_abc"), Some(Status::Pro));
        assert!(entitlement.require_pro().is_ok());
        entitlement.update(|machine| machine.apply_authoritative(snapshot(false)));
        assert_eq!(entitlement.view().status, Status::Pro);
    }

    #[test]
    fn require_pro_passes_only_for_pro() {
        let entitlement = Entitlement::new(Some("appl_abc"), None);
        assert!(matches!(entitlement.require_pro(), Err(Error::ProRequired)));
        entitlement.update(|machine| machine.apply_authoritative(snapshot(false)));
        assert_eq!(entitlement.view().status, Status::Free);
        assert!(matches!(entitlement.require_pro(), Err(Error::ProRequired)));
        entitlement.update(|machine| machine.apply_authoritative(snapshot(true)));
        assert!(entitlement.require_pro().is_ok());
    }

    #[test]
    fn pro_required_serializes_as_the_stable_code() {
        assert_eq!(
            serde_json::to_string(&Error::ProRequired).unwrap(),
            "\"pro-required\""
        );
    }
}
