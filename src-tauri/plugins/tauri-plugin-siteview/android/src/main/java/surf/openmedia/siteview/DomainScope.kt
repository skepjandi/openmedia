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
     * in a popup. Subframes are never blocked.
     */
    @JvmStatic
    fun verdict(
        scheme: String?,
        host: String?,
        scope: String,
        settled: Boolean,
        isMainFrame: Boolean,
        userInitiated: Boolean = false,
    ): Verdict {
        return when (scheme?.lowercase()) {
            "about" -> Verdict.ALLOW
            "http", "https" -> {
                if (host.isNullOrEmpty()) {
                    Verdict.CANCEL
                } else if (!isMainFrame || !settled || userInitiated || contains(scope, host)) {
                    Verdict.ALLOW
                } else {
                    Verdict.POPUP
                }
            }
            else -> Verdict.CANCEL
        }
    }
}
