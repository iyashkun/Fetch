const fetch = require('node-fetch');
const cheerio = require('cheerio');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { url } = req.body;

    // Very small helper: normalize URL
    function normalizeUrl(u) {
        try {
            return new URL(u).href;
        } catch (e) {
            return null;
        }
    }

    const norm = normalizeUrl(url || "");
    if (!norm) return res.status(400).json({ error: "Invalid URL" });

    // Extract links from HTML using heuristics
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

        // 3) JSON-LD scripts with @type Article or BlogPosting
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
                // ignore malformed json
            }
        });

        // 4) OpenGraph <meta property="og:url"> and meta og:title
        const ogUrl = $('meta[property="og:url"]').attr("content");
        const ogTitle = $('meta[property="og:title"]').attr("content");
        if (ogUrl) {
            const fullHref = new URL(ogUrl, baseUrl).href;
            results.set(fullHref, { title: ogTitle || "", href: fullHref, source: "opengraph" });
        }

        // 5) generic: collect all <a> that look like post links (heuristic)
        $("a[href]").each((i, a) => {
            const href = $(a).attr("href");
            if (!href) return;
            const text = $(a).text().trim();
            const full = new URL(href, baseUrl).href;
            const lc = href.toLowerCase();
            if (/\/(post|posts|article|articles|blog|news|story)\b/.test(lc) ||
                $(a).closest(".post, .entry, .article, .news-item").length > 0 ||
                text.length > 10 // likely a title
            ) {
                if (!results.has(full)) {
                    results.set(full, { title: text || "", href: full, source: "heuristic" });
                }
            }
        });

        // return as array
        return Array.from(results.values()).slice(0, 200); // cap to 200
    }

    try {
        // Basic fetch server-side (you can set headers if needed)
        const resp = await fetch(norm, { redirect: "follow", headers: { "User-Agent": "StudyProjectBot/1.0 (+student@example.edu)" } });
        if (!resp.ok) return res.status(502).json({ error: "Failed to fetch target site", status: resp.status });

        const html = await resp.text();
        const items = await extractPosts(html, norm);
        res.status(200).json({ url: norm, items, found: items.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error fetching the site", details: String(err) });
    }
};
