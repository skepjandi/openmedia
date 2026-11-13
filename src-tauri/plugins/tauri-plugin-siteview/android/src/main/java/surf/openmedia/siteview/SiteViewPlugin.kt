package surf.openmedia.siteview

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import android.os.Build
import android.os.Message
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.fragment.app.FragmentActivity
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.ProfileStore
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebSettingsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors

internal fun activeAdBlockScriptlet(
    scriptlet: String?,
    enabled: Boolean,
    documentStartSupported: Boolean,
): String? = scriptlet?.takeIf { enabled && documentStartSupported && it.isNotBlank() }

/**
 * Hosts native WebViews *below* the Tauri shell webview, one per session, only one visible.
 *
 * The shell is transparent and draws the app's own controls; the shell owns layout and reports the
 * site rectangle. Site views never receive Tauri IPC, only the write-only `openmedia` bridge.
 *
 * User-initiated links and history navigation stay in this WebView and repin the session after
 * navigation; automatic cross-domain navigations open in the system's browser. Which sessions to
 * keep alive is the shell's decision; this class only opens, shows and closes.
 *
 * This is the Android twin of `ios/Sources/SiteViewPlugin.swift`.
 */
@TauriPlugin(
    permissions = [
        Permission(strings = ["android.permission.POST_NOTIFICATIONS"], alias = "notifications"),
    ],
)
class SiteViewPlugin(private val activity: Activity) : Plugin(activity), ComponentCallbacks2 {
    private class Session(
        val id: String,
        val view: WebView,
        /** Holds the page view and gives it pull-to-refresh; this is what the page layer lays out. */
        val frame: SwipeRefreshLayout,
        val initialUrl: String,
        /** The profile the page lives in; a sign-in window shares it, so the cookies are the same. */
        val profile: String,
        @Volatile var topUrl: String = initialUrl,
        var scope: String,
        var settled: Boolean = false,
        // Redirect allowance must not weaken the cross-domain POST guard while unsettled.
        @Volatile var userNavigationPending: Boolean = false,
        var painted: Boolean = false,
        /**
         * True while the touch in progress began inside a page container that is scrolled away from
         * its top, as in a feed of full-screen videos. The page itself is then still at its top, so
         * without this a swipe down to the previous item would pull to refresh.
         */
        @Volatile var innerScrolled: Boolean = false,
        var loading: Boolean = false,
        var needsReload: Boolean = false,
        var blocked: Boolean = false,
        /** True while the page's media is paused because the page went out of sight. */
        var mediaPaused: Boolean = false,
        var shield: View? = null,
        var recipe: String? = null,
        var adBlockScriptlet: String? = null,
        var adBlockEnabled: Boolean = false,
        var scriptHandler: ScriptHandler? = null,
        var adBlockScriptHandler: ScriptHandler? = null,
        var paintHandler: ScriptHandler? = null,
    )

    /** The layer under the shell that holds the page views and the backdrop behind them. */
    private class PageLayer(context: Context) : ViewGroup(context) {
        var pageRect = RectF()
        private var backdrop: View? = null

        fun setBackdrop(view: View) {
            backdrop = view
            addView(
                view,
                0,
                LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
            )
        }

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            setMeasuredDimension(
                MeasureSpec.getSize(widthMeasureSpec),
                MeasureSpec.getSize(heightMeasureSpec),
            )
        }

