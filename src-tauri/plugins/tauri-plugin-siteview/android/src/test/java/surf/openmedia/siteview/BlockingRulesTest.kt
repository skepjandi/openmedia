package surf.openmedia.siteview

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BlockingRulesTest {
    private fun rule(filter: String, type: String = "block", trigger: String = "") =
        """{"trigger":{"url-filter":"$filter"$trigger},"action":{"type":"$type"}}"""

    private fun rules(vararg lists: List<String>): BlockingRules =
        BlockingRules().also { it.loadTexts(lists.map { list -> "[" + list.joinToString(",") + "]" }) }

    private val host = """^[^:]+:(//)?([^/]+\\.)?"""

    @Test
    fun matchingIsCaseInsensitiveLikeWebKit() {
        val blocking = rules(listOf(rule(host + """ads\\.example\\.com/banner""")))
        assertTrue(blocking.blocks("https://ADS.example.com/Banner.PNG", false, "https://site.org/"))
    }

    @Test
    fun aHostWithAWildcardIsStillEvaluated() {
        val blocking = rules(listOf(rule(host + """facebook\\.com.*/impression\\.php""")))
        assertTrue(blocking.blocks("https://www.facebook.com/x/impression.php", false, "https://news.org/"))
        assertTrue(blocking.blocks("https://facebook.com.au/impression.php", false, "https://news.org/"))
        assertFalse(blocking.blocks("https://www.facebook.com/x/other.php", false, "https://news.org/"))
    }

    @Test
    fun domainConditionsReadTheDocumentBeingBrowsedNotTheRequest() {
        val only = rules(listOf(rule(host + """usrfiles\\.com""", trigger = ""","if-domain":["*melophobemusic.com"]""")))
        assertTrue(only.blocks("https://usrfiles.com/a.js", false, "https://melophobemusic.com/"))
        assertFalse(only.blocks("https://usrfiles.com/a.js", false, "https://other.org/"))

        val except = rules(listOf(rule(host + """usrfiles\\.com""", trigger = ""","unless-domain":["*good.org"]""")))
        assertFalse(except.blocks("https://usrfiles.com/a.js", false, "https://www.good.org/"))
        assertTrue(except.blocks("https://usrfiles.com/a.js", false, "https://bad.org/"))
    }

    @Test
    fun anExceptionOnlyCancelsBlocksOfItsOwnList() {
        val block = rule(host + """tracker\\.net/x""")
        val except = rule(host + """tracker\\.net/x""", type = "ignore-previous-rules")
        assertFalse(rules(listOf(block, except)).blocks("https://tracker.net/x", false, "https://a.org/"))
        assertTrue(rules(listOf(block), listOf(except)).blocks("https://tracker.net/x", false, "https://a.org/"))
    }


    @Test
    fun adBlockScriptletsRequireEnabledDocumentStartSupport() {
        val scriptlet = "(function(){})()"
        assertTrue(activeAdBlockScriptlet(scriptlet, enabled = true, documentStartSupported = true) == scriptlet)
        assertTrue(activeAdBlockScriptlet(scriptlet, enabled = false, documentStartSupported = true) == null)
        assertTrue(activeAdBlockScriptlet(scriptlet, enabled = true, documentStartSupported = false) == null)
    }
    @Test
    fun hostIsReadWithoutAndroidsUri() {
        assertTrue(BlockingRules.hostOfUrl("https://user:pw@Example.COM:8080/a?b") == "example.com")
        assertTrue(BlockingRules.pathOfUrl("https://example.com/a/b.js?x=1") == "/a/b.js")
    }
}
