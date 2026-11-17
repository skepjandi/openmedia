package surf.openmedia.siteview

/**
 * What to do with a main-frame navigation requested by a session.
 *
 * This is the Android twin of `ios/Sources/DomainScope.swift`: a session follows user-initiated
 * navigation in its web view, then stays pinned to the destination domain.
 */
object DomainScope {
    enum class Verdict {
        ALLOW,
        CANCEL,
        POPUP,
    }

    private val signInHosts = listOf(
        "accounts.google.com", "accounts.youtube.com", "appleid.apple.com",
        "login.microsoftonline.com", "login.live.com", "checkout.stripe.com", "paypal.com",
        "okta.com", "auth0.com",
    )
    private val signInPaths = listOf(
        "/oauth", "/authorize", "/saml", "/sso", "/openid", "/signin", "/sign-in", "/login", "/log-in",
    )

    /**
     * Whether an address outside the session's site is plausibly a sign-in or a payment, the only
     * reason a page has to send the user somewhere else on its own. Ad networks send people to
     * throwaway domains with none of these marks, so everything else a page opens or redirects to
     * without a tap on a link is refused. Heuristic: an unknown identity provider that uses none
     * of these marks is refused too.
     */
    @JvmStatic
    fun looksLikeSignIn(host: String?, path: String?, query: String?): Boolean {
        val h = (host ?: "").lowercase()
        if (signInHosts.any { h == it || h.endsWith(".$it") }) return true
        val p = (path ?: "").lowercase()
        if (signInPaths.any { p.contains(it) } || p.endsWith("/auth") || p.contains("/auth/")) return true
        val names = (query ?: "").split('&').map { it.substringBefore('=').lowercase() }.toSet()
        return "samlrequest" in names ||
            ("client_id" in names && ("redirect_uri" in names || "response_type" in names))
    }

    /**
     * `www.instagram.com` and `m.instagram.com` both give `instagram.com`; `news.bbc.co.uk` gives
     * `bbc.co.uk`, and `bob.github.io` stays `bob.github.io` (Public Suffix List). Hosts without a
     * registrable part (IP addresses, `localhost`) are kept whole.
     */
    @JvmStatic
    fun registrableDomain(host: String?): String =
        PublicSuffix.shared.registrableDomain(host) ?: (host ?: "").removeSuffix(".").lowercase()

    /** True for the scope itself and any subdomain of it, never for `notinstagram.com`. */
    @JvmStatic
    fun contains(scope: String, host: String): Boolean {
        val normalizedHost = host.removeSuffix(".").lowercase()
        val normalizedScope = scope.removeSuffix(".").lowercase()
        if (normalizedScope.isEmpty()) return false
        return normalizedHost == normalizedScope || normalizedHost.endsWith("." + normalizedScope)
    }

    /**
     * Decides a navigation.
     *
     * `settled` is false during a page's initial load or a user-initiated navigation. Until then
     * redirects may change the domain; after it settles, automatic cross-domain navigations open
     * in a popup when `signIn` says the target looks like a sign-in (`looksLikeSignIn`) and are
     * cancelled otherwise: an ad redirect. Subframes are never blocked.
     */
    @JvmStatic
    fun verdict(
        scheme: String?,
        host: String?,
        scope: String,
        settled: Boolean,
        isMainFrame: Boolean,
        userInitiated: Boolean = false,
        signIn: Boolean = false,
    ): Verdict {
        return when (scheme?.lowercase()) {
            "about" -> Verdict.ALLOW
            "http", "https" -> {
                if (host.isNullOrEmpty()) {
                    Verdict.CANCEL
                } else if (!isMainFrame || !settled || userInitiated || contains(scope, host)) {
                    Verdict.ALLOW
                } else {
                    if (signIn) Verdict.POPUP else Verdict.CANCEL
                }
            }
            else -> Verdict.CANCEL
        }
    }
}
