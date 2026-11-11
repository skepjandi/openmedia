package surf.openmedia.siteview

/**
 * What to do with a main-frame navigation requested by a session.
 *
 * This is the Android twin of `ios/Sources/DomainScope.swift`: a clicked link from a favorite
 * opens outside the session; other clicked links and their redirects stay in the same view.
 */
object DomainScope {
    enum class Verdict {
        ALLOW,
        CANCEL,
        POPUP,
    }

    private val searchEngineDomains = setOf(
        "duckduckgo.com", "google.com", "bing.com", "brave.com", "ecosia.org", "startpage.com", "yahoo.com",
    )

    /**
     * `www.instagram.com` and `m.instagram.com` both give `instagram.com`; `news.bbc.co.uk` gives
     * `bbc.co.uk`, and `bob.github.io` stays `bob.github.io` (Public Suffix List). Hosts without a
     * registrable part (IP addresses, `localhost`) are kept whole.
     */
    @JvmStatic
    fun registrableDomain(host: String?): String =
        PublicSuffix.shared.registrableDomain(host) ?: (host ?: "").removeSuffix(".").lowercase()

    @JvmStatic
    fun searchEngineDomain(host: String?): String? {
        if (host.isNullOrEmpty()) return null
        return registrableDomain(host).takeIf { it in searchEngineDomains }
    }


    /** True for the scope itself and any subdomain of it, never for `notinstagram.com`. */
    @JvmStatic
    fun contains(scope: String, host: String): Boolean {
        val normalizedHost = host.removeSuffix(".").lowercase()
        val normalizedScope = scope.removeSuffix(".").lowercase()
        if (normalizedScope.isEmpty()) return false
        return normalizedHost == normalizedScope || normalizedHost.endsWith("." + normalizedScope)
    }

    /**
     * Favorite-site links open outside the session. A user-clicked link from any other site stays
     * in this view and adopts the destination; page-initiated cross-site navigations remain popups.
     */
    @JvmStatic
    fun verdict(
        scheme: String?,
        host: String?,
        scope: String,
        settled: Boolean,
        isMainFrame: Boolean,
        searchDomain: String? = null,
        sourceHost: String? = null,
        userGesture: Boolean = false,
        sourceFavorite: Boolean = false,
        navigationPending: Boolean = false,
    ): Verdict {
        return when (scheme?.lowercase()) {
            "about" -> Verdict.ALLOW
            "http", "https" -> {
                if (host.isNullOrEmpty()) {
                    Verdict.CANCEL
                } else if (!isMainFrame || !settled || contains(scope, host)) {
                    Verdict.ALLOW
                } else if (
                    navigationPending ||
                    (!sourceFavorite && (
                        searchDomain?.let { contains(it, host) } == true ||
                        isSearchResultNavigation(scheme, host, sourceHost, searchDomain, userGesture) ||
                        userGesture
                    ))
                ) {
                    Verdict.ALLOW
                } else {
                    Verdict.POPUP
                }
            }
            else -> Verdict.CANCEL
        }
    }

    /** User-initiated web navigation from the original search-engine page. */
    @JvmStatic
    fun isSearchResultNavigation(
        scheme: String?,
        targetHost: String?,
        sourceHost: String?,
        searchDomain: String?,
        userGesture: Boolean,
    ): Boolean {
        val normalizedScheme = scheme?.lowercase()
        if (!userGesture || (normalizedScheme != "http" && normalizedScheme != "https")) return false
        if (targetHost.isNullOrEmpty() || sourceHost.isNullOrEmpty() || searchDomain.isNullOrEmpty()) return false
        return contains(searchDomain, sourceHost)
    }
}
