//! Local notifications for hidden sessions, through the system's notification center. Tapping one
//! reports its session to the shell, which shows it. The center only exists for an app running
//! from its `.app` bundle; a bare development binary has none, and asking it for one aborts.

use block2::RcBlock;
use objc2::{
    AnyThread, DefinedClass, define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

use crate::{Error, Result};

/// Reports the session a tapped notification was raised for.
pub struct Taps(Box<dyn Fn(String) + Send + Sync>);

define_class!(
    // SAFETY: `NSObject` has no subclassing requirements, and the class has no `Drop`.
    #[unsafe(super = NSObject)]
    #[ivars = Taps]
    struct NotificationDelegate;

    // SAFETY: `NSObjectProtocol` has no safety requirements.
    unsafe impl NSObjectProtocol for NotificationDelegate {}

    // SAFETY: the selectors and signatures are those of `UNUserNotificationCenterDelegate`.
    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        /// A notification raised while the app is in front is still shown: the session it names
        /// is hidden, so the person has not seen it.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let session = response.notification().request().identifier().to_string();
            (self.ivars().0)(session);
            handler.call(());
        }
    }
);

impl NotificationDelegate {
    fn new(taps: Taps) -> Retained<Self> {
        let this = Self::alloc().set_ivars(taps);
        // SAFETY: `init` on a freshly allocated `NSObject` subclass.
        unsafe { msg_send![super(this), init] }
    }
}

/// True when the process runs from an `.app` bundle, the only place the center works.
pub fn available() -> bool {
    NSBundle::mainBundle()
        .bundlePath()
        .to_string()
        .ends_with(".app")
}

/// Makes taps on notifications reach `on_tap`. Does nothing outside an app bundle.
pub fn install(on_tap: impl Fn(String) + Send + Sync + 'static) {
    if !available() {
        return;
    }
    let delegate = NotificationDelegate::new(Taps(Box::new(on_tap)));
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly, and this one lives as long as the app.
    std::mem::forget(delegate);
}

/// Shows a notification named `session`, asking for permission the first time. A newer one for
/// the same session replaces the older.
pub fn notify(session: &str, title: &str, body: &str) -> Result<()> {
    if !available() {
        return Err(Error::NotBundled);
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(session),
        &content,
        None,
    );
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let add_to = center.clone();
    let authorized = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        if granted.as_bool() {
            let sent = RcBlock::new(|_error: *mut NSError| {});
            add_to.addNotificationRequest_withCompletionHandler(&request, Some(&sent));
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &authorized,
    );
    Ok(())
}
