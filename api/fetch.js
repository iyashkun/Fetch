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

    // Full extractPosts function
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
                (text.length > 10 && !results.has(full))
            ) {
                results.set(full, { title: text || "", href: full, source: "heuristic" });
            }
        });

        return Array.from(results.values()).slice(0, 200);
    }

    // Extract POST endpoints
    async function extractEndpoints(html, baseUrl) {
        const $ = cheerio.load(html);
        const endpointsSet = new Set();

        // Inline scripts
        $('script:not([src])').each((i, script) => {
            const code = $(script).html() || '';
            extractFromCode(code, endpointsSet);
        });

        // External JS (limit 5 for speed)
        const jsUrls = [];
        $('script[src]').each((i, script) => {
            if (jsUrls.length < 5) {
                const src = new URL($(script).attr('src'), baseUrl).href;
                jsUrls.push(src);
            }
        });

        for (const jsUrl of jsUrls) {
            try {
                const jsResp = await fetch(jsUrl, { 
                    headers: { 'User-Agent': 'StudyProjectBot/1.0' },
                    timeout: 5000 
                });
                if (jsResp.ok) {
                    const jsCode = await jsResp.text();
                    extractFromCode(jsCode, endpointsSet);
                }
            } catch (e) {
                // Skip failed JS fetches
            }
        }

        function extractFromCode(code, set) {
            const patterns = [
                /fetch\s*\(\s*["']([^"'\s]+)["']\s*,\s*\{[^}]*method\s*:\s*["']?POST["']?/gi,
                /axios\.post\s*\(\s*["']([^"'\s]+)["']/gi,
                /\$\.post\s*\(\s*["']([^"'\s]+)["']/gi,
                /open\s*\(\s*["']?POST["']?\s*,\s*["']([^"'\s]+)["']/gi
            ];
            patterns.forEach(regex => {
                let match;
                while ((match = regex.exec(code)) !== null) {
                    let endpoint = match[1];
                    if (endpoint.startsWith('/') || endpoint.startsWith('http')) {
                        endpoint = new URL(endpoint, baseUrl).href;
                        const context = code.substring(Math.max(0, match.index - 50), match.index + 100).trim();
                        set.add(JSON.stringify({ url: endpoint, context }));
                    }
                }
            });
        }

        return Array.from(endpointsSet).map(s => JSON.parse(s)).filter(ep => ep.url.startsWith('http')).slice(0, 50);
    }

    try {
        console.log(`Mode: ${mode}, URL: ${norm}`);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 10000);

        const resp = await fetch(norm, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
                'User-Agent': 'StudyProjectBot/1.0 (+student@example.edu)',
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9'
            }
        });

        if (!resp.ok) {
            console.log(`Fetch failed: ${resp.status}`);
            return res.status(502).json({ error: `Site fetch failed: ${resp.status} ${resp.statusText}`, status: resp.status });
        }

        const html = await resp.text();
        const data = { url: norm };

        if (mode === 'posts') {
            data.items = await extractPosts(html, norm);
            data.found = data.items.length;
        } else {
            data.endpoints = await extractEndpoints(html, norm);
        }

        res.json(data);
    } catch (err) {
        console.error('Error:', err);
        const status = err.name === 'AbortError' ? 408 : 500;
        res.status(status).json({ error: err.message, details: err.toString() });
    }
};
