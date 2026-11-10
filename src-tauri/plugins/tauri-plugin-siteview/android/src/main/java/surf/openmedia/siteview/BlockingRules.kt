package surf.openmedia.siteview

import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.regex.Pattern

/**
 * Blocks the requests a WebKit content rule list would block.
 *
 * Android's WebView has no content rule list API, so the same rule files the iOS side hands to
 * WebKit are matched here, request by request, from `shouldInterceptRequest`. The rule format is
 * WebKit's: a `url-filter` regular expression plus optional domain, resource-type and load-type
 * conditions, and an action of `block` or `ignore-previous-rules`.
 *
 * The rules arrive ordered the way WebKit expects them: every blocking rule first, then the
 * exceptions. An exception therefore cancels a block, which is what `ignore-previous-rules` means.
 */
class BlockingRules {
    private class Bucket(
        val byHost: Map<String, List<Rule>>,
        val general: List<Rule>,
    ) {
        val isEmpty: Boolean get() = byHost.isEmpty() && general.isEmpty()
    }

    /** Blocking rules and exceptions are kept apart: an exception is only read once a block matched. */
    private class Snapshot(val blocking: Bucket, val exceptions: Bucket) {
        val isEmpty: Boolean get() = blocking.isEmpty
    }

    private inner class Rule(
        val pattern: Pattern,
        /** A literal the URL must contain for the pattern to have any chance of matching. */
        val literal: String?,
        val ifDomains: List<String>?,
        val unlessDomains: List<String>?,
        val resourceTypes: Set<String>?,
        val loadTypes: Set<String>?,
        val blocks: Boolean,
    ) {
        fun matches(url: String, host: String, resourceType: String, firstParty: Boolean): Boolean {
            if (resourceTypes != null && resourceType !in resourceTypes) return false
            if (loadTypes != null) {
                val kind = if (firstParty) "first-party" else "third-party"
                if (kind !in loadTypes) return false
            }
            if (ifDomains != null && ifDomains.none { domainMatches(it, host) }) return false
            if (unlessDomains != null && unlessDomains.any { domainMatches(it, host) }) return false
            if (literal != null && !url.contains(literal)) return false
            return pattern.matcher(url).find()
        }
    }

    @Volatile
    private var snapshot = EMPTY

    /** Reads the rule files and replaces the rules in force. A file that is missing is skipped. */
    fun load(paths: List<String>) {
        val blockHost = HashMap<String, MutableList<Rule>>()
        val blockGeneral = ArrayList<Rule>()
        val exceptHost = HashMap<String, MutableList<Rule>>()
        val exceptGeneral = ArrayList<Rule>()
        for (path in paths) {
            val file = File(path)
            if (!file.isFile) continue
            val text = runCatching { file.readText() }.getOrNull() ?: continue
            for (rule in parse(text)) {
                val host = hostOf(rule.pattern.pattern())
                val (byHost, general) = if (rule.blocks) blockHost to blockGeneral else exceptHost to exceptGeneral
                if (host == null) general.add(rule) else byHost.getOrPut(host) { ArrayList() }.add(rule)
            }
        }
        snapshot = Snapshot(Bucket(blockHost, blockGeneral), Bucket(exceptHost, exceptGeneral))
    }

    fun clear() {
        snapshot = EMPTY
    }

    /** True when the request must not leave the device. */
    fun blocks(url: String, isMainFrame: Boolean, topUrl: String?): Boolean {
        val current = snapshot
        if (current.isEmpty) return false
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return false
        val host = uri.host?.lowercase() ?: return false
        val resourceType = resourceTypeOf(url, isMainFrame)
        val firstParty = isFirstParty(host, topUrl)

        val suffixes = suffixesOf(host)
        fun any(bucket: Bucket): Boolean {
            for (suffix in suffixes) {
                val rules = bucket.byHost[suffix] ?: continue
                if (rules.any { it.matches(url, host, resourceType, firstParty) }) return true
            }
            return bucket.general.any { it.matches(url, host, resourceType, firstParty) }
        }
        return any(current.blocking) && !any(current.exceptions)
    }

