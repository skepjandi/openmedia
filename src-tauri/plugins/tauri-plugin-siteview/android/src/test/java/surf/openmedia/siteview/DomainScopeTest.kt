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
    fun verdictRoutesAutomaticCrossDomainNavigationsToPopup() {
        assertEquals(Verdict.ALLOW, verdict("https", "l.instagram.com", "instagram.com"))
        assertEquals(Verdict.POPUP, verdict("https", "evil.io", "instagram.com"))
        assertEquals(Verdict.ALLOW, verdict("https", "evil.io", "instagram.com", mainFrame = false))
    }

    @Test
    fun verdictKeepsUserActivatedExternalLinksInTheWebView() {
        assertEquals(
            Verdict.ALLOW,
            verdict("https", "result.example", "search.example", userInitiated = true),
        )
        assertEquals(
            Verdict.POPUP,
            verdict("https", "result.example", "search.example", userInitiated = false),
        )
    }

    @Test
    fun verdictAllowsTheFirstLoadToFindItsHome() {
        assertEquals(Verdict.ALLOW, verdict("https", "x.com", "twitter.com", settled = false))
        assertEquals(Verdict.POPUP, verdict("https", "x.com", "twitter.com"))
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
        userInitiated: Boolean = false,
    ) = DomainScope.verdict(scheme, host, scope, settled, mainFrame, userInitiated)
}
