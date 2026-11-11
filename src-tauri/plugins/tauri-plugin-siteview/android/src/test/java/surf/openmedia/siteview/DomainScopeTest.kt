package surf.openmedia.siteview

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import surf.openmedia.siteview.DomainScope.Verdict

/** The same cases as `ios/Tests/DomainScopeCheck/main.swift`: the two platforms must agree. */
class DomainScopeTest {
    @Test
    fun registrableDomainDropsSubdomains() {
        assertEquals("instagram.com", DomainScope.registrableDomain("www.instagram.com"))
        assertEquals("youtube.com", DomainScope.registrableDomain("m.youtube.com"))
        assertEquals("x.com", DomainScope.registrableDomain("x.com"))
        assertEquals("example.com", DomainScope.registrableDomain("a.b.c.example.com"))
        assertEquals("reddit.com", DomainScope.registrableDomain("WWW.Reddit.COM"))
    }

    @Test
    fun registrableDomainKeepsCountrySecondLevelLabels() {
        assertEquals("bbc.co.uk", DomainScope.registrableDomain("news.bbc.co.uk"))
        assertEquals("bbc.co.uk", DomainScope.registrableDomain("bbc.co.uk"))
        assertEquals("example.com.au", DomainScope.registrableDomain("shop.example.com.au"))
        assertEquals("foo.co.com", DomainScope.registrableDomain("foo.co.com"))
    }

    @Test
    fun registrableDomainKeepsEachUserOfAHostingSuffixApart() {
        assertEquals("alice.github.io", DomainScope.registrableDomain("www.alice.github.io"))
        assertEquals("foo.com.br", DomainScope.registrableDomain("foo.com.br"))
    }

    @Test
    fun registrableDomainKeepsHostsWithoutARegistrablePart() {
        assertEquals("localhost", DomainScope.registrableDomain("localhost"))
        assertEquals("192.168.1.20", DomainScope.registrableDomain("192.168.1.20"))
        assertEquals("example.com", DomainScope.registrableDomain("example.com."))
        assertEquals("", DomainScope.registrableDomain(null))
    }

    @Test
    fun containsMatchesTheScopeAndItsSubdomainsOnly() {
        assertTrue(DomainScope.contains("example.com", "example.com."))
        assertTrue(DomainScope.contains("instagram.com", "www.instagram.com"))
        assertTrue(DomainScope.contains("instagram.com", "instagram.com"))
        assertFalse(DomainScope.contains("instagram.com", "notinstagram.com"))
        assertFalse(DomainScope.contains("instagram.com", "instagram.com.evil.io"))
        assertFalse(DomainScope.contains("", "instagram.com"))
    }

    @Test
    fun recognizesSearchEngineScopes() {
        assertEquals("duckduckgo.com", DomainScope.searchEngineDomain("duckduckgo.com"))
        assertEquals("google.com", DomainScope.searchEngineDomain("www.google.com"))
        assertEquals("bing.com", DomainScope.searchEngineDomain("www.bing.com"))
        assertEquals("brave.com", DomainScope.searchEngineDomain("search.brave.com"))
        assertEquals("ecosia.org", DomainScope.searchEngineDomain("www.ecosia.org"))
        assertEquals("startpage.com", DomainScope.searchEngineDomain("www.startpage.com"))
        assertEquals("yahoo.com", DomainScope.searchEngineDomain("search.yahoo.com"))
        assertEquals(null, DomainScope.searchEngineDomain("notgoogle.com"))
    }


    @Test
    fun verdictPinsTheMainFrameToItsDomain() {
        assertEquals(Verdict.ALLOW, verdict("https", "l.instagram.com", "instagram.com"))
        assertEquals(Verdict.POPUP, verdict("https", "evil.io", "instagram.com"))
        assertEquals(Verdict.ALLOW, verdict("https", "evil.io", "instagram.com", mainFrame = false))
    }

    @Test
    fun verdictAllowsTheFirstLoadToFindItsHome() {
        assertEquals(Verdict.ALLOW, verdict("https", "x.com", "twitter.com", settled = false))
        assertEquals(Verdict.POPUP, verdict("https", "x.com", "twitter.com"))
    }
    @Test
    fun clickedLinksFromUnfavoritedSitesStayInAppAndFavoriteLinksPopOut() {
        assertEquals(
            Verdict.ALLOW,
            verdict(
                "https", "example.com", "google.com",
                searchDomain = "google.com", sourceHost = "www.google.com", userGesture = true,
            ),
        )
        assertTrue(
            DomainScope.isSearchResultNavigation(
                "https", "google.com", "www.google.com", "google.com", userGesture = true,
            ),
        )
        assertEquals(
            Verdict.POPUP,
            verdict("https", "example.com", "google.com", searchDomain = "google.com", sourceHost = "google.com"),
        )
        assertEquals(
            Verdict.ALLOW,
            verdict("https", "final.example", "tracker.example", navigationPending = true),
        )
        assertEquals(
            Verdict.ALLOW,
            verdict("https", "www.google.com", "example.com", searchDomain = "google.com"),
        )
        assertEquals(
            Verdict.ALLOW,
            verdict("https", "other.example", "example.com", userGesture = true),
        )
        assertEquals(
            Verdict.POPUP,
            verdict("https", "other.example", "example.com", userGesture = true, sourceFavorite = true),
        )
        assertEquals(
            Verdict.POPUP,
            verdict("https", "other.example", "example.com"),
        )
    }
    @Test
    fun searchEngineFavoriteUsesExternalLinkPolicy() {
        assertEquals(
            Verdict.POPUP,
            verdict(
                "https", "example.com", "google.com",
                searchDomain = "google.com", sourceHost = "www.google.com",
                userGesture = true, sourceFavorite = true,
            ),
        )
    }


    @Test
    fun verdictCancelsEverythingButWebAndAboutSchemes() {
        assertEquals(Verdict.ALLOW, verdict("about", null, "a.com"))
        assertEquals(Verdict.CANCEL, verdict("javascript", null, "a.com"))
        assertEquals(Verdict.CANCEL, verdict("tel", null, "a.com"))
        assertEquals(Verdict.CANCEL, verdict("https", null, "a.com"))
    }

    private fun verdict(
        scheme: String?,
        host: String?,
        scope: String,
        settled: Boolean = true,
        mainFrame: Boolean = true,
        searchDomain: String? = null,
        sourceHost: String? = null,
        userGesture: Boolean = false,
        sourceFavorite: Boolean = false,
        navigationPending: Boolean = false,
    ) = DomainScope.verdict(
        scheme, host, scope, settled, mainFrame, searchDomain, sourceHost, userGesture, sourceFavorite, navigationPending,
    )
}
