const fetch = require('node-fetch');
const cheerio = require('cheerio');

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST' });

    const { url, mode = 'posts' } = req.body;

    function normalizeUrl(u) {
        try { return new URL(u).href; } catch { return null; }
    }

    const norm = normalizeUrl(url);
    if (!norm) return res.status(400).json({ error: 'Invalid URL' });

    // Existing extractPosts (unchanged)
    async function extractPosts(html, baseUrl) {
        const $ = cheerio.load(html);
        const results = new Map();
        // RSS
        $('link[type="application/rss+xml"], link[type="application/atom+xml"]').each((i, el) => {
            const href = $(el).attr("href");
            if (href) results.set(new URL(href, baseUrl).href, { title: $(el).attr("title") || "RSS", href: new URL(href, baseUrl).href, source: "rss" });
        });
        // Articles
        $("article a[href]").each((i, a) => {
            const href = $(a).attr("href"), title = $(a).text().trim() || "";
            if (href) results.set(new URL(href, baseUrl).href, { title, href: new URL(href, baseUrl).href, source: "article" });
        });
        // JSON-LD
        $('script[type="application/ld+json"]').each((i, s) => {
            try {
                const json = JSON.parse($(s).contents().text().trim());
                const items = Array.isArray(json) ? json : [json];
                items.forEach(obj => {
                    if (obj["@type"] && /(Article|BlogPosting)/i.test(obj["@type"])) {
                        const urlProp = obj.url || obj.mainEntityOfPage, title = obj.headline || "";
                        if (urlProp) results.set(new URL(urlProp, baseUrl).href, { title, href: new URL(urlProp, baseUrl).href, source: "json-ld" });
                    }
                });
            } catch {}
        });
        // OpenGraph
        const ogUrl = $('meta[property="og:url"]').attr("content"), ogTitle = $('meta[property="og:title"]').attr("content");
        if (ogUrl) results.set(new URL(ogUrl, baseUrl).href, { title: ogTitle || "", href: new URL(ogUrl, baseUrl).href, source: "opengraph" });
        // Heuristics
        $("a[href]").each((i, a) => {
            const href = $(a).attr("href"), text = $(a).text().trim(), full = new URL(href, baseUrl).href, lc = href.toLowerCase();
            if (/\/(post|article|blog|news)\b/.test(lc) || text.length > 10) {
                if (!results.has(full)) results.set(full, { title: text, href: full, source: "heuristic" });
            }
        });
        return Array.from(results.values()).slice(0, 200);
    }

    // NEW: Extract Network Calls (for all new modes)
    async function extractNetworkCalls(html, baseUrl, mode) {
        const $ = cheerio.load(html);
        const results = []; // Array for all

        // Get all JS code (inline + external, limit 5)
        const jsCodes = [];
        // Inline
        $('script:not([src])').each((i, script) => jsCodes.push($(script).html() || ''));
        // External
        const jsUrls = [];
        $('script[src]').each((i, script) => {
            if (jsUrls.length < 5) jsUrls.push(new URL($(script).attr('src'), baseUrl).href);
        });
        for (const jsUrl of jsUrls) {
            try {
                const jsResp = await fetch(jsUrl, { headers: { 'User-Agent': 'StudyProjectBot/1.0' } });
                if (jsResp.ok) jsCodes.push(await jsResp.text());
            } catch {}
        }

        // Patterns for different calls
        const patterns = {
            fetch: /fetch\s*\(\s*["']([^"'\s]+)["']\s*(?:,\s*\{[^}]*(?:method\s*:\s*["']?([A-Z]+)["']?[^}]*\})?)?/gi,
            post: /(?:(?:fetch|axios\.post|\$\.post)\s*\(\s*["']([^"'\s]+)["']|open\s*\(\s*"POST"\s*,\s*["']([^"'\s]+)["']/gi,
            xhr: /send\s*\(\s*(?:null|\{[^}]+\})?\s*\)\s*(?:\/\/|\n|;)/gi, // After open('POST/GET', url)
            all: /(?:fetch|axios\.post|\$\.(?:post|get)|open\s*\(\s*["']([A-Z]+)["']\s*,\s*["']([^"'\s]+)["']/gi
        };

        const targetPattern = patterns[mode] || patterns.all;
        let match;
        jsCodes.forEach(code => {
            while ((match = targetPattern.exec(code)) !== null) {
                let endpoint = match[1] || match[2] || '';
                let method = match[2] || 'GET'; // Default GET
                if (endpoint.startsWith('/') || endpoint.startsWith('http')) {
                    endpoint = new URL(endpoint, baseUrl).href;
                    const context = code.substring(Math.max(0, match.index - 50), match.index + 100).trim();
                    // Filter by mode
                    if (mode === 'post' && method !== 'POST') continue;
                    if (mode === 'fetch' && !/fetch\s*\(/.test(code.substring(match.index - 10, match.index + 10))) continue;
                    if (mode === 'xhr' && !/XMLHttpRequest|open\s*\(/.test(context)) continue;
                    results.push({ url: endpoint, method: method.toUpperCase(), context });
                }
            }
        });

        // For 'scripts' mode: Extract <script src>
        if (mode === 'scripts') {
            $('script[src]').each((i, script) => {
                const src = new URL($(script).attr('src'), baseUrl).href;
                results.push({ url: src, type: 'script', context: 'External JS file' });
            });
        }

        // Dedupe & cap
        const unique = [...new Set(results.map(r => JSON.stringify(r)))].map(JSON.parse).slice(0, 100);
        return unique;
    }

    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 15000); // 15s for more JS

        const resp = await fetch(norm, {
            signal: controller.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'StudyProjectBot/1.0 (+student@example.edu)', 'Accept': 'text/html,*/*' }
        });

        if (!resp.ok) return res.status(502).json({ error: `Fetch failed: ${resp.status}`, status: resp.status });

        const html = await resp.text();
        let data = { url: norm };

        if (mode === 'posts') {
            data.items = await extractPosts(html, norm);
            data.found = data.items.length;
        } else {
            data.items = await extractNetworkCalls(html, norm, mode);
            data.count = data.items.length;
        }

        res.json(data);
    } catch (err) {
        console.error('Error:', err);
        res.status(err.name === 'AbortError' ? 408 : 500).json({ error: err.message, details: err.toString() });
    }
};