        override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
            backdrop?.layout(0, 0, r - l, b - t)
            val width = (pageRect.width()).toInt().coerceAtLeast(0)
            val height = (pageRect.height()).toInt().coerceAtLeast(0)
            val widthSpec = MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY)
            val heightSpec = MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)
            for (i in 0 until childCount) {
                val child = getChildAt(i)
                if (child === backdrop || child.visibility == View.GONE) continue
                child.measure(widthSpec, heightSpec)
                child.layout(
                    pageRect.left.toInt(),
                    pageRect.top.toInt(),
                    pageRect.right.toInt(),
                    pageRect.bottom.toInt(),
                )
            }
        }
    }

    private var shell: WebView? = null
    private var pageLayer: PageLayer? = null
    private var backdrop: View? = null
    // Read from the WebView's request thread (`sessionOf`), written on the UI thread.
    private val sessions: MutableMap<String, Session> =
        java.util.Collections.synchronizedMap(LinkedHashMap())
    @Volatile private var loadedRulePaths: List<String>? = null
    private var activeId: String? = null

    /** The sites (registrable domains) whose media keeps playing while hidden or in the background. */
    private var backgroundMediaSites: Set<String> = emptySet()

    /** False from the activity's pause to its resume. */
    private var appForeground = true
    private var events: Channel? = null
    private var interactiveRegions = emptyList<RectF>()
    private var colorScheme = "system"
    private val blockedSessions = ArrayList<String>()
    private val rules = BlockingRules()
    private var touchTarget: View? = null
    /** The window a page opened with `window.open`: a sign-in window. It sits above the page. */
    private var signInWindow: WebView? = null
    /** The session whose page opened the sign-in window. */
    private var signInOwner: String? = null
    /** The session whose page is loading the address the sign-in window handed back. */
    private var handoffSession: String? = null
    private val worker = Executors.newSingleThreadExecutor()
    private var safeArea: Pair<Int, Int>? = null
    private var safeAreaScript: ScriptHandler? = null

    override fun load(webView: WebView) {
        shell = webView
        // The shell is app chrome over the page: it must not paint a background of its own.
        webView.setBackgroundColor(Color.TRANSPARENT)
        // A transparent WebView over other views leaves stale tiles (gray boxes, ghost copies of the
        // floating button) when its content animates; a hardware layer repaints it whole.
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        // A view only consults its touch listener when it is clickable.
        webView.isClickable = true
        webView.setOnTouchListener { _, event -> routeTouch(event) }
        trackSafeArea(webView)

        val host = webView.parent as? ViewGroup
        if (host != null) {
            val layer = PageLayer(activity)
            val shade = View(activity)
            shade.setBackgroundColor(backdropColor())
            layer.setBackdrop(shade)
            backdrop = shade
            pageLayer = layer
            host.addView(
                layer,
                0,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        }

        activity.registerComponentCallbacks(this)
        reportNotificationTap(activity.intent)
    }

    /**
     * Android's WebView reports no safe area for the system bars, so the shell's `--safe-top` and
     * `--safe-bottom` would stay 0 and content would sit under the status and navigation bars.
     * The insets are pushed into the shell as CSS pixels, now and on every document loaded later.
     */
    private fun trackSafeArea(webView: WebView) {
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            publishSafeArea(webView, insets)
            ViewCompat.onApplyWindowInsets(view, insets)
        }
        ViewCompat.requestApplyInsets(webView)
    }

    private fun publishSafeArea(webView: WebView, insets: WindowInsetsCompat) {
        val bars = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        val next = bars.top to bars.bottom
        if (next == safeArea) return
        safeArea = next
        val density = activity.resources.displayMetrics.density
        val script = "(function(){var s=document.documentElement.style;" +
            "s.setProperty('--safe-top','${bars.top / density}px');" +
            "s.setProperty('--safe-bottom','${bars.bottom / density}px');" +
            "window.dispatchEvent(new Event('resize'));})();"
        safeAreaScript?.remove()
        safeAreaScript = null
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            safeAreaScript = WebViewCompat.addDocumentStartJavaScript(webView, script, setOf("*"))
        }
        webView.evaluateJavascript(script, null)
    }

    // MARK: Commands

    /**
     * Creates the session's view, shows it, and keeps every other session alive but hidden. The
     * view starts loading at once, even before the shell has reported its rectangle.
     */
    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            invoke.reject(OUTDATED_WEBVIEW)
            return
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            invoke.reject(OUTDATED_WEBVIEW)
            return
        }
        val url = webUrl(args.url)
        if (url == null) {
            invoke.reject("only http and https urls can be opened")
            return
        }

        val existing = sessions[args.session]
        if (existing != null) dispose(existing)
        args.rect?.let { setPageRect(rectOf(it)) }

        val view = WebView(activity)
        try {
            ProfileStore.getInstance().getOrCreateProfile(args.profile)
            WebViewCompat.setProfile(view, args.profile)
        } catch (error: Exception) {
            invoke.reject("the site profile could not be opened: ${error.message}")
            view.destroy()
            return
        }
        configure(view)
        val frame = SwipeRefreshLayout(activity)
        frame.setColorSchemeColors(REFRESH_COLOR)
        frame.setOnRefreshListener { view.reload() }

        val session = Session(
            id = args.session,
            view = view,
            frame = frame,
            initialUrl = url.toString(),
            profile = args.profile,
            scope = DomainScope.registrableDomain(url.host),
            recipe = args.documentStartScript,
            adBlockScriptlet = args.adBlockScriptlet,
            adBlockEnabled = args.adBlockEnabled,
        )
        frame.setOnChildScrollUpCallback { _, child ->
            session.innerScrolled || (child?.canScrollVertically(-1) ?: false)
        }
        sessions[session.id] = session
        activeId = session.id
        // The rule lists arrive with every open; without this nothing is blocked until the user
        // flips the setting.
        args.contentRuleLists?.let { lists -> applyRuleLists(lists.map { it.path }) }
        events = args.onEvent ?: events

        applyScheme(session)
        installBridge(session)
        installScripts(session, args.documentStartScript)
        frame.addView(
            view,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        pageLayer?.addView(frame)
        view.alpha = 0f
        show(session)

        if (isBlocked(args.session)) {
            // The site is closed for the day: the page never loads and the shield goes up.
            applyBlocked(true, session)
        } else {
            view.loadUrl(url.toString())
        }
        invoke.resolve()
    }

    @Command
    fun activate(invoke: Invoke) {
        val args = invoke.parseArgs(SessionArgs::class.java)
        val session = sessions[args.session]
        if (session == null) {
            invoke.reject("no such session")
            return
        }
        show(session)
        invoke.resolve()
    }

    @Command
    fun close(invoke: Invoke) {
        val args = invoke.parseArgs(SessionArgs::class.java)
        sessions[args.session]?.let { dispose(it) }
        invoke.resolve()
    }

    @Command
    fun setRect(invoke: Invoke) {
        val args = invoke.parseArgs(SetRectArgs::class.java)
        setPageRect(rectOf(args.rect))
        invoke.resolve()
    }

    @Command
    fun setInteractiveRegions(invoke: Invoke) {
        val args = invoke.parseArgs(SetInteractiveRegionsArgs::class.java)
        interactiveRegions = args.regions.map { rectOf(it) }
        shell?.let { excludeEdgeGestures(it) }
        invoke.resolve()
    }

    /**
     * The system back gesture starts at a screen edge, where the floating button rests. Regions
     * touching an edge are kept out of it, so dragging the button inward is not taken for "back".
     * The system honours about 200 dp per edge, so large regions (a full-screen sheet) stay out.
     */
    private fun excludeEdgeGestures(shellView: View) {
        val density = activity.resources.displayMetrics.density
        val zone = EDGE_GESTURE_ZONE_DP * density
        val maxHeight = MAX_EXCLUSION_DP * density
        val width = shellView.width
        val rects = interactiveRegions
            .filter { it.height() <= maxHeight && (it.left < zone || it.right > width - zone) }
            .map { Rect(it.left.toInt(), it.top.toInt(), it.right.toInt(), it.bottom.toInt()) }
        ViewCompat.setSystemGestureExclusionRects(shellView, rects)
    }

    @Command
    fun navigate(invoke: Invoke) {
        val args = invoke.parseArgs(NavigateArgs::class.java)
        val url = webUrl(args.url)
        if (url == null) {
            invoke.reject("only http and https urls can be opened")
            return
        }
        onActiveSession(invoke) { it.view.loadUrl(url.toString()) }
    }

    @Command
    fun goBack(invoke: Invoke) {
        onActiveSession(invoke) {
            // Back leaves the sign-in window first: the page under it keeps its place.
            if (signInWindow != null) {
                closeSignInWindow()
                return@onActiveSession
            }
            if (it.view.canGoBack()) {
                prepareHistoryNavigation(it, -1)
                it.view.goBack()
            }
        }
    }

    @Command
    fun goForward(invoke: Invoke) {
        onActiveSession(invoke) {
            if (it.view.canGoForward()) {
                prepareHistoryNavigation(it, 1)
                it.view.goForward()
            }
        }
    }

    private fun prepareHistoryNavigation(session: Session, offset: Int) {
        val history = session.view.copyBackForwardList()
        val targetIndex = history.currentIndex + offset
        if (targetIndex < 0 || targetIndex >= history.size) return
        val url = history.getItemAtIndex(targetIndex)?.url ?: return
        val host = Uri.parse(url).host ?: return
        if (DomainScope.contains(session.scope, host)) return
        session.userNavigationPending = true
        session.settled = false
    }

    @Command
    fun reload(invoke: Invoke) {
        onActiveSession(invoke) { it.view.reload() }
    }

    /**
     * Posts a local notification for a hidden session. The system permission prompt appears the
     * first time one is due; if it is refused, notifications are silently skipped.
     */
    @Command
    fun notify(invoke: Invoke) {
        val args = invoke.parseArgs(NotifyArgs::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(activity, POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissionForAlias("notifications", invoke, "notificationPermission")
            return
        }
        postNotification(args.session, args.title, args.body)
        invoke.resolve()
    }

    @PermissionCallback
    fun notificationPermission(invoke: Invoke) {
        val args = invoke.parseArgs(NotifyArgs::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(activity, POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            invoke.resolve()
            return
        }
        postNotification(args.session, args.title, args.body)
        invoke.resolve()
    }

    @Command
    fun setColorScheme(invoke: Invoke) {
        val args = invoke.parseArgs(SetColorSchemeArgs::class.java)
        colorScheme = args.scheme
        applyColorScheme()
        invoke.resolve()
    }

    /** Fetches a small PNG for the site's icon, as a `data:` URL, from the site itself. */
    @Command
    fun fetchFavicon(invoke: Invoke) {
        val args = invoke.parseArgs(FetchFaviconArgs::class.java)
        val url = webUrl(args.url)
        if (url == null) {
            invoke.reject("only http and https urls can be opened")
            return
        }
        worker.execute {
            val icon = FaviconFetcher.fetch(url)
            activity.runOnUiThread {
                val payload = JSObject()
                payload.put("dataUrl", icon ?: JSONObject.NULL)
                invoke.resolve(payload)
            }
        }
    }

    /**
     * Swaps the rule lists on every open session. The visible page reloads under them now; hidden
     * ones reload when they are next shown.
     */
    private fun applyRuleLists(paths: List<String>) {
        if (paths == loadedRulePaths) return
        loadedRulePaths = paths
        worker.execute { if (paths.isEmpty()) rules.clear() else rules.load(paths) }
    }

    @Command
    fun setContentRuleLists(invoke: Invoke) {
        val args = invoke.parseArgs(SetContentRuleListsArgs::class.java)
        val paths = args.lists.map { it.path }
        loadedRulePaths = paths
        worker.execute {
            if (paths.isEmpty()) rules.clear() else rules.load(paths)
            activity.runOnUiThread {
                for (session in sessions.values) {
                    session.adBlockEnabled = args.enabled
                    installScripts(session, session.recipe)
                    reloadUnder(session)
                }
                invoke.resolve()
            }
        }
    }

    /**
     * Swaps the document-start script on every live session, for the pages each loads next, and
     * runs it on the page each shows now, so a switch changed in Settings shows at once and the
     * page keeps its place. Frames inside the page pick the new script up when they next load.
     */
    @Command
    fun setDocumentStartScript(invoke: Invoke) {
        val args = invoke.parseArgs(SetDocumentStartScriptArgs::class.java)
        val live = "document.querySelectorAll('style[data-openmedia]').forEach(function(s){s.remove()});" +
            (args.script ?: "")
        for (session in sessions.values) {
            installScripts(session, args.script)
            session.view.evaluateJavascript(live, null)
        }
        invoke.resolve()
    }

    /**
     * Closes one site for the day, or opens it again. Rust-only: the plugin registers no command
     * for it, so neither the shell nor a site view can reach it. The block is native: a shield
     * covers the page, the load stops, the media pauses and every navigation is refused.
     */
    @Command
    fun setBlocked(invoke: Invoke) {
        val args = invoke.parseArgs(SetBlockedArgs::class.java)
        val session = sessions[args.session]
        if (session == null) {
            if (args.blocked) rememberBlocked(args.session) else forgetBlocked(args.session)
            invoke.resolve()
            return
        }
        applyBlocked(args.blocked, session)
        invoke.resolve()
    }

    /**
     * Names the sites whose media may keep playing while hidden or in the background. Rust-only:
     * the plugin registers no command for it, so neither the shell nor a site view can reach it.
     */
    @Command
    fun setBackgroundMedia(invoke: Invoke) {
        val args = invoke.parseArgs(SetBackgroundMediaArgs::class.java)
        backgroundMediaSites = args.sites.toSet()
        refreshMedia()
        invoke.resolve()
    }

    /**
     * Pauses the media of every page that is out of sight, unless its site may play on, and resumes
     * what was paused when the page is shown again. A closed page is left to [applyBlocked].
     */
    private fun refreshMedia() {
        for (session in sessions.values) {
            if (session.blocked) continue
            val shown = appForeground && session.id == activeId
            val pause = !shown && session.scope !in backgroundMediaSites
            if (pause == session.mediaPaused) continue
            session.mediaPaused = pause
            session.view.evaluateJavascript(if (pause) PAUSE_MEDIA_SCRIPT else RESUME_MEDIA_SCRIPT, null)
        }
    }

    override fun onPause() {
        appForeground = false
        refreshMedia()
    }

    override fun onResume() {
        appForeground = true
        refreshMedia()
    }

    /**
     * Asks the device owner to prove they are present: a biometric or the device credential.
     * Resolves `authenticated: false` when the person cancels, and rejects only when the check
     * cannot run at all.
     */
    @Command
    fun authenticate(invoke: Invoke) {
        val args = invoke.parseArgs(AuthenticateArgs::class.java)
        val fragment = activity as? FragmentActivity
        if (fragment == null) {
            invoke.reject("this device cannot check who is holding it")
            return
        }
        val authenticators = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_WEAK
        }
        val prompt = BiometricPrompt(
            fragment,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    resolveAuthenticated(invoke, true)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    val unavailable = errorCode == BiometricPrompt.ERROR_NO_BIOMETRICS ||
                        errorCode == BiometricPrompt.ERROR_HW_NOT_PRESENT ||
                        errorCode == BiometricPrompt.ERROR_HW_UNAVAILABLE ||
                        errorCode == BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL ||
                        errorCode == BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED
                    if (unavailable) {
                        invoke.reject(errString.toString())
                    } else {
                        resolveAuthenticated(invoke, false)
                    }
                }
            },
        )
        val builder = BiometricPrompt.PromptInfo.Builder()
            .setTitle(args.reason)
            .setAllowedAuthenticators(authenticators)
        // Without device credentials (before Android 11) the prompt needs a negative button.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) builder.setNegativeButtonText("Cancel")
        val info = builder.build()
        try {
            prompt.authenticate(info)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "this device cannot check who is holding it")
        }
    }

    /**
     * Which biometric this device has, for the shell's icon. Android does not say whether a
     * biometric is a face or a finger, so this is always a fingerprint. Rust-only: no Tauri
     * command or permission exposes it.
     */
    @Command
    fun biometryKind(invoke: Invoke) {
        val payload = JSObject()
        payload.put("kind", "fingerprint")
        invoke.resolve(payload)
    }

    /**
     * Runs a Rust-supplied script in the active session's main frame and resolves with its JSON
     * text. Rust-only: no Tauri command or permission exposes it.
     */
    @Command
    fun evaluate(invoke: Invoke) {
        val args = invoke.parseArgs(EvaluateArgs::class.java)
        val session = activeSession()
        if (session == null || session.blocked) {
            invoke.reject("no site view is open")
            return
        }
        var finished = false
        fun finish(block: () -> Unit) {
            if (finished) return
            finished = true
            block()
        }
        activity.window.decorView.postDelayed({
            finish { invoke.reject("the page did not answer in time") }
        }, EVALUATE_TIMEOUT_MS)
        session.view.evaluateJavascript(args.script) { value ->
            activity.runOnUiThread {
                finish {
                    if (value == null || value == "null") {
                        invoke.reject("the script returned no value")
                        return@finish
                    }
                    val text = runCatching { JSONArray("[$value]").getString(0) }.getOrNull()
                    if (text == null) {
                        invoke.reject("the script returned no value")
                        return@finish
                    }
                    if (text.toByteArray(Charsets.UTF_8).size > EVALUATE_MAX_BYTES) {
                        invoke.reject("the script result is too large")
                        return@finish
                    }
                    val payload = JSObject()
                    payload.put("json", text)
                    invoke.resolve(payload)
                }
            }
        }
    }

    /**
     * The OS secret store. Rust-only: the plugin registers no command for it, so neither the
     * shell nor a site view can reach a stored key.
     */
    @Command
    fun secretOp(invoke: Invoke) {
        val args = invoke.parseArgs(SecretArgs::class.java)
        try {
            val value = when (args.op) {
                "set" -> {
                    AndroidSecrets.set(activity, args.id, args.value ?: "")
                    null
                }
                "get" -> AndroidSecrets.get(activity, args.id)
                "delete" -> {
                    AndroidSecrets.delete(activity, args.id)
                    null
                }
                else -> {
                    invoke.reject("unknown secret operation")
                    return
                }
            }
            val payload = JSObject()
            payload.put("value", value ?: JSONObject.NULL)
            invoke.resolve(payload)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "the secret store failed")
        }
    }

    // MARK: Sessions

    /** Makes `session` the one visible page. The others stay alive underneath, hidden. */
    private fun show(session: Session) {
        // A sign-in window belongs to the page that opened it; another page takes the screen.
        if (signInOwner != null && signInOwner != session.id) closeSignInWindow()
        for (other in sessions.values) {
            if (other === session) continue
            other.frame.visibility = View.GONE
            other.shield?.visibility = View.GONE
        }
        session.frame.visibility = View.VISIBLE
        session.shield?.visibility = View.VISIBLE
        activeId = session.id
        refreshMedia()
        if (session.needsReload && !session.blocked) {
            session.needsReload = false
            if (session.view.url == null) {
                session.view.loadUrl(session.initialUrl)
            } else {
                session.view.reload()
            }
        }
        sendState(session)
    }

    private fun dispose(session: Session) {
        if (signInOwner == session.id) closeSignInWindow()
        removeShield(session)
        session.scriptHandler?.remove()
        session.paintHandler?.remove()
        session.scriptHandler = null
        session.paintHandler = null
        session.view.stopLoading()
        session.frame.removeView(session.view)
        pageLayer?.removeView(session.frame)
        session.view.destroy()
        sessions.remove(session.id)
        if (activeId == session.id) activeId = null
    }

    private fun activeSession(): Session? = activeId?.let { sessions[it] }

    private fun onActiveSession(invoke: Invoke, action: (Session) -> Unit) {
        val session = activeSession()
        if (session == null) {
            invoke.reject("no site view is open")
            return
        }
        if (session.blocked) {
            // A closed page is frozen: the request is answered, but the page does not move.
            invoke.resolve()
            return
        }
        action(session)
        invoke.resolve()
    }

    private fun reloadUnder(session: Session) {
        if (session.id == activeId && !session.blocked) {
            session.view.reload()
        } else {
            session.needsReload = true
        }
    }

    // MARK: Blocking

    private fun applyBlocked(blocked: Boolean, session: Session) {
        if (blocked) {
            rememberBlocked(session.id)
            session.blocked = true
            session.view.stopLoading()
            // The closest Android has to suspending every media playback: the page's timers and
            // animations stop, so nothing plays and nothing loads.
            session.view.onPause()
            session.frame.isRefreshing = false
            session.frame.isEnabled = false
            installShield(session)
            reveal(session)
        } else {
            forgetBlocked(session.id)
            session.blocked = false
            removeShield(session)
            session.view.onResume()
            session.frame.isEnabled = true
            if (session.view.url == null) session.needsReload = true
            if (session.id == activeId && session.needsReload) show(session)
            refreshMedia()
        }
    }

    /** Covers a closed page with a native shield that takes every touch and says why. */
    private fun installShield(session: Session) {
        if (session.shield != null) return
        val layer = pageLayer ?: return
        val shield = TextView(activity)
        shield.text = SHIELD_MESSAGE
        shield.gravity = Gravity.CENTER
        shield.setTextColor(Color.WHITE)
        shield.setBackgroundColor(Color.parseColor("#E60B1220"))
        shield.setPadding(48, 48, 48, 48)
        shield.isClickable = true
        shield.visibility = if (session.id == activeId) View.VISIBLE else View.GONE
        layer.addView(shield)
        session.shield = shield
    }

    private fun removeShield(session: Session) {
        val shield = session.shield ?: return
        pageLayer?.removeView(shield)
        session.shield = null
    }

    private fun rememberBlocked(id: String) {
        if (!blockedSessions.contains(id)) blockedSessions.add(id)
        while (blockedSessions.size > MAX_REMEMBERED_BLOCKED) blockedSessions.removeAt(0)
    }

    private fun forgetBlocked(id: String) {
        blockedSessions.removeAll { it == id }
    }

    private fun isBlocked(id: String): Boolean = blockedSessions.contains(id)

    // MARK: WebView setup

    private fun configure(view: WebView) {
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.settings.mediaPlaybackRequiresUserGesture = false
        view.settings.javaScriptCanOpenWindowsAutomatically = true
        // A window the page opens is ours to make; without this the page's `window.open` would
        // navigate the page itself.
        view.settings.setSupportMultipleWindows(true)
        view.setBackgroundColor(Color.TRANSPARENT)
        view.overScrollMode = View.OVER_SCROLL_NEVER
        view.isClickable = true
        view.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message,
            ): Boolean {
                val session = sessionOf(view) ?: return false
                if (session.blocked) return false
                return openSignInWindow(session, resultMsg)
            }

            override fun onCloseWindow(window: WebView) {
                if (window === signInWindow) closeSignInWindow()
            }
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val session = sessionOf(view) ?: return true
                if (session.blocked) return true
                val url = request.url
                val userInitiated = request.isForMainFrame && request.hasGesture() &&
                    !url.host.isNullOrEmpty() &&
                    (url.scheme.equals("http", ignoreCase = true) ||
                        url.scheme.equals("https", ignoreCase = true))
                if (userInitiated) {
                    session.userNavigationPending = true
                    session.settled = false
                }
                return when (
                    DomainScope.verdict(
                        url.scheme,
                        url.host,
                        session.scope,
                        session.settled,
                        request.isForMainFrame,
                        userInitiated,
                    )
                ) {
                    DomainScope.Verdict.ALLOW -> false
                    DomainScope.Verdict.CANCEL -> true
                    DomainScope.Verdict.POPUP -> {
                        // A redirect the page made on its own (a sign-in that runs after the tap)
                        // has to stay in the app: the system browser shares no cookies with it.
                        if (!openRedirectWindow(session, url)) presentPopup(url)
                        true
                    }
                }
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                val session = sessionOf(view) ?: return
                session.topUrl = url
                session.loading = true
                // While the initial load or a user-initiated navigation is unsettled, redirects may
                // change the scope; it then stays pinned to the destination domain.
                if (!session.settled) {
                    val host = Uri.parse(url).host
                    if (host != null) session.scope = DomainScope.registrableDomain(host)
                }
                injectLate(session, session.recipe)
                sendState(session)
            }

            override fun onPageCommitVisible(view: WebView, url: String) {
                val session = sessionOf(view) ?: return
                reveal(session)
            }

            override fun onPageFinished(view: WebView, url: String) {
                val session = sessionOf(view) ?: return
                session.loading = false
                session.settled = true
                finishHandoff(session)
                session.userNavigationPending = false
                session.frame.isRefreshing = false
                reveal(session)
                sendState(session)
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                val session = sessionOf(view) ?: return
                session.topUrl = url
                sendState(session)
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: android.webkit.WebResourceError,
            ) {
                if (!request.isForMainFrame) return
                val session = sessionOf(view) ?: return
                session.settled = true
                finishHandoff(session)
                session.userNavigationPending = false
                session.frame.isRefreshing = false
                sendError(error.description?.toString() ?: "the page could not be loaded")
            }

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                val session = sessionOf(view) ?: return null
                if (session.blocked) return blockedResponse()
                // `shouldOverrideUrlLoading` is not called for POST navigations, so a page could
                // post a form to another domain inside this logged-in view.
                // A user-initiated navigation does not relax this guard before it settles.
                if (request.isForMainFrame && request.method.equals("POST", ignoreCase = true) &&
                    DomainScope.verdict(
                        request.url.scheme,
                        request.url.host,
                        session.scope,
                        session.settled || session.userNavigationPending,
                        true,
                    ) != DomainScope.Verdict.ALLOW
                ) {
                    return blockedResponse()
                }
                val url = request.url.toString()
                val top = session.topUrl
                if (!rules.blocks(url, request.isForMainFrame, top)) return null
                return blockedResponse()
            }

            /**
             * A dead renderer leaves a blank page. The session is dropped and the shell is told,
             * so it can open the site again.
             */
            override fun onRenderProcessGone(
                view: WebView,
                detail: android.webkit.RenderProcessGoneDetail,
            ): Boolean {
                val session = sessionOf(view) ?: return true
                val id = session.id
                dispose(session)
                sendClosed(id)
                return true
            }
        }
    }

    private fun sessionOf(view: WebView): Session? =
        synchronized(sessions) { sessions.values.firstOrNull { it.view === view } }

    private fun blockedResponse(): WebResourceResponse = WebResourceResponse(
        "text/plain",
        "utf-8",
        403,
        "Blocked",
        emptyMap(),
        ByteArrayInputStream(ByteArray(0)),
    )

    // MARK: Bridge and scripts

    /**
     * The page's own way to talk to the app: a write-only message object. It reaches no Tauri
     * IPC, and only the main frame's messages are taken.
     */
    private fun installBridge(session: Session) {
        WebViewCompat.addWebMessageListener(
            session.view,
            BRIDGE_OBJECT,
            setOf("*"),
        ) { _, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, _ ->
            if (!isMainFrame) return@addWebMessageListener
            val body = message.data ?: return@addWebMessageListener
            if (!isJsonContainer(body)) return@addWebMessageListener
            sendBridge("${sourceOrigin.scheme}://${sourceOrigin.host}", body)
        }
        WebViewCompat.addWebMessageListener(
            session.view,
            PAINT_OBJECT,
            setOf("*"),
        ) { _, _: WebMessageCompat, _: Uri, isMainFrame: Boolean, _ ->
            if (isMainFrame) reveal(session)
        }
        WebViewCompat.addWebMessageListener(
            session.view,
            SCROLL_OBJECT,
            setOf("*"),
        ) { _, message: WebMessageCompat, _: Uri, isMainFrame: Boolean, _ ->
            if (isMainFrame) session.innerScrolled = message.data == "1"
        }
    }

    /** True for a JSON object or array, the only shapes the bridge carries. */
    private fun isJsonContainer(text: String): Boolean {
        return try {
            val value = org.json.JSONTokener(text).nextValue()
            value is JSONObject || value is JSONArray
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Installs recipe scripts independently from URL-matched adblock scriptlets. Scriptlets only
     * run when enabled and document-start support exists; the late fallback remains recipe-only.
     */
    private fun installScripts(session: Session, recipe: String?) {
        session.scriptHandler?.remove()
        session.adBlockScriptHandler?.remove()
        session.paintHandler?.remove()
        session.scriptHandler = null
        session.adBlockScriptHandler = null
        session.paintHandler = null
        session.recipe = recipe
        val documentStartSupported =
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        val scriptlet = activeAdBlockScriptlet(
            session.adBlockScriptlet,
            session.adBlockEnabled,
            documentStartSupported,
        )
        if (!documentStartSupported) return
        session.paintHandler = WebViewCompat.addDocumentStartJavaScript(
            session.view,
            PAGE_REPORTER_SCRIPT,
            setOf("*"),
        )
        if (scriptlet != null) {
            session.adBlockScriptHandler = WebViewCompat.addDocumentStartJavaScript(
                session.view,
                scriptlet,
                setOf("*"),
            )
        }
        if (!recipe.isNullOrEmpty()) {
            session.scriptHandler = WebViewCompat.addDocumentStartJavaScript(
                session.view,
                recipe,
                setOf("*"),
            )
        }
    }

    /** The late path: inject the scripts once the page has started. */
    private fun injectLate(session: Session, recipe: String?) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        session.view.evaluateJavascript(PAGE_REPORTER_SCRIPT, null)
        if (!recipe.isNullOrEmpty()) session.view.evaluateJavascript(recipe, null)
    }

    // MARK: Sign-in window

    /**
     * The window a page opened with `window.open`: a sign-in window (Google, Apple). It has to
     * live inside the app and share the page's profile, or the sign-in cannot hand its token
     * back to the page that opened it.
     */
    private fun openSignInWindow(session: Session, resultMsg: Message): Boolean {
        val layer = pageLayer ?: return false
        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        closeSignInWindow()
        val popup = WebView(activity)
        try {
            WebViewCompat.setProfile(popup, session.profile)
        } catch (error: Exception) {
            popup.destroy()
            return false
        }
        configureSignInWindow(popup, session)
        installSignInBridge(popup, session)
        layer.addView(
            popup,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        signInWindow = popup
        signInOwner = session.id
        transport.webView = popup
        resultMsg.sendToTarget()
        return true
    }

    /**
     * An address the page navigated to on its own, outside the session's domain: usually a
     * sign-in redirect. It opens in a window of its own in the session's profile, so the cookies
     * it sets are the page's cookies; when the sign-in returns to the site, the page's own view
     * loads that address and the window closes.
     */
    private fun openRedirectWindow(session: Session, url: Uri): Boolean {
        if (url.scheme?.lowercase() !in setOf("http", "https")) return false
        val layer = pageLayer ?: return false
        closeSignInWindow()
        val popup = WebView(activity)
        try {
            WebViewCompat.setProfile(popup, session.profile)
        } catch (error: Exception) {
            popup.destroy()
            return false
        }
        configureSignInWindow(popup, session, returnsToSession = true)
        layer.addView(
            popup,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        signInWindow = popup
        signInOwner = session.id
        popup.loadUrl(url.toString())
        return true
    }

    /**
     * The sign-in window's own rules: it follows its redirects, because the identity provider
     * and the site it returns to are different domains. The first address decides where the
     * window belongs: a page of the session's own site belongs in the session, everything else
     * is a sign-in window and stays.
     */
    private fun configureSignInWindow(
        popup: WebView,
        session: Session,
        returnsToSession: Boolean = false,
    ) {
        popup.settings.javaScriptEnabled = true
        popup.settings.domStorageEnabled = true
        popup.settings.javaScriptCanOpenWindowsAutomatically = true
        popup.settings.setSupportMultipleWindows(true)
        popup.setBackgroundColor(Color.TRANSPARENT)
        popup.overScrollMode = View.OVER_SCROLL_NEVER
        popup.isClickable = true
        var firstAddress = true
        popup.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                val scheme = url.scheme?.lowercase()
                if (scheme != "http" && scheme != "https") return scheme != "about"
                if (!request.isForMainFrame) return false
                val host = url.host ?: return true
                if (returnsToSession) {
                    if (!DomainScope.contains(session.scope, host)) return false
                    // The identity provider sent the user back to the site: that page belongs in
                    // the session's own view, which shares this window's cookies.
                    handBack(session, url.toString(), popup)
                    return true
                }
                if (!firstAddress) return false
                firstAddress = false
                if (DomainScope.contains(session.scope, host)) {
                    // The window opened a page of the session's own site: that page belongs in
                    // the session, not in a window of its own.
                    session.view.post { session.view.loadUrl(url.toString()) }
                    popup.post { closeSignInWindow(popup) }
                    return true
                }
                return false
            }

            override fun onPageStarted(
                view: WebView,
                url: String,
                favicon: android.graphics.Bitmap?,
            ) {
                if (returnsToSession) return
                // Without document-start scripts the opener comes late, which the page's own
                // scripts may have missed.
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    popup.evaluateJavascript(OPENER_SCRIPT, null)
                }
                if (!url.startsWith("http") || !firstAddress) return
                firstAddress = false
                val host = Uri.parse(url).host ?: return
                if (!DomainScope.contains(session.scope, host)) return
                session.view.post { session.view.loadUrl(url) }
                popup.post { closeSignInWindow(popup) }
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!returnsToSession || !url.startsWith("http")) return
                // A return that arrived as a form post cannot be replayed in the session's view;
                // the window finished it (its cookies are the page's), so the session's view
                // loads where it ended up.
                val host = Uri.parse(url).host ?: return
                if (!DomainScope.contains(session.scope, host)) return
                handBack(session, url, popup)
            }
        }
        popup.webChromeClient = object : WebChromeClient() {
            override fun onCloseWindow(window: WebView) {
                if (window === signInWindow) closeSignInWindow()
            }
        }
    }

    /**
     * The sign-in window stays over the page until the page has loaded the address it was handed,
     * so the user sees the sign-in, not a blank page, while the site comes up.
     */
    private fun handBack(session: Session, url: String, popup: WebView) {
        handoffSession = session.id
        session.view.post { session.view.loadUrl(url) }
        popup.postDelayed({
            if (handoffSession == session.id) closeSignInWindow(popup)
        }, 8000)
    }

    private fun finishHandoff(session: Session) {
        if (handoffSession == session.id) closeSignInWindow()
    }

    /**
     * The sign-in window's way to talk to the page that opened it. Android's WebView gives a
     * window no `window.opener`, so the window gets one that carries the message over this
     * channel and the app hands it to the page as a message event.
     */
    private fun installSignInBridge(popup: WebView, session: Session) {
        WebViewCompat.addWebMessageListener(
            popup,
            OPENER_OBJECT,
            setOf("*"),
        ) { _, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, _ ->
            if (!isMainFrame) return@addWebMessageListener
            val body = message.data ?: return@addWebMessageListener
            forwardToOpener(session, body, "${sourceOrigin.scheme}://${sourceOrigin.host}")
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(popup, OPENER_SCRIPT, setOf("*"))
        }
    }

    /** Hands a message from the sign-in window to the page that opened it. */
    private fun forwardToOpener(session: Session, body: String, origin: String) {
        val payload = try {
            JSONObject(body)
        } catch (error: Exception) {
            return
        }
        if (payload.optString("kind") != "message") return
        val script = openerMessageScript(payload.opt("message"), origin) ?: return
        session.view.evaluateJavascript(script, null)
    }

    /** Takes the sign-in window down and gives the touches back to the page. */
    private fun closeSignInWindow(window: WebView? = null) {
        val view = signInWindow ?: return
        if (window != null && window !== view) return
        signInWindow = null
        signInOwner = null
        handoffSession = null
        pageLayer?.removeView(view)
        view.stopLoading()
        view.destroy()
    }

    // MARK: Painting

    /** Shows the page once it has something to show; until then the backdrop is visible. */
    private fun reveal(session: Session) {
        if (session.painted) return
        session.painted = true
        session.view.alpha = 1f
        sendState(session)
    }

    // MARK: Layout and touch

    private fun setPageRect(rect: RectF) {
        val shellView = shell
        val offsetX = shellView?.left?.toFloat() ?: 0f
        val offsetY = shellView?.top?.toFloat() ?: 0f
        val placed = RectF(
            rect.left + offsetX,
            rect.top + offsetY,
            rect.right + offsetX,
            rect.bottom + offsetY,
        )
        pageLayer?.pageRect = placed
        pageLayer?.requestLayout()
    }

    // Shell DOM rects are CSS pixels; Android view geometry and MotionEvent coordinates are pixels.
    private fun rectOf(args: RectArgs): RectF {
        val density = activity.resources.displayMetrics.density
        return RectF(
            args.x.toFloat() * density,
            args.y.toFloat() * density,
            (args.x.toFloat() + args.width.toFloat()) * density,
            (args.y.toFloat() + args.height.toFloat()) * density,
        )
    }

    /**
     * Decides, per touch, whether the shell or the page underneath receives it. A touch inside a
     * region the shell reported belongs to the shell; every other touch goes to the page.
     */
    private fun routeTouch(event: MotionEvent): Boolean {
        val shellView = shell ?: return false
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            touchTarget = null
            val session = activeSession() ?: return false
            if (interactiveRegions.any { it.contains(event.x, event.y) }) return false
            val target = signInWindow ?: session.shield ?: session.frame
            if (target.visibility != View.VISIBLE) return false
            touchTarget = target
        }
        val target = touchTarget ?: return false
        val origin = IntArray(2)
        val shellOrigin = IntArray(2)
        target.getLocationInWindow(origin)
        shellView.getLocationInWindow(shellOrigin)
        val copy = MotionEvent.obtain(event)
        copy.offsetLocation(
            (shellOrigin[0] - origin[0]).toFloat(),
            (shellOrigin[1] - origin[1]).toFloat(),
        )
        val handled = target.dispatchTouchEvent(copy)
        copy.recycle()
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            touchTarget = null
        }
        return handled
    }

    // MARK: Notifications

    private fun postNotification(session: String, title: String, body: String) {
        val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL,
                "Sites",
                NotificationManager.IMPORTANCE_DEFAULT,
            )
            manager.createNotificationChannel(channel)
        }
        val intent = Intent(activity, activity.javaClass).apply {
            putExtra(NOTIFICATION_SESSION, session)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            activity,
            session.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(activity, NOTIFICATION_CHANNEL)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        manager.notify("unread-$session".hashCode(), notification)
    }

    override fun onNewIntent(intent: Intent) {
        reportNotificationTap(intent)
    }

    private fun reportNotificationTap(intent: Intent?) {
        val session = intent?.getStringExtra(NOTIFICATION_SESSION) ?: return
        if (!session.isEmpty()) sendNotificationTapped(session)
    }

    // MARK: Events

    private fun sendState(session: Session) {
        val payload = JSObject()
        payload.put("type", "state")
        payload.put("session", session.id)
        payload.put("url", session.view.url ?: JSONObject.NULL)
        payload.put("title", session.view.title ?: JSONObject.NULL)
        payload.put("loading", session.loading)
        payload.put("canGoBack", session.view.canGoBack())
        payload.put("canGoForward", session.view.canGoForward())
        payload.put("painted", session.painted)
        payload.put("scope", session.scope)
        events?.send(payload)
    }

    private fun sendClosed(session: String) {
        val payload = JSObject()
        payload.put("type", "closed")
        payload.put("session", session)
        events?.send(payload)
    }

    private fun sendMemoryWarning() {
        val payload = JSObject()
        payload.put("type", "memoryWarning")
        events?.send(payload)
    }

    private fun sendNotificationTapped(session: String) {
        val payload = JSObject()
        payload.put("type", "notificationTapped")
        payload.put("session", session)
        events?.send(payload)
    }

    private fun sendError(message: String) {
        val payload = JSObject()
        payload.put("type", "error")
        payload.put("message", message)
        events?.send(payload)
    }

    private fun sendBridge(origin: String, body: String) {
        val payload = JSObject()
        payload.put("type", "bridge")
        payload.put("origin", origin)
        payload.put("body", body)
        events?.send(payload)
    }

    // MARK: System callbacks

    override fun onTrimMemory(level: Int) {
        // Backgrounding reports TRIM_MEMORY_UI_HIDDEN, which is not pressure: closing every hidden
        // session each time the app is left would lose the user's pages.
        val pressure = level in ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW..
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ||
            level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE
        if (pressure) sendMemoryWarning()
    }

    override fun onLowMemory() {
        sendMemoryWarning()
    }

    /** With the "system" scheme the app follows the device, which can change while it runs. */
    override fun onConfigurationChanged(newConfig: Configuration) {
        if (colorScheme == "system") applyColorScheme()
    }

    // MARK: Helpers

    private fun isDark(): Boolean = when (colorScheme) {
        "dark" -> true
        "light" -> false
        else -> (activity.resources.configuration.uiMode and
            Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }

    private fun applyColorScheme() {
        for (session in sessions.values) applyScheme(session)
        backdrop?.setBackgroundColor(backdropColor())
        applyStatusBarIcons()
    }

    private fun applyScheme(session: Session) {
        runCatching {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(session.view.settings, isDark())
        }
    }

    private fun backdropColor(): Int =
        if (isDark()) Color.parseColor("#070B14") else Color.parseColor("#F4F7FC")

    /**
     * The shell paints the strip under the status bar in the app's own ink or paper. The system
     * picks the icon colour from the device's theme, not the app's, so an app set to Dark on a
     * light device would get dark icons on a dark strip.
     */
    private fun applyStatusBarIcons() {
        val window = activity.window
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars =
            !isDark()
    }

    /** Shows the outside page in the system's browser; it shares nothing with the profile. */
    private fun presentPopup(url: Uri) {
        if (url.scheme?.lowercase() !in setOf("http", "https")) return
        runCatching {
            CustomTabsIntent.Builder().build().launchUrl(activity, url)
        }
    }

    private fun webUrl(text: String): Uri? {
        val uri = runCatching { Uri.parse(text) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (uri.host.isNullOrEmpty()) return null
        return uri
    }

    private fun resolveAuthenticated(invoke: Invoke, authenticated: Boolean) {
        val payload = JSObject()
        payload.put("authenticated", authenticated)
        invoke.resolve(payload)
    }

    companion object {
        private const val BRIDGE_OBJECT = "openmedia"

        /** Pauses what plays and remembers which elements it paused, so only those resume. */
        private const val PAUSE_MEDIA_SCRIPT =
            "(function(){var held=window.__openmediaPaused=window.__openmediaPaused||[];" +
                "document.querySelectorAll('video,audio').forEach(function(m){" +
                "if(!m.paused&&!m.ended){held.push(m);m.pause()}})})()"
        private const val RESUME_MEDIA_SCRIPT =
            "(function(){var held=window.__openmediaPaused||[];window.__openmediaPaused=[];" +
                "held.forEach(function(m){try{var p=m.play();if(p&&p.catch)p.catch(function(){})}" +
                "catch(e){}})})()"
        private const val PAINT_OBJECT = "openmediaPaint"
        private const val SCROLL_OBJECT = "openmediaScroll"
        private const val OPENER_OBJECT = "openmediaOpener"
        private const val NOTIFICATION_CHANNEL = "openmedia-siteview"
        private const val NOTIFICATION_SESSION = "openmedia.session"
        private const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"
        private const val SHIELD_MESSAGE = "This site is closed for today. It opens again tomorrow."
        private const val OUTDATED_WEBVIEW =
            "This device's System WebView is too old. Update Android System WebView to open sites."
        private const val MAX_REMEMBERED_BLOCKED = 32
        private const val EDGE_GESTURE_ZONE_DP = 48
        private const val MAX_EXCLUSION_DP = 200
        private const val REFRESH_COLOR = 0xFF06AFF8.toInt()
        private const val EVALUATE_TIMEOUT_MS = 5000L
        private const val EVALUATE_MAX_BYTES = 200_000

        /**
         * Reports the page's first contentful paint, so the page is shown when it has something to
         * show rather than when the document merely exists.
         */
        private val FIRST_PAINT_SCRIPT = """
(function () {
  var sent = false;
  function report() {
    if (sent) return;
    sent = true;
    try { window.$PAINT_OBJECT.postMessage("painted"); } catch (error) {}
  }
  function afterFrames(count) {
    requestAnimationFrame(function () { if (count > 1) afterFrames(count - 1); else report(); });
  }
  try {
    new PerformanceObserver(function (list, observer) {
      if (list.getEntriesByName('first-contentful-paint').length === 0) return;
      observer.disconnect();
      report();
    }).observe({ type: 'paint', buffered: true });
  } catch (error) {
    afterFrames(2);
  }
})();
"""

        /**
         * Tells the app, at the start of every touch, whether the touch began inside a container
         * that is scrolled away from its top. Feeds of full-screen videos scroll inside such a
         * container while the page itself stays at its top, which is all the refresh layer can see.
         */
        private val TOUCH_SCROLL_SCRIPT = """
(function () {
  window.addEventListener('touchstart', function (event) {
    var node = event.target;
    var scrolled = false;
    while (node && node.nodeType === 1) {
      if (node.scrollTop > 0) { scrolled = true; break; }
      node = node.parentElement;
    }
    try { window.$SCROLL_OBJECT.postMessage(scrolled ? "1" : "0"); } catch (error) {}
  }, { capture: true, passive: true });
})();
"""

        private val PAGE_REPORTER_SCRIPT = FIRST_PAINT_SCRIPT + TOUCH_SCROLL_SCRIPT

        /**
         * Android's WebView gives a window no `window.opener`, so a sign-in window cannot report
         * back to the page that opened it. This gives it one: the message goes to the app, which
         * hands it to the page as a message event, the way a real opener would. A window that
         * already has an opener keeps it.
         */
        private val OPENER_SCRIPT = """
(function () {
  if (window.opener) return;
  var send = function (payload) {
    try { window.$OPENER_OBJECT.postMessage(JSON.stringify(payload)); } catch (error) {}
  };
  var proxy = {
    postMessage: function (message, origin) {
      send({ kind: "message", message: message, origin: origin || "" });
    },
    closed: false,
    focus: function () {},
    close: function () { send({ kind: "close" }); },
  };
  var define = function (target) {
    Object.defineProperty(target, "opener", {
      configurable: true,
      get: function () { return proxy; },
    });
  };
  try {
    define(window);
  } catch (error) {
    try { define(Object.getPrototypeOf(window)); } catch (fallbackError) {}
  }
})();
"""
    }
}

/**
 * The script that hands a message from the sign-in window to the page that opened it, the way a
 * real opener's `postMessage` would. The message and the origin are the page's own words, so
 * both are written as JSON text: nothing the page says can end the script early.
 */
internal fun openerMessageScript(message: Any?, origin: String): String? {
    val data = when (message) {
        is JSONObject -> message.toString()
        is JSONArray -> message.toString()
        is String -> JSONObject.quote(message)
        is Boolean -> message.toString()
        is Int, is Long, is Double, is Float -> message.toString()
        else -> return null
    }
    return "window.dispatchEvent(new MessageEvent('message',{data:$data,origin:${JSONObject.quote(origin)}}))"
}
