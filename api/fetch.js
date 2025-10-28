const fetch = require('node-fetch');
const cheerio = require('cheerio');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        console.log(`Invalid method: ${req.method}`);
        return res.status(405).json({ error: 'Only POST allowed' });
    }

    const { url, mode = 'posts' } = req.body;

    function normalizeUrl(u) {
        try {
            return new URL(u).href;
        } catch (e) {
            return null;
        }
    }

    const norm = normalizeUrl(url);
    if (!norm) {
        console.log('Invalid URL:', url);
        return res.status(400).json({ error: 'Invalid URL (must be http/https)' });
    }

    // extractPosts function (unchanged)
    async function extractPosts(html, baseUrl) {
        const $ = cheerio.load(html);
        const results = new Map();

        // RSS/Atom
        $('link[type="application/rss+xml"], link[type="application/atom+xml"]').each((i, el) => {
            const href = $(el).attr("href");
            if (href) {
                const fullHref = new URL(href, baseUrl).href;
                results.set(fullHref, { title: $(el).attr("title") || "RSS/Atom feed", href: fullHref, source: "rss" });
            }
        });

        // Article anchors
        $("article a[href]").each((i, a) => {
            const href = $(a).attr("href");
            const title = $(a).text().trim() || $(a).attr("title") || "";
            if (href) {
                const fullHref = new URL(href, baseUrl).href;
                results.set(fullHref, { title, href: fullHref, source: "article" });
            }
        });

        // JSON-LD
        $('script[type="application/ld+json"]').each((i, s) => {
            try {
                const jsonText = $(s).contents().text().trim();
                if (!jsonText) return;
                const json = JSON.parse(jsonText);
                const items = Array.isArray(json) ? json : [json];
                items.forEach(obj => {
                    if (!obj) return;
                    const type = obj["@type"] || obj.type;
                    if (!type || !/(Article|BlogPosting|NewsArticle)/i.test(type)) return;
                    const urlProp = obj.url || obj.mainEntityOfPage;
                    const title = obj.headline || obj.name || "";
                    if (urlProp) {
                        const fullHref = new URL(urlProp, baseUrl).href;
                        results.set(fullHref, { title, href: fullHref, source: "json-ld" });
                    }
                });
            } catch (e) {
                console.log('JSON-LD error:', e.message);
            }
        });

        // OpenGraph
        const ogUrl = $('meta[property="og:url"]').attr("content");
        const ogTitle = $('meta[property="og:title"]').attr("content");
        if (ogUrl) {
            const fullHref = new URL(ogUrl, baseUrl).href;
            results.set(fullHref, { title: ogTitle || "", href: fullHref, source: "opengraph" });
        });

        // Heuristic links
        $("a[href]").each((i, a) => {
            const href = $(a).attr("href");
            if (!href) return;
            const text = $(a).text().trim();
            const full = new URL(href, baseUrl).href;
            const lc = href.toLowerCase();
            if (/\/(post|posts|article|articles|blog|news|story)\b/.test(lc) ||
                $(a).closest(".post, .entry, .article, .news-item").length > 0 ||
                text.length > 10
            ) {
                if (!results.has(full)) {
                    results.set(full, { title: text || "", href: full, source: "heuristic" });
                }
            }
        });

        return Array.from(results.values()).slice(0, 200);
    }

    // Fixed extractNetworkCalls: Uses separate simple regexes per type
    async function extractNetworkCalls(html, baseUrl, mode) {
        const $ = cheerio.load(html);
        const results = new Set();  // For deduping JSON strings

        // Collect JS codes
        const jsCodes = [];
        $('script:not([src])').each((i, script) => {
            const code = $(script).html() || '';
            if (code.trim()) jsCodes.push(code);
        });
        const jsUrls = [];
        $('script[src]').each((i, script) => {
            const src = $(script).attr('src');
            if (src && jsUrls.length < 5) {
                try {
                    jsUrls.push(new URL(src, baseUrl).href);
                } catch {}
            }
        });
        for (const jsUrl of jsUrls) {
            try {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 5000);
                const jsResp = await fetch(jsUrl, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'StudyProjectBot/1.0' }
                });
                if (jsResp.ok) {
                    jsCodes.push(await jsResp.text());
                }
            } catch (e) {
                console.log(`JS fetch skip: ${jsUrl}`);
            }
        }

        // Get patterns for mode (simple, separate regexes)
        function getPatternsForMode(m) {
            const commonCapture = '["\']([^"\',\\s]+)["\']';  // URL capture group
            return [
                // Axios POST
                { regex: new RegExp(`axios\\.post\\s*\\(\\s*${commonCapture}`, 'gi'), group: 1, method: 'POST' },
                // jQuery POST
                { regex: new RegExp(`\\$\\.post\\s*\\(\\s*${commonCapture}`, 'gi'), group: 1, method: 'POST' },
                // XHR open('POST', url)
                { regex: new RegExp(`open\\s*\\(\\s*["\']?POST["\']?\\s*,\\s*${commonCapture}`, 'gi'), group: 1, method: 'POST' },
                // Fetch with method POST
                { regex: new RegExp(`fetch\\s*\\(\\s*${commonCapture}.*?method\\s*[:=]\\s*["\']?POST["\']?`, 'gi'), group: 1, method: 'POST' },
                // General fetch (for 'fetch' mode)
                { regex: new RegExp(`fetch\\s*\\(\\s*${commonCapture}`, 'gi'), group: 1, method: 'GET' },
                // General XHR open(method, url)
                { regex: new RegExp(`open\\s*\\(\\s*["\']?([A-Z]+)["\']?\\s*,\\s*${commonCapture}`, 'gi'), group: 2, method: '$1' },
                // Axios GET/POST (for all)
                { regex: new RegExp(`axios\\.(?:post|get)\\s*\\(\\s*${commonCapture}`, 'gi'), group: 1, method: 'POST' },  // Assume POST for post, but filter later
                // jQuery get/post
                { regex: new RegExp(`\\$\\.(?:post|get)\\s*\\(\\s*${commonCapture}`, 'gi'), group: 1, method: 'GET' }
            ].filter(p => {
                if (m === 'post') return p.method === 'POST';
                if (m === 'fetch') return p.regex.source.includes('fetch');
                if (m === 'xhr') return p.regex.source.includes('open');
                if (m === 'all-endpoints') return true;
                return false;
            });
        }

        const patterns = getPatternsForMode(mode);
        console.log(`Using ${patterns.length} patterns for mode: ${mode}`);

        // Match loop
        patterns.forEach(({ regex, group, method }) => {
            jsCodes.forEach(code => {
                let match;
                while ((match = regex.exec(code)) !== null) {
                    let endpoint = match[group] || '';
                    let meth = method;
                    if (method === '$1') meth = (match[1] || 'GET').toUpperCase();
                    if (endpoint) {
                        try {
                            if (!endpoint.startsWith('http')) endpoint = new URL(endpoint, baseUrl).href;
                            const context = code.substring(Math.max(0, match.index - 50), match.index + 100).trim();
                            const item = { url: endpoint, method: meth, context };
                            results.add(JSON.stringify(item));  // Dedupe
                        } catch (e) {
                            // Skip bad URLs
                        }
                    }
                }
            });
        });

        // Scripts mode special
        if (mode === 'scripts') {
            $('script[src]').each((i, script) => {
                const src = $(script).attr('src');
                if (src) {
                    try {
                        const fullSrc = new URL(src, baseUrl).href;
                        results.add(JSON.stringify({ url: fullSrc, method: 'SCRIPT', context: 'External JS' }));
                    } catch {}
                }
            });
        }

        return Array.from(results).map(JSON.parse).slice(0, 100);
    }

    try {
        console.log(`Starting ${mode} for ${norm}`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const resp = await fetch(norm, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
                'User-Agent': 'StudyProjectBot/1.0 (+student@example.edu)',
                'Accept': 'text/html,*/*;q=0.9'
            }
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
            return res.status(502).json({ error: `Fetch failed: ${resp.status}`, status: resp.status });
        }

        const html = await resp.text();
        const data = { url: norm };

        if (mode === 'posts') {
            data.items = await extractPosts(html, norm);
            data.found = data.items.length;
        } else {
            data.items = await extractNetworkCalls(html, norm, mode);
            data.count = data.items.length;
        }

        console.log(`Done: ${data.found || data.count || 0} items`);
        res.json(data);
    } catch (err) {
        console.error('Error:', err.message);
        res.status(err.name === 'AbortError' ? 408 : 500).json({ error: 'Error during fetch', details: err.message });
    }
};
