const fetch = require('node-fetch');
const cheerio = require('cheerio');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const beautify = require('js-beautify').js;

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });

    const { url, mode = 'posts', proxy = '' } = req.body;

    function normalizeUrl(u) {
        try {
            if (!u.startsWith('http')) u = 'https://' + u;
            return new URL(u).href;
        } catch (e) {
            return null;
        }
    }

    const norm = normalizeUrl(url);
    if (!norm) return res.status(400).json({ error: 'Invalid URL.' });

    console.log(`v4 Scan: Mode ${mode} on ${norm} (Proxy: ${proxy ? 'Yes' : 'No'}) at ${new Date().toISOString()}`);

    // extractPosts (full implementation)
    async function extractPosts(html, baseUrl) {
        console.log('Extracting posts...');
        const $ = cheerio.load(html);
        const results = new Map();

        // RSS/Atom
        $('link[type="application/rss+xml"], link[type="application/atom+xml"]').each((i, el) => {
            const href = $(el).attr("href");
            if (href) {
                try {
                    const fullHref = new URL(href, baseUrl).href;
                    results.set(fullHref, { 
                        title: $(el).attr("title") || "RSS/Atom feed", 
                        href: fullHref, 
                        source: "rss",
                        score: 0.8
                    });
                } catch (e) {}
            }
        });

        // Article anchors
        $("article a[href]").each((i, a) => {
            const href = $(a).attr("href");
            const title = $(a).text().trim() || $(a).attr("title") || "";
            if (href && title.length > 5) {
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
                } catch (e) {}
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
                    if (urlProp && title) {
                        try {
                            const fullHref = new URL(urlProp, baseUrl).href;
                            results.set(fullHref, { 
                                title, 
                                href: fullHref, 
                                source: "json-ld",
                                score: 1.0
                            });
                        } catch (e) {}
                    }
                });
            } catch (e) {
                console.log('JSON-LD error:', e.message);
            }
        });

        // OpenGraph
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
            } catch (e) {}
        }

        // Heuristic
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

        return Array.from(results.values()).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 200);
    }

    // Puppeteer Setup
    async function launchBrowser(proxyUrl) {
        const browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: true,
            ...(proxyUrl ? { args: [`--proxy-server=${proxyUrl}`] } : {})
        });
        return browser;
    }

    // Dynamic Extraction
    async function extractWithPuppeteer(baseUrl, mode, proxyUrl) {
        const browser = await launchBrowser(proxyUrl);
        const page = await browser.newPage();
        if (proxyUrl) await page.authenticate({ username: 'user', password: 'pass' });  // Mock

        const networkRequests = [];
        page.on('request', req => {
            if (req.url().includes('api') || req.url().includes('graphql') || req.method() === 'POST') {
                networkRequests.push({
                    url: req.url(),
                    method: req.method(),
                    score: req.url().includes('/v') ? 0.9 : 0.7
                });
            }
        });

        await page.goto(baseUrl, { waitUntil: 'networkidle0', timeout: 15000 });
        await page.waitForTimeout(3000);  // Dynamic wait

        const dynamicData = await page.evaluate(() => {
            return window.performance.getEntriesByType('resource').filter(r => r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest');
        });

        await browser.close();

        return [...networkRequests, ...dynamicData.map(d => ({ url: d.name, method: 'DYNAMIC', score: 0.85 }))].slice(0, 50);
    }

    // extractNetworkCalls (full, with all features)
    async function extractNetworkCalls(html, baseUrl, mode) {
        const $ = cheerio.load(html);
        const results = new Set();

        // JS Collection (staggered)
        const jsCodes = [];
        $('script:not([src])').each((i, script) => {
            const code = $(script).html() || '';
            if (code.trim()) jsCodes.push(code);
        });
        const jsUrls = [];
        $('script[src]').each((i, script) => {
            const src = $(script).attr('src');
            if (src && jsUrls.length < 10) {
                try {
                    jsUrls.push(new URL(src, baseUrl).href);
                } catch {}
            }
        });

        const concurrency = 3;
        for (let i = 0; i < jsUrls.length; i += concurrency) {
            const batch = jsUrls.slice(i, i + concurrency);
            const batchPromises = batch.map(async (jsUrl, batchIndex) => {
                try {
                    await new Promise(resolve => setTimeout(resolve, batchIndex * 500));
                    const response = await axios.get(jsUrl, {
                        headers: { 'User-Agent': 'ProNetAnalyzer/4.0' },
                        timeout: 4000,
                        proxy: proxy ? { host: proxy.split(':')[0], port: parseInt(proxy.split(':')[1]) } : false
                    });
                    return response.data;
                } catch (e) {
                    return '';
                }
            });
            const batchCodes = await Promise.all(batchPromises);
            batchCodes.forEach(code => { if (code.trim()) jsCodes.push(code); });
        }

        const commonCapture = '["\']([^"\',\\s]+)["\']';

        function getPatternsForMode(m) {
            const patterns = [
                { regexStr: `axios\\.post\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'POST', modeMatch: ['post', 'all-endpoints', 'hidden', 'graphql'] },
                { regexStr: `axios\\.get\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'GET', modeMatch: ['all-endpoints'] },
                { regexStr: `\\$\\.post\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'POST', modeMatch: ['post', 'all-endpoints', 'hidden'] },
                { regexStr: `\\$\\.get\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'GET', modeMatch: ['all-endpoints'] },
                { regexStr: `fetch\\s*\\(\\s*${commonCapture}.*?method\\s*[:=]\\s*["\']?([A-Z]+)["\']?`, flags: 'gi', group: 1, method: '$1', modeMatch: ['fetch', 'post', 'all-endpoints', 'hidden', 'graphql'] },
                { regexStr: `fetch\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'GET', modeMatch: ['fetch', 'all-endpoints'] },
                { regexStr: `open\\s*\\(\\s*["\']?([A-Z]+)["\']?\\s*,\\s*${commonCapture}`, flags: 'gi', group: 2, method: '$1', modeMatch: ['xhr', 'all-endpoints', 'hidden'] },
                { regexStr: `send\\s*\\(\\s*(?:null|\\{[^}]+\\})?\\)`, flags: 'gi', group: 0, method: 'POST', modeMatch: ['xhr', 'post'] }
            ];

            if (m === 'graphql') {
                patterns.push(
                    { regexStr: `/graphql\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'POST', modeMatch: ['graphql'] },
                    { regexStr: `(query|mutation)\\s*{[^}]+}`, flags: 'gi', group: 0, method: 'GRAPHQL', modeMatch: ['graphql'] }
                );
            }

            if (m === 'ws') {
                patterns.push(
                    { regexStr: `(ws|wss):/{2}[^"\',\\s]+`, flags: 'gi', group: 0, method: 'WS', modeMatch: ['ws'] }
                );
            }

            return patterns.filter(p => p.modeMatch.includes(m));
        }

        let patterns = getPatternsForMode(mode);

        // Apply patterns
        patterns.forEach(({ regexStr, flags, group, method }) => {
            const regex = new RegExp(regexStr, flags);
            jsCodes.forEach(code => {
                let match;
                while ((match = regex.exec(code)) !== null) {
                    let endpoint = match[group] || match[0];
                    let meth = method;
                    if (method === '$1') meth = (match[1] || 'GET').toUpperCase();
                    if (endpoint) {
                        try {
                            if (!endpoint.startsWith('http')) endpoint = new URL(endpoint, baseUrl).href;
                            const context = code.substring(Math.max(0, match.index - 50), match.index + 150).trim();
                            const item = { url: endpoint, method: meth, context, score: 0.7 + (endpoint.includes('/api/') || endpoint.includes('/v') ? 0.3 : 0) };
                            results.add(JSON.stringify(item));
                        } catch (e) {}
                    }
                    regex.lastIndex = match.index + 1;
                }
            });
        });

        // Puppeteer for dynamic
        if (['hidden', 'graphql', 'ws'].includes(mode)) {
            const dynamic = await extractWithPuppeteer(baseUrl, mode, proxy);
            dynamic.forEach(item => results.add(JSON.stringify(item)));
        }

        // Sitemap
        if (mode === 'sitemap') {
            try {
                const sitemapUrl = new URL('/sitemap.xml', baseUrl).href;
                const sitemapResp = await axios.get(sitemapUrl, { timeout: 5000, proxy: proxy ? { host: proxy.split(':')[0], port: parseInt(proxy.split(':')[1]) } : false });
                const sitemap$ = cheerio.load(sitemapResp.data);
                sitemap$('loc').each((i, el) => {
                    const loc = sitemap$(el).text().trim();
                    if (loc) results.add(JSON.stringify({ url: loc, method: 'SITEMAP', context: 'Sitemap', score: 0.9 }));
                });
            } catch (e) {
                console.log('Sitemap error:', e.message);
            }
        }

        // Robots
        if (mode === 'robots') {
            try {
                const robotsUrl = new URL('/robots.txt', baseUrl).href;
                const robotsResp = await axios.get(robotsUrl, { timeout: 5000, proxy: proxy ? { host: proxy.split(':')[0], port: parseInt(proxy.split(':')[1]) } : false });
                const lines = robotsResp.data.split('\n');
                lines.forEach(line => {
                    if (line.startsWith('Disallow:') && line.includes('/api/')) {
                        const path = line.split(':')[1].trim();
                        results.add(JSON.stringify({ url: new URL(path, baseUrl).href, method: 'ROBOTS-HIDDEN', context: 'Disallowed', score: 0.95 }));
                    }
                });
            } catch (e) {
                console.log('Robots error:', e.message);
            }
        }

        // Hidden extras (beautify)
        if (mode === 'hidden') {
            jsCodes.forEach(code => {
                try {
                    const beautified = beautify(code, { indent_size: 2 });
                    patterns.forEach(({ regexStr, flags, group, method }) => {
                        const regex = new RegExp(regexStr, flags);
                        let match;
                        while ((match = regex.exec(beautified)) !== null) {
                            let endpoint = match[group] || match[0];
                            let meth = method;
                            if (method === '$1') meth = (match[1] || 'GET').toUpperCase();
                            if (endpoint) {
                                try {
                                    if (!endpoint.startsWith('http')) endpoint = new URL(endpoint, baseUrl).href;
                                    const context = beautified.substring(Math.max(0, match.index - 50), match.index + 150).trim();
                                    const item = { url: endpoint, method: meth, context, score: 0.8 + (endpoint.includes('/internal') ? 0.2 : 0) };
                                    results.add(JSON.stringify(item));
                                } catch (e) {}
                            }
                            regex.lastIndex = match.index + 1;
                        }
                    });
                } catch (e) {
                    console.log('Beautify error:', e.message);
                }
            });
        }

        // Scripts
        if (mode === 'scripts') {
            $('script[src]').each((i, script) => {
                const src = $(script).attr('src');
                if (src) {
                    try {
                        const fullSrc = new URL(src, baseUrl).href;
                        results.add(JSON.stringify({ url: fullSrc, method: 'SCRIPT', context: 'External', score: 0.5 }));
                    } catch {}
                }
            });
        }

        return Array.from(results).map(s => {
            try { return JSON.parse(s); } catch { return null; }
        }).filter(Boolean).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 150);
    }

    // Main with retry
    async function attemptScan(attempt = 1) {
        try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 30000);
            const resp = await fetch(norm, {
                signal: controller.signal,
                redirect: 'follow',
                headers: {
                    'User-Agent': 'ProNetAnalyzer/4.0 (Study Project)',
                    'Accept': 'text/html,*/*;q=0.9'
                }
            });

            if (!resp.ok && attempt < 3) {
                console.log(`Retry ${attempt}/3 for ${resp.status}`);
                return attemptScan(attempt + 1);
            }

            if (!resp.ok) return res.status(502).json({ error: `HTTP ${resp.status}. Retries exhausted.` });

            const html = await resp.text();
            const data = { url: norm };

            if (mode === 'posts') {
                data.items = await extractPosts(html, norm);
                data.found = data.items.length;
            } else {
                data.items = await extractNetworkCalls(html, norm, mode);
                data.count = data.items.length;
            }

            res.json(data);
        } catch (err) {
            if (attempt < 3) return attemptScan(attempt + 1);
            console.error(`v4 Error ${mode} ${norm}:`, err.message);
            res.status(err.name === 'AbortError' ? 408 : 500).json({ error: 'Extreme scan failed after retries.', details: err.message });
        }
    }

    await attemptScan();
};
