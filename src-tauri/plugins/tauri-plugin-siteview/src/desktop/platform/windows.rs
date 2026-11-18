//! Windows: WebView2 through its COM interface, for what Tauri's webview API does not expose. The
//! calls run on the main thread and are waited for, so none may run on it.

use std::{sync::mpsc, time::Duration};

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Webview};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use windows::{
    Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    },
    Win32::System::WinRT::IUserConsentVerifierInterop,
    core::{BOOL, HSTRING},
};
use windows_future::IAsyncOperation;

use crate::{Error, Rect, Result, desktop::MAIN_WINDOW};

/// How long to wait for the main thread. It only has to answer between two events.
const MAIN_THREAD_WAIT: Duration = Duration::from_secs(3);

fn native(error: windows::core::Error) -> Error {
    Error::Native(error.to_string())
}

/// Runs `work` on the main thread with the page's `ICoreWebView2` and returns its result.
fn with_core<R, T>(
    webview: &Webview<R>,
    work: impl FnOnce(&ICoreWebView2) -> windows::core::Result<T> + Send + 'static,
) -> Result<T>
where
    R: Runtime,
    T: Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    webview.with_webview(move |platform| {
        // SAFETY: the controller is alive for the duration of this main-thread call. The error is
        // turned into text here because it is not `Send`.
        let outcome = unsafe { platform.controller().CoreWebView2() }
            .and_then(|core| work(&core))
            .map_err(|error| error.to_string());
        let _ = sender.send(outcome);
    })?;
    receiver
        .recv_timeout(MAIN_THREAD_WAIT)
        .map_err(|_| Error::PageTimeout)?
        .map_err(Error::Native)
}

/// Whether the page's history has an entry before and after the one showing.
pub fn history<R: Runtime>(webview: &Webview<R>) -> Result<(bool, bool)> {
    with_core(webview, |core| {
        let (mut back, mut forward) = (BOOL::default(), BOOL::default());
        // SAFETY: plain reads into two locals, on the main thread.
        unsafe {
            core.CanGoBack(&mut back)?;
            core.CanGoForward(&mut forward)?;
        }
        Ok((back.as_bool(), forward.as_bool()))
    })
}

pub fn go_back<R: Runtime>(webview: &Webview<R>) -> Result<()> {
    // SAFETY: a navigation request on the main thread.
    with_core(webview, |core| unsafe { core.GoBack() })
}

pub fn go_forward<R: Runtime>(webview: &Webview<R>) -> Result<()> {
    // SAFETY: as for `go_back`.
    with_core(webview, |core| unsafe { core.GoForward() })
}

/// Windows child web views are windows of their own: one created after the shell is above it, so
/// nothing needs raising.
pub fn prepare_shell<R: Runtime>(_shell: &Webview<R>) -> Result<()> {
    Ok(())
}

/// Puts the page view at `bounds` (window coordinates, logical pixels).
pub fn place<R: Runtime>(_shell: &Webview<R>, page: &Webview<R>, bounds: Rect) -> Result<()> {
    Ok(page.set_bounds(tauri::Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width, bounds.height).into(),
    })?)
}

/// Asks the PC's owner to prove they are present, with Windows Hello (face, fingerprint or PIN).
/// `Ok(false)` means they cancelled or failed; a PC with no Hello set up is an error, so the check
/// fails closed. Waits for the person, so it must not run on the main thread.
pub fn authenticate<R: Runtime>(app: &AppHandle<R>, reason: &str) -> Result<bool> {
    let availability = UserConsentVerifier::CheckAvailabilityAsync()
        .and_then(|asked| asked.join())
        .map_err(native)?;
    if availability != UserConsentVerifierAvailability::Available {
        return Err(Error::OwnerCheckUnavailable);
    }
    let window = app
        .get_window(MAIN_WINDOW)
        .ok_or(Error::MainWindowMissing)?
        .hwnd()?;
    let message = HSTRING::from(reason);
    let answer = windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
        .and_then(|interop| {
            // SAFETY: `window` is the live main window and `message` outlives the call.
            unsafe {
                interop.RequestVerificationForWindowAsync::<IAsyncOperation<
                    UserConsentVerificationResult,
                >>(window, &message)
            }
        })
        .and_then(|asked| asked.join())
        .map_err(native)?;
    Ok(answer == UserConsentVerificationResult::Verified)
}