    private fun parse(text: String): List<Rule> {
        val array = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        val rules = ArrayList<Rule>()
        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            val action = obj.optJSONObject("action") ?: continue
            val blocks = when (action.optString("type")) {
                "block" -> true
                "ignore-previous-rules" -> false
                else -> continue
            }
            val trigger = obj.optJSONObject("trigger") ?: continue
            val filter = trigger.optString("url-filter")
            if (filter.isEmpty()) continue
            val pattern = runCatching { Pattern.compile(filter) }.getOrNull() ?: continue
            rules.add(
                Rule(
                    pattern = pattern,
                    literal = literalHint(filter),
                    ifDomains = stringList(trigger, "if-domain"),
                    unlessDomains = stringList(trigger, "unless-domain"),
                    resourceTypes = stringList(trigger, "resource-type")?.toSet(),
                    loadTypes = stringList(trigger, "load-type")?.toSet(),
                    blocks = blocks,
                ),
            )
        }
        return rules
    }

    private fun stringList(trigger: JSONObject, key: String): List<String>? {
        val array = trigger.optJSONArray(key) ?: return null
        val out = ArrayList<String>(array.length())
        for (i in 0 until array.length()) {
            val value = array.optString(i)
            if (value.isNotEmpty()) out.add(value)
        }
        return out
    }

    /**
     * WebKit's domain conditions: `*example.org` covers the domain and its subdomains, a plain
     * `example.org` covers only that exact host.
     */
    private fun domainMatches(raw: String, host: String): Boolean {
        return if (raw.startsWith("*")) {
            DomainScope.contains(raw.removePrefix("*"), host)
        } else {
            raw.equals(host, ignoreCase = true)
        }
    }

    /** Every dot-suffix of a host, so a rule for `ads.example.com` is found for `a.ads.example.com`. */
    private fun suffixesOf(host: String): List<String> {
        val labels = host.split(".")
        if (labels.size <= 1) return listOf(host)
        val out = ArrayList<String>(labels.size)
        for (i in labels.indices) out.add(labels.subList(i, labels.size).joinToString("."))
        return out
    }

    private fun isFirstParty(host: String, topUrl: String?): Boolean {
        val topHost = topUrl?.let { runCatching { Uri.parse(it).host }.getOrNull() } ?: return true
        return DomainScope.registrableDomain(host) == DomainScope.registrableDomain(topHost)
    }

    private fun resourceTypeOf(url: String, isMainFrame: Boolean): String {
        if (isMainFrame) return "document"
        val path = runCatching { Uri.parse(url).path }.getOrNull()?.lowercase() ?: return "raw"
        return when {
            path.endsWith(".css") -> "style-sheet"
            path.endsWith(".js") || path.endsWith(".mjs") -> "script"
            path.endsWith(".png") || path.endsWith(".jpg") || path.endsWith(".jpeg") ||
                path.endsWith(".gif") || path.endsWith(".webp") || path.endsWith(".bmp") ||
                path.endsWith(".ico") || path.endsWith(".avif") -> "image"
            path.endsWith(".svg") -> "svg-document"
            path.endsWith(".woff") || path.endsWith(".woff2") || path.endsWith(".ttf") ||
                path.endsWith(".otf") || path.endsWith(".eot") -> "font"
            path.endsWith(".mp4") || path.endsWith(".webm") || path.endsWith(".m4v") ||
                path.endsWith(".mov") || path.endsWith(".mp3") || path.endsWith(".m4a") ||
                path.endsWith(".ogg") || path.endsWith(".wav") || path.endsWith(".flac") -> "media"
            else -> "raw"
        }
    }

    /**
     * The host a host-anchored filter names, or null when the filter is not host-anchored.
     *
     * The converter writes host rules as `^[^:]+:(//)?([^/]+\.)?<host>`, so the host is what
     * follows that prefix up to the first path or wildcard.
     */
    private fun hostOf(filter: String): String? {
        if (!filter.startsWith(HOST_PREFIX)) return null
        val rest = filter.substring(HOST_PREFIX.length)
        val host = StringBuilder()
        var i = 0
        while (i < rest.length) {
            val c = rest[i]
            if (c == '\\') {
                if (i + 1 >= rest.length || rest[i + 1] != '.') return null
                host.append('.')
                i += 2
                continue
            }
            if (c in "/*?()[]{}|^$+") break
            host.append(c)
            i += 1
        }
        val value = host.toString()
        return if (value.contains('.')) value else null
    }

    /**
     * A literal the URL must contain for the filter to match. Only literal runs are used, so a
     * match can never be lost: the run appears verbatim in every string the filter accepts.
     */
    private fun literalHint(filter: String): String? {
        val run = StringBuilder()
        var best: String? = null
        var i = 0
        while (i < filter.length) {
            val c = filter[i]
            if (c == '\\' && i + 1 < filter.length) {
                val next = filter[i + 1]
                if (next == '.' || next == '/' || next == '-' || next == '_' || next == '=' ||
                    next == '?' || next == '&' || next == '%' || next == '+' || next == ',' ||
                    next == ';' || next == ':' || next == '@' || next == '~' || next == '#'
                ) {
                    run.append(next)
                    i += 2
                    continue
                }
                // Any other escape stands for a character of its own, so the run ends here.
                if (run.length >= MIN_LITERAL) best = run.toString()
                run.clear()
                i += 2
                continue
            }
            if (c == '[') {
                if (run.length >= MIN_LITERAL) best = run.toString()
                run.clear()
                val close = filter.indexOf(']', i)
                i = if (close < 0) filter.length else close + 1
                continue
            }
            if (c in ".^$*+?(){}|") {
                if (run.length >= MIN_LITERAL) best = run.toString()
                run.clear()
                i += 1
                continue
            }
            run.append(c)
            i += 1
        }
        if (run.length >= MIN_LITERAL) best = run.toString()
        return best
    }

    private companion object {
        const val HOST_PREFIX = "^[^:]+:(//)?([^/]+\\.)?"
        const val MIN_LITERAL = 4
        val EMPTY = Snapshot(Bucket(emptyMap(), emptyList()), Bucket(emptyMap(), emptyList()))
    }
}
