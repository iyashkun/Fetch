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

    // Existing extractPosts function (unchanged, for 'posts' mode)
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
                const jsonText = $(s).contents().text().trim();
                if (!jsonText) return;
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
                console.log('JSON-LD parse error:', e.message);
            }
        });

        // 4) OpenGraph <meta property="og:url"> and meta og:title
        const ogUrl = $('meta[property="og:url"]').attr("content");
        const ogTitle = $('meta[property="og:title"]').attr("content");
        if (ogUrl) {
            const fullHref = new URL(ogUrl, baseUrl).href;
            results.set(fullHref, { title: ogTitle || "", href: fullHref, source: "opengraph" });
        }

        // 5) Heuristic: collect all <a> that look like post links
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

    // Enhanced extractNetworkCalls for new modes (fixed regexes)
    async function extractNetworkCalls(html, baseUrl, mode) {
        const $ = cheerio.load(html);
        const results = [];

        // Collect JS codes (inline + up to 5 external for speed)
        const jsCodes = [];
        // Inline scripts
        $('script:not([src])').each((i, script) => {
            const code = $(script).html() || '';
            if (code.trim()) jsCodes.push(code);
        });
        // External scripts (limit 5)
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
                    headers: { 'User-Agent': 'StudyProjectBot/1.0 (+student@example.edu)' }
                });
                if (jsResp.ok) {
                    const jsCode = await jsResp.text();
                    jsCodes.push(jsCode);
                }
            } catch (e) {
                console.log(`Failed to fetch JS: ${jsUrl}`, e.message);
            }
        }

        // Fixed regex patterns (balanced groups, tested)
        const patterns = {
            // For 'fetch': Matches fetch(url, {method: 'XXX'})
            fetch: /fetch\s*\(\s*["']([^"'\s,]+)["']\s*(?:,\s*\{[^}]*(?:method\s*:\s*["']?([A-Z]+)["']?[^}]*\})?)?\s*\)/gi,
            // For 'post': Matches POST-specific (fetch/POST, axios.post, $.post, XHR open('POST', url))
            post: /(?:(?:fetch\s*\([^)]*method\s*[:=]\s*["']?POST["']?|\s*axios\.post\s*\(\s*["']([^"'\s,]+)["']|\s*\$\.post\s*\(\s*["']([^"'\s,]+)["']|\s*open\s*\(\s*["']?POST["']?\s*,\s*["']([^"'\s,]+)["']\s*\))?/gi,
            // For 'xhr': Matches XHR open(method, url) + send()
            xhr: /(?:new\s+)?XMLHttpRequest\s*\(\s*\)\s*\.\s*open\s*\(\s*["']?([A-Z]+)["']?\s*,\s*["']([^"'\s,]+)["']\s*\)\s*;\s*(?:\.send\s*\(\s*(?:null|\{[^}]+\})?\s*\))?/gi,
            // For 'all-endpoints': All HTTP calls (fetch, axios, jQuery, XHR)
            'all-endpoints': /(?:(?:fetch|axios\.(?:post|get)| \$\.(?:post|get)|new\s+XMLHttpRequest\s*\(\s*\)\s*\.\s*open)\s*\(\s*["']([^"'\s,]+)["']\s*(?:,\s*\{[^}]*(?:method\s*:\s*["']?([A-Z]+)["']?)?[^}]*\})?\s*\))?/gi,
            // For 'scripts': Just collect <script src> (no regex on JS code)
            scripts: null  // Handled separately below
        };

        let targetPattern = patterns[mode];
        if (!targetPattern && mode !== 'scripts') {
            targetPattern = patterns['all-endpoints'];  // Fallback
        }

        // Process JS codes with regex
        if (targetPattern && mode !== 'scripts') {
            jsCodes.forEach(code => {
                let match;
                while ((match = targetPattern.exec(code)) !== null) {
                    let endpoint = match[1] || match[2] || '';
                    let method = match[2] || 'GET';  // Default to GET
                    if (endpoint) {
                        try {
                            endpoint = new URL(endpoint.startsWith('http') ? endpoint : baseUrl + endpoint).href;
                            const contextStart = Math.max(0, match.index - 50);
                            const context = code.substring(contextStart, match.index + 100).trim();
                            // Mode-specific filters
                            if (mode === 'post' && method.toUpperCase() !== 'POST') continue;
                            if (mode === 'fetch' && !code.substring(match.index - 10, match.index + 5).includes('fetch')) continue;
                            if (mode === 'xhr' && !context.includes('XMLHttpRequest') && !context.includes('open(')) continue;
                            if (!results.find(r => r.url === endpoint)) {  // Dedupe
                                results.push({ url: endpoint, method: method.toUpperCase(), context });
                            }
                        } catch (e) {
                            // Skip invalid URLs
                        }
                    }
                }
            });
        }

        // Special handling for 'scripts' mode: Extract <script src>
        if (mode === 'scripts') {
            $('script[src]').each((i, script) => {
                const src = $(script).attr('src');
                if (src) {
                    try {
                        const fullSrc = new URL(src, baseUrl).href;
                        results.push({ url: fullSrc, method: 'SCRIPT', context: 'External script load' });
                    } catch {}
                }
            });
        }

        // Cap results and return
        return results.slice(0, 100);
    }

    try {
        console.log(`Processing mode: ${mode} for URL: ${norm}`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);  // 15s timeout

        const resp = await fetch(norm, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
                'User-Agent': 'StudyProjectBot/1.0 (+student@example.edu)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
            console.log(`Site fetch failed: ${resp.status} ${resp.statusText}`);
            return res.status(502).json({ error: `Failed to fetch site: ${resp.status} ${resp.statusText}`, status: resp.status });
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

        console.log(`Success: Found ${data.found || data.count || 0} items for mode ${mode}`);
        res.status(200).json(data);
    } catch (err) {
        console.error('Full error details:', err.message, err.stack);
        const statusCode = err.name === 'AbortError' ? 408 : 500;
        res.status(statusCode).json({
            error: err.name === 'AbortError' ? 'Request timeout - site too slow' : 'Server error during fetch/analysis',
            details: err.message
        });
    }
};
