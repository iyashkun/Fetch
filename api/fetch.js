const fetch = require('node-fetch');
const cheerio = require('cheerio');
const axios = require('axios');  // For better HTTP handling

module.exports = async (req, res) => {
    // Input validation and method check
    if (req.method !== 'POST') {
        console.log(`Invalid method: ${req.method} at ${new Date().toISOString()}`);
        return res.status(405).json({ error: 'Only POST requests are allowed for security.' });
    }

    const { url, mode = 'posts' } = req.body;

    // Normalize URL function with protocol enforcement
    function normalizeUrl(u) {
        try {
            if (!u.startsWith('http')) u = 'https://' + u;
            return new URL(u).href;
        } catch (e) {
            console.log(`URL normalization failed for: ${u}`, e.message);
            return null;
        }
    }

    const norm = normalizeUrl(url);
    if (!norm) {
        console.log('Invalid URL provided:', url);
        return res.status(400).json({ error: 'Invalid URL. Must be a valid http/https address.' });
    }

    console.log(`Starting analysis for mode: ${mode} on URL: ${norm} at ${new Date().toISOString()}`);

    // Core extraction for posts (unchanged, but with more logging)
    async function extractPosts(html, baseUrl) {
        console.log('Extracting posts...');
        const $ = cheerio.load(html);
        const results = new Map();  // Use Map for easy deduping by URL

        // Step 1: RSS/Atom feeds - Common for blogs/news
        console.log('Scanning RSS/Atom links...');
        $('link[type="application/rss+xml"], link[type="application/atom+xml"]').each((i, el) => {
            const href = $(el).attr("href");
            if (href) {
                try {
                    const fullHref = new URL(href, baseUrl).href;
                    results.set(fullHref, { 
                        title: $(el).attr("title") || "RSS/Atom feed", 
                        href: fullHref, 
                        source: "rss",
                        score: 0.8  // High confidence for feeds
                    });
                } catch (e) {
                    console.log(`RSS link invalid: ${href}`);
                }
            }
        });

        // Step 2: Article tags - Semantic HTML for posts
        console.log('Scanning article tags...');
        $("article").each((i, art) => {
            $(art).find("a[href]").each((j, a) => {
                const href = $(a).attr("href");
                const title = $(a).text().trim() || $(a).attr("title") || "";
                if (href && title.length > 5) {  // Filter short links
                    try {
                        const fullHref = new URL(href, baseUrl).href;
                        if (!results.has(fullHref)) {
                            results.set(fullHref, { 
                                title, 
                                href: fullHref, 
                                source: "article",
                                score: 0.9
                            });
                        }
                    } catch (e) {
                        // Skip relative/invalid
                    }
                }
            });
        });

        // Step 3: JSON-LD structured data (SEO goldmine for hidden articles)
        console.log('Parsing JSON-LD...');
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
                    if (urlProp && title) {
                        try {
                            const fullHref = new URL(urlProp, baseUrl).href;
                            results.set(fullHref, { 
                                title, 
                                href: fullHref, 
                                source: "json-ld",
                                score: 1.0  // Highest confidence
                            });
                        } catch (e) {}
                    }
                });
            } catch (e) {
                console.log('JSON-LD parsing error:', e.message);
            }
        });

        // Step 4: OpenGraph meta (social sharing endpoints)
        console.log('Extracting OpenGraph...');
        const ogUrl = $('meta[property="og:url"]').attr("content");
        const ogTitle = $('meta[property="og:title"]').attr("content");
        if (ogUrl && ogTitle) {
            try {
                const fullHref = new URL(ogUrl, baseUrl).href;
                results.set(fullHref, { 
                    title: ogTitle, 
                    href: fullHref, 
                    source: "opengraph",
                    score: 0.7
                });
            } catch (e) {
                console.log('OpenGraph URL invalid');
            }
        }

        // Step 5: Heuristic link detection (patterns for hidden posts)
        console.log('Applying heuristics...');
        $("a[href]").each((i, a) => {
            const href = $(a).attr("href");
            if (!href) return;
            const text = $(a).text().trim();
            const full = new URL(href, baseUrl).href;
            const lc = href.toLowerCase();
            if (/\/(post|posts|article|articles|blog|news|story)\b/.test(lc) ||
                $(a).closest(".post, .entry, .article, .news-item").length > 0 ||
                (text.length > 10 && text.match(/^(read|view|learn)/i))
            ) {
                if (!results.has(full)) {
                    results.set(full, { 
                        title: text || "Heuristic Link", 
                        href: full, 
                        source: "heuristic",
                        score: 0.6
                    });
                }
            }
        });

        const extracted = Array.from(results.values()).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 200);
        console.log(`Extracted ${extracted.length} posts`);
        return extracted;
    }

    // Advanced Network Calls Extraction (expanded for all modes)
    async function extractNetworkCalls(html, baseUrl, mode) {
        console.log(`Extracting network calls for mode: ${mode}`);
        const $ = cheerio.load(html);
        const results = new Set();  // Dedupe via JSON string

        // Collect JS sources (inline + external, now up to 10 for deeper analysis)
        const jsCodes = [];
        console.log('Collecting inline JS...');
        $('script:not([src])').each((i, script) => {
            const code = $(script).html() || '';
            if (code.trim().length > 10) jsCodes.push(code);  // Skip empty
        });

        console.log('Fetching external JS (up to 10)...');
        const jsUrls = [];
        $('script[src]').each((i, script) => {
            const src = $(script).attr('src');
            if (src && jsUrls.length < 10) {
                try {
                    jsUrls.push(new URL(src, baseUrl).href);
                } catch {}
            }
        });

        // Batch fetch external JS with axios for better error handling
        const fetchPromises = jsUrls.map(async (jsUrl, index) => {
            try {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 3000 + (index * 500));  // Staggered timeout
                const response = await axios.get(jsUrl, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'ProNetAnalyzer/2.0 (+studyproject.edu)' },
                    timeout: 5000
                });
                return response.data;
            } catch (e) {
                console.log(`External JS fetch failed (${index + 1}/10): ${jsUrl}`, e.message);
                return '';  // Empty string on fail
            }
        });

        const externalCodes = await Promise.all(fetchPromises);
        externalCodes.forEach(code => {
            if (code.trim()) jsCodes.push(code);
        });

        console.log(`Analyzing ${jsCodes.length} JS files...`);

        // Patterns function: Separate simple regexes for reliability
        function getPatternsForMode(m) {
            const commonCapture = '["\']([^"\',\\s]+)["\']';  // Safe URL group
            const basePatterns = [
                // Axios variants
                { regexStr: `axios\\.post\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'POST', modeMatch: ['post', 'all-endpoints', 'hidden'] },
                { regexStr: `axios\\.get\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'GET', modeMatch: ['all-endpoints'] },
                // jQuery AJAX
                { regexStr: `\\$\\.post\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'POST', modeMatch: ['post', 'all-endpoints', 'hidden'] },
                { regexStr: `\\$\\.get\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'GET', modeMatch: ['all-endpoints'] },
                // Fetch API
                { regexStr: `fetch\\s*\\(\\s*${commonCapture}.*?method\\s*[:=]\\s*["\']?([A-Z]+)["\']?`, flags: 'gi', group: 1, method: '$1', modeMatch: ['fetch', 'post', 'all-endpoints', 'hidden'] },
                { regexStr: `fetch\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'GET', modeMatch: ['fetch', 'all-endpoints'] },
                // XHR
                { regexStr: `open\\s*\\(\\s*["\']?([A-Z]+)["\']?\\s*,\\s*${commonCapture}`, flags: 'gi', group: 2, method: '$1', modeMatch: ['xhr', 'all-endpoints', 'hidden'] },
                { regexStr: `send\\s*\\(\\s*(?:null|\\{[^}]+\\})?\\)`, flags: 'gi', group: 0, method: 'POST', modeMatch: ['xhr', 'post'] }  // After open
            ];

            // Filter for mode
            return basePatterns.filter(p => p.modeMatch.includes(m));
        }

        let patterns = getPatternsForMode(mode);
        if (mode === 'graphql') {
            // GraphQL specific: Look for /graphql, query/mutation strings
            patterns = patterns.concat([
                { regexStr: `/graphql\\s*["\']?${commonCapture}["\']?`, flags: 'gi', group: 1, method: 'POST', modeMatch: ['graphql'] },
                { regexStr: `query\\s*{[^}]+}|mutation\\s*{[^}]+}`, flags: 'gi', group: 0, method: 'GRAPHQL', modeMatch: ['graphql'] }
            ]);
        } else if (mode === 'ws') {
            // WebSockets: ws:// or wss:// patterns
            patterns = [{ regexStr: `(ws|wss)://[^"\',\\s]+`, flags: 'gi', group: 0, method: 'WS', modeMatch: ['ws'] }];
        }

        // Apply patterns to JS codes
        patterns.forEach(({ regexStr, flags, group, method }) => {
            const regex = new RegExp(regexStr, flags);
            jsCodes.forEach((code, codeIndex) => {
                let match;
                while ((match = regex.exec(code)) !== null) {
                    let endpoint = match[group] || match[0];
                    let meth = method;
                    if (method === '$1') meth = (match[1] || 'GET').toUpperCase();
                    if (endpoint && (endpoint.includes('http') || endpoint.startsWith('/'))) {
                        try {
                            if (!endpoint.startsWith('http')) endpoint = new URL(endpoint, baseUrl).href;
                            const context = code.substring(Math.max(0, match.index - 50), match.index + 150).trim();
                            const item = { 
                                url: endpoint, 
                                method: meth, 
                                context,
                                score: 0.8 + (endpoint.includes('/api/') ? 0.2 : 0)  // Boost API paths
                            };
                            results.add(JSON.stringify(item));
                        } catch (e) {
                            console.log(`Invalid endpoint skipped: ${endpoint}`);
                        }
                    }
                    // Prevent infinite loop on greedy regex
                    regex.lastIndex = match.index + 1;
                }
            });
        });

        // Special for 'hidden' mode: Grep for hidden patterns in all text
        if (mode === 'hidden') {
            console.log('Pro: Hunting hidden APIs...');
            const allText = html + jsCodes.join('\n');
            const hiddenPatterns = [
                /\/api(\/[a-z0-9]+){1,5}/gi,  // /api/v1/users etc.
                /\/(admin|internal|debug|graphql|beta)\/[^"\s]+/gi,
                /wss?:\/\/[^"\s]+/gi,  // WS hidden
                /serviceWorker\.register\(['"]([^'"]+)['"]\)/gi  // Service worker caches
            ];
            hiddenPatterns.forEach(pat => {
                let match;
                while ((match = pat.exec(allText)) !== null) {
                    const endpoint = match[1] || match[0];
                    if (endpoint) {
                        try {
                            const full = new URL(endpoint.startsWith('http') ? endpoint : baseUrl + endpoint).href;
                            results.add(JSON.stringify({ url: full, method: 'HIDDEN', context: 'Grep match', score: 0.95 }));
                        } catch {}
                    }
                }
            });

            // Fetch manifest.json for PWA hidden endpoints
            try {
                const manifestLink = $('link[rel="manifest"]').attr('href');
                if (manifestLink) {
                    const manifestUrl = new URL(manifestLink, baseUrl).href;
                    const manifestResp = await axios.get(manifestUrl, { timeout: 5000 });
                    const manifest = JSON.parse(manifestResp.data);
                    if (manifest.start_url || manifest.scope) {
                        const hiddenPath = manifest.start_url || manifest.scope;
                        results.add(JSON.stringify({ url: new URL(hiddenPath, baseUrl).href, method: 'PWA-HIDDEN', context: 'Manifest.json', score: 0.9 }));
                    }
                }
            } catch (e) {
                console.log('Manifest fetch failed:', e.message);
            }
        }

        // For scripts mode: Just src attributes
        if (mode === 'scripts') {
            console.log('Extracting scripts...');
            $('script[src]').each((i, script) => {
                const src = $(script).attr('src');
                if (src) {
                    try {
                        const fullSrc = new URL(src, baseUrl).href;
                        results.add(JSON.stringify({ url: fullSrc, method: 'SCRIPT', context: 'External load', score: 0.5 }));
                    } catch {}
                }
            });
        }

        const extracted = Array.from(results).map(JSON.parse)
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, 100);  // Cap for performance
        console.log(`Extracted ${extracted.length} network items for ${mode}`);
        return extracted;
    }

    // Main execution with timeout and error wrapping
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
            console.log('Global timeout triggered');
        }, 20000);  // 20s for pro modes

        const resp = await fetch(norm, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
                'User-Agent': 'ProNetAnalyzer/2.0 (Study Project - student@example.edu)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            }
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
            console.log(`HTTP error: ${resp.status} for ${norm}`);
            return res.status(502).json({ 
                error: `Site unreachable: ${resp.status} ${resp.statusText}. May be blocked or down.`, 
                status: resp.status 
            });
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

        // Cache results in memory (for demo, in prod use Redis)
        console.log(`Analysis complete: ${data.found || data.count || 0} results at ${new Date().toISOString()}`);
        res.status(200).json(data);
    } catch (err) {
        console.error(`Full error trace for ${mode} on ${norm}:`, err.message, err.stack);
        const statusCode = err.name === 'AbortError' ? 408 : (err.name === 'TypeError' ? 400 : 500);
        res.status(statusCode).json({ 
            error: err.name === 'AbortError' ? 'Timeout: Site too complex/slow. Try simpler URL.' : 'Analysis error occurred.',
            details: err.message 
        });
    }
};
