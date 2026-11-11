package surf.openmedia.siteview

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/**
 * Fetches a site's icon from the site itself and returns it as a small PNG `data:` URL.
 *
 * Nothing goes through a third-party icon service; the only host contacted is the page's own, and
 * a redirect that leaves that host is refused. This is the Android twin of
 * `ios/Sources/FaviconFetcher.swift`.
 */
object FaviconFetcher {
    private const val MAX_BYTES = 400_000
    private const val MAX_CANDIDATES = 6
    private const val MAX_REDIRECTS = 5
    private const val MAX_DIMENSION = 4096
    private const val OUTPUT_SIZE = 96

    fun fetch(page: Uri): String? =
        try {
            fetchUnchecked(page)
        } catch (_: Throwable) {
            // An oversized image must cost the icon, not the app.
            null
        }

    private fun fetchUnchecked(page: Uri): String? {
        val scope = DomainScope.registrableDomain(page.host)
        val candidates = LinkedHashSet<String>()
        val html = get(page.toString(), scope)?.toString(Charsets.UTF_8)
        if (html != null) {
            for (link in iconLinks(html, page)) candidates.add(link)
        }
        candidates.add(page.buildUpon().encodedPath("/apple-touch-icon.png").build().toString())
        candidates.add(page.buildUpon().encodedPath("/favicon.ico").build().toString())

        var tried = 0
        for (url in candidates) {
            if (tried >= MAX_CANDIDATES) break
            tried += 1
            val bytes = get(url, scope) ?: continue
            if (bytes.size <= 100) continue
            // Read the size first: a small file can expand to gigabytes when decoded.
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) continue
            if (bounds.outWidth > MAX_DIMENSION || bounds.outHeight > MAX_DIMENSION) continue
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: continue
            val scaled = Bitmap.createScaledBitmap(bitmap, OUTPUT_SIZE, OUTPUT_SIZE, true)
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
            return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }
        return null
    }

    /** Fetches one URL, following only redirects that stay on the page's own domain. */
    private fun get(url: String, scope: String): ByteArray? {
        var current = url
        var redirects = 0
        while (redirects <= MAX_REDIRECTS) {
            val uri = runCatching { Uri.parse(current) }.getOrNull() ?: return null
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            if (DomainScope.registrableDomain(uri.host) != scope) return null

            val connection = (URL(current).openConnection() as HttpURLConnection)
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 8000
                connection.readTimeout = 8000
                connection.requestMethod = "GET"
                connection.setRequestProperty("Accept", "text/html,image/*,*/*")

                val status = connection.responseCode
                if (status in 300..399) {
                    val location = connection.getHeaderField("Location") ?: return null
                    current = runCatching { URI(current).resolve(location).toString() }.getOrNull()
                        ?: return null
                    redirects += 1
                    continue
                }
                if (status != 200) return null

                val buffer = ByteArrayOutputStream()
                val chunk = ByteArray(16 * 1024)
                connection.inputStream.use { stream ->
                    while (true) {
                        val read = stream.read(chunk)
                        if (read <= 0) break
                        buffer.write(chunk, 0, read)
                        if (buffer.size() > MAX_BYTES) return null
                    }
                }
                return buffer.toByteArray()
            } catch (_: Exception) {
                return null
            } finally {
                connection.disconnect()
            }
        }
        return null
    }

    /** `<link rel="...icon..." href="...">` targets, touch icons first (they are larger). */
    private fun iconLinks(html: String, base: Uri): List<String> {
        val tags = Regex("<link\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(html).map { it.value }
        val touch = mutableListOf<String>()
        val plain = mutableListOf<String>()
        for (tag in tags) {
            val rel = attribute("rel", tag)?.lowercase() ?: continue
            if (!rel.contains("icon")) continue
            val href = attribute("href", tag) ?: continue
            val url = runCatching { URI(base.toString()).resolve(href).toString() }.getOrNull()
                ?: continue
            if (rel.contains("apple-touch-icon")) touch.add(url) else plain.add(url)
        }
        return touch + plain
    }

    private fun attribute(name: String, tag: String): String? {
        val match = Regex("\\b" + name + "\\s*=\\s*[\"']([^\"']*)[\"']", RegexOption.IGNORE_CASE)
            .find(tag) ?: return null
        return match.groupValues.getOrNull(1)
    }
}
