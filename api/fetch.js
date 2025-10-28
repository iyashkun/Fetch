const fetch = require('node-fetch');
const cheerio = require('cheerio');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        console.log('Method not POST:', req.method); // Log
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { url } = req.body;

    // Normalize URL
    function normalizeUrl(u) {
        try {
            return new URL(u).href;
        } catch (e) {
            return null;
        }
    }

    const norm = normalizeUrl(url || "");
    if (!norm) {
        console.log('Invalid URL:', url); // Log
        return res.status(400).json({ error: "Invalid URL – must be http/https" });
    }

    // Extract function (unchanged from before)
    async function extractPosts(html, baseUrl) {
        const $ = cheerio.load(html);
        const results = new Map();

        // 1) RSS / Atom links
        $('link[type="application/rss+xml"], link[type="application/atom+xml"]').each((i, el) => {
            const href = $(el).attr("href");
            if (href) {
                const fullHref = new URL(href, baseUrl).href;
                results.set(fullHref, { title: $(el).attr("title") || "RSS/Atom feed", href: fullHref, source: "rss" });
            }
        });

        // 2) <article> tags -> anchors inside
        $("article").each((i, art) => {
            $(art).find("a[href]").each((j, a) => {
                const href = $(a).attr("href");
                const title = $(a).text().trim() || $(a).attr("title") || "";
                if (href) {
                    const fullHref = new URL(href, baseUrl).href;
                    results.set(fullHref, { title, href: fullHref, source: "article" });
                }
            });
        });

        // 3) JSON-LD scripts
        $('script[type="application/ld+json"]').each((i, s) => {
            try {
                const jsonText = $(s).contents().text();
                const json = JSON.parse(jsonText);
                const items = Array.isArray(json) ? json : [json];
                items.forEach(obj => {
                    if (!obj) return;
                    const type = obj["@type"] || obj.type;
                    if (!type) return;
                    if (/(Article|BlogPosting|NewsArticle)/i.test(type)) {
                        const urlProp = obj.url || obj.mainEntityOfPage || obj.headline;
                        const title = obj.headline || obj.name || "";
                        if (urlProp) {
                            const fullHref = new URL(urlProp, baseUrl).href;
                            results.set(fullHref, { title, href: fullHref, source: "json-ld" });
                        }
                    }
                });
            } catch (e) {
                console.log('JSON-LD parse error:', e.message); // Log
            }
        });

        // 4) OpenGraph
        const ogUrl = $('meta[property="og:url"]').attr("content");
        const ogTitle = $('meta[property="og:title"]').attr("content");
        if (ogUrl) {
            const fullHref = new URL(ogUrl, baseUrl).href;
            results.set(fullHref, { title: ogTitle || "", href: fullHref, source: "opengraph" });
        }

        // 5) Heuristic links
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

    try {
        console.log('Fetching:', norm); // Log start
        // Fetch with timeout (Vercel default 10s, but add headers)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

        const resp = await fetch(norm, { 
            signal: controller.signal,
            redirect: "follow", 
            headers: { 
                "User-Agent": "StudyProjectBot/1.0 (+student@example.edu)",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            } 
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
            console.log('Fetch failed:', resp.status, resp.statusText); // Log
            return res.status(502).json({ error: `Failed to fetch ${norm} (Status: ${resp.status}) – site might block bots or be down.`, status: resp.status });
        }

        const html = await resp.text();
        console.log('HTML fetched, length:', html.length); // Log success
        const items = await extractPosts(html, norm);
        res.status(200).json({ url: norm, items, found: items.length });
    } catch (err) {
        console.error('Full error:', err.message); // Log to Vercel
        if (err.name === 'AbortError') {
            res.status(408).json({ error: "Request timeout – site too slow. Try a faster URL.", details: err.message });
        } else {
            res.status(500).json({ error: "Server error fetching the site", details: err.message });
        }
    }
};
