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

    console.log(`v5 Scan: Mode ${mode} on ${norm} (Proxy: ${proxy ? 'Yes' : 'No'}) at ${new Date().toISOString()}`);

    // Classify resource (ported from browser JS)
    function classifyResource(entry) {
        const { url = '', resourceType = '', method = 'GET', mime = '' } = entry;
        if (method === 'OPTIONS') return 'Options';
        if (resourceType === 'XHR' || resourceType === 'Fetch') {
            if (url.match(/api/i) && !url.match(/\.(css|js|png|jpg|gif|woff|ttf|mp4|mp3|wasm|xml|txt|json)$/i)) return 'Hidden APIs';
            return resourceType;
        }
        if (resourceType === 'Document') return 'Doc';
        if (resourceType === 'Stylesheet') return 'CSS';
        if (resourceType === 'Script') return 'JS/Scripts';
        if (resourceType === 'Image') return 'Img';
        if (resourceType === 'Media') return 'Media';
        if (resourceType === 'Font') return 'Font';
        if (resourceType === 'WebSocket') return 'Socket';
        if (url.endsWith('.wasm')) return 'Wasm';
        if (url.includes('/sitemap.xml')) return 'Sitemap';
        if (url.includes('/robots.txt')) return 'Robots.txt';
        if (url.includes('/manifest.json')) return 'Manifest';
        return 'Other';
    }

    // Score calculator
    function calculateScore(item) {
        const { category, url, method } = item;
        let score = 0.5;
        if (['XHR', 'Fetch', 'Hidden APIs'].includes(category)) score += 0.3;
        if (url.includes('/api/') || url.includes('/v') || url.includes('/graphql')) score += 0.2;
        if (method === 'POST' || method === 'PUT' || method === 'DELETE') score += 0.1;
        if (['Sitemap', 'Manifest', 'Robots.txt'].includes(category)) score = 0.9;
        return Math.min(score, 1.0);
    }

    // extractPosts (unchanged, static)
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

    // Puppeteer Setup (updated for proxy)
    async function launchBrowser(proxyStr) {
        let proxyArgs = [];
        if (proxyStr) {
            const proxyServer = proxyStr.startsWith('http') ? proxyStr : `http://${proxyStr}`;
            proxyArgs = [`--proxy-server=${proxyServer}`];
        }
        const browser = await puppeteer.launch({
            args: [...chromium.args, ...proxyArgs],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: true
        });
        return browser;
    }

    // Full Network Scan (integrated browser JS logic + modern Puppeteer)
    async function fullNetworkScan(baseUrl, proxyStr, mode) {
        const browser = await launchBrowser(proxyStr);
        const page = await browser.newPage();
        const allResources = [];
        const perfEntries = [];

        // Handle proxy auth if format user:pass@host:port
        if (proxyStr && proxyStr.includes('@')) {
            const [, authHost] = proxyStr.split('@');
            const [user, pass] = authHost.split(':').slice(0, 2); // simplistic
            if (user && pass) {
                await page.authenticate({ username: user, password: pass });
            }
        }

        // Response listener for full details
        page.on('response', async (response) => {
            const request = response.request();
            const url = response.url();
            const method = request.method();
            const resourceType = request.resourceType();
            const reqHeaders = request.headers();
            const respHeaders = await response.headers();
            const contentType = respHeaders['content-type'] || '';
            const status = response.status();
            const size = parseInt(respHeaders['content-length'] || '0');

            const category = classifyResource({ url, resourceType, method, mime: contentType });

            allResources.push({
                category,
                url,
                method,
                status,
                reqHeaders,
                respHeaders,
                size,
                type: resourceType,
                source: 'dynamic'
            });
        });

        // WebSocket listener
        page.on('websocket', (ws) => {
            allResources.push({
                category: 'Socket',
                url: ws.url(),
                method: 'WS',
                status: 'connected',
                reqHeaders: {},
                respHeaders: {},
                size: 0,
                type: 'WebSocket',
                source: 'dynamic'
            });
        });

        // Goto and wait
        await page.goto(baseUrl, { waitUntil: 'networkidle0', timeout: 15000 });
        await page.waitForTimeout(3000);

        // Perf entries for duration etc.
        const perf = await page.evaluate(() => {
            const entries = performance.getEntriesByType('resource');
            return entries.map(e => ({
                name: e.name,
                initiatorType: e.initiatorType,
                duration: e.duration,
                transferSize: e.transferSize
            }));
        });
        perfEntries.push(...perf);

        // Match perf to resources
        allResources.forEach(res => {
            const p = perfEntries.find(p => p.name === res.url);
            if (p) {
                res.duration = p.duration;
                res.transferSize = p.transferSize;
                res.initiatorType = p.initiatorType;
            }
        });

        // JS extraction for static analysis
        const jsUrls = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('script[src]')).map(s => {
                const src = s.getAttribute('src');
                try {
                    return new URL(src, location.origin).href;
                } catch {
                    return src;
                }
            }).slice(0, 10);
        });

        // Fetch and regex JS (staggered, modern async)
        const staticCalls = [];
        const concurrency = 3;
        for (let i = 0; i < jsUrls.length; i += concurrency) {
            const batch = jsUrls.slice(i, i + concurrency);
            const batchPromises = batch.map(async (jsUrl, idx) => {
                await new Promise(r => setTimeout(r, idx * 500)); // stagger
                try {
                    const proxyObj = proxyStr ? {
                        host: proxyStr.split(':')[0],
                        port: parseInt(proxyStr.split(':')[1] || 8080)
                    } : false;
                    const response = await axios.get(jsUrl, {
                        headers: { 'User-Agent': 'ProNetAnalyzer/5.0' },
                        timeout: 4000,
                        proxy: proxyObj
                    });
                    return response.data;
                } catch (e) {
                    return '';
                }
            });
            const batchCodes = await Promise.all(batchPromises);
            // Regex patterns (modern RegExp with flags)
            const commonCapture = '["\']([^"\',\\s]+)["\']';
            const patterns = [
                { regexStr: `axios\\.post\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'POST' },
                { regexStr: `axios\\.get\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'GET' },
                { regexStr: `\\$\\.post\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'POST' },
                { regexStr: `\\$\\.get\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'GET' },
                { regexStr: `fetch\\s*\\(\\s*${commonCapture}.*?method\\s*[:=]\\s*["\']?([A-Z]+)["\']?`, flags: 'gi', group: 1, method: '$1' },
                { regexStr: `fetch\\s*\\(\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'GET' },
                { regexStr: `open\\s*\\(\\s*["\']?([A-Z]+)["\']?\\s*,\\s*${commonCapture}`, flags: 'gi', group: 2, method: '$1' },
                ...(mode === 'graphql' ? [
                    { regexStr: `/graphql\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'POST' },
                    { regexStr: `(query|mutation)\\s*{[^}]+}`, flags: 'gi', group: 0, method: 'GRAPHQL' }
                ] : []),
                ...(mode === 'ws' ? [
                    { regexStr: `(ws|wss):/{2}[^"\',\\s]+`, flags: 'gi', group: 0, method: 'WS' }
                ] : [])
            ];
            batchCodes.forEach(code => {
                if (!code.trim()) return;
                patterns.forEach(({ regexStr, flags, group, method }) => {
                    const regex = new RegExp(regexStr, flags);
                    let match;
                    while ((match = regex.exec(code)) !== null) {
                        let endpoint = match[group] || match[0];
                        let meth = method;
                        if (method === '$1') meth = (match[1] || 'GET').toUpperCase();
                        if (endpoint) {
                            try {
                                if (!endpoint.startsWith('http')) endpoint = new URL(endpoint, baseUrl).href;
                                const context = code.substring(Math.max(0, match.index - 50), match.index + 150).trim();
                                const item = {
                                    url: endpoint,
                                    method: meth,
                                    context,
                                    category: classifyResource({ url: endpoint, method: meth, resourceType: 'XHR' }),
                                    status: 'static',
                                    reqHeaders: {},
                                    respHeaders: {},
                                    size: 0,
                                    type: 'XHR',
                                    source: 'static-js'
                                };
                                staticCalls.push(item);
                                regex.lastIndex = match.index + 1;
                            } catch (e) {}
                        }
                    }
                });
                // Beautify for hidden mode
                if (mode === 'hidden') {
                    try {
                        const beautified = beautify(code, { indent_size: 2 });
                        // Re-apply patterns on beautified
                        patterns.forEach(({ regexStr, flags, group, method }) => {
                            const regex = new RegExp(regexStr, flags);
                            let match;
                            while ((match = regex.exec(beautified)) !== null) {
                                // Similar logic as above, add with higher score
                                let endpoint = match[group] || match[0];
                                let meth = method;
                                if (method === '$1') meth = (match[1] || 'GET').toUpperCase();
                                if (endpoint && !staticCalls.some(s => s.url === endpoint)) {
                                    try {
                                        if (!endpoint.startsWith('http')) endpoint = new URL(endpoint, baseUrl).href;
                                        const context = beautified.substring(Math.max(0, match.index - 50), match.index + 150).trim();
                                        staticCalls.push({
                                            url: endpoint,
                                            method: meth,
                                            context,
                                            category: classifyResource({ url: endpoint, method: meth, resourceType: 'XHR' }),
                                            status: 'static-beautified',
                                            reqHeaders: {},
                                            respHeaders: {},
                                            size: 0,
                                            type: 'XHR',
                                            source: 'static-js-beautified'
                                        });
                                    } catch (e) {}
                                }
                                regex.lastIndex = match.index + 1;
                            }
                        });
                    } catch (e) {
                        console.log('Beautify error:', e.message);
                    }
                }
            });
        }

        // Special files (always fetch server-side)
        const special = [
            { path: '/sitemap.xml', cat: 'Sitemap' },
            { path: '/robots.txt', cat: 'Robots.txt' },
            { path: '/manifest.json', cat: 'Manifest' }
        ];
        const proxyObj = proxyStr ? {
            host: proxyStr.split(':')[0],
            port: parseInt(proxyStr.split(':')[1] || 8080)
        } : false;
        for (const sp of special) {
            try {
                const spUrl = new URL(sp.path, baseUrl).href;
                const resp = await axios.get(spUrl, { timeout: 5000, proxy: proxyObj });
                allResources.push({
                    category: sp.cat,
                    url: spUrl,
                    method: 'GET',
                    status: resp.status,
                    reqHeaders: {},
                    respHeaders: resp.headers,
                    size: parseInt(resp.headers['content-length'] || '0'),
                    type: 'fetch',
                    source: 'special'
                });
            } catch (e) {
                console.log(`Special fetch error ${sp.path}:`, e.message);
            }
        }

        // Page info
        const pageInfo = await page.evaluate(() => {
            const nav = performance.getEntriesByType('navigation')[0] || {};
            return {
                title: document.title,
                status: nav.responseStatus || 200,
                loadTime: performance.timing ? performance.timing.loadEventEnd - performance.timing.navigationStart : 0,
                memoryUsage: performance.memory ? {
                    usedJSHeapSize: performance.memory.usedJSHeapSize,
                    totalJSHeapSize: performance.memory.totalJSHeapSize,
                    jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
                } : null
            };
        });

        await browser.close();

        // Combine
        allResources.push(...staticCalls);
        return { allResources, pageInfo };
    }

    // Main with retry (modern AbortController)
    async function attemptScan(attempt = 1) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 45000); // Increased for Puppeteer
            const data = { url: norm };

            if (mode === 'posts') {
                const resp = await fetch(norm, {
                    signal: controller.signal,
                    redirect: 'follow',
                    headers: {
                        'User-Agent': 'ProNetAnalyzer/5.0 (Study Project)',
                        'Accept': 'text/html,*/*;q=0.9'
                    }
                });
                clearTimeout(timeoutId);
                if (!resp.ok && attempt < 3) {
                    console.log(`Retry ${attempt}/3 for ${resp.status}`);
                    return attemptScan(attempt + 1);
                }
                if (!resp.ok) return res.status(502).json({ error: `HTTP ${resp.status}. Retries exhausted.` });
                const html = await resp.text();
                data.items = await extractPosts(html, norm);
                data.found = data.items.length;
            } else {
                const { allResources, pageInfo } = await fullNetworkScan(norm, proxy, mode);
                clearTimeout(timeoutId);
                // Filter by mode - Updated with all new categories
                let filtered = allResources;
                switch (mode) {
                    case 'fetch': filtered = filtered.filter(r => r.type === 'Fetch'); break;
                    case 'xhr': filtered = filtered.filter(r => r.type === 'XHR'); break;
                    case 'post': filtered = filtered.filter(r => r.method === 'POST'); break;
                    case 'hidden': filtered = filtered.filter(r => r.category === 'Hidden APIs'); break;
                    case 'graphql': filtered = filtered.filter(r => r.url.includes('graphql')); break;
                    case 'ws': filtered = filtered.filter(r => r.category === 'Socket'); break;
                    case 'sitemap': filtered = filtered.filter(r => r.category === 'Sitemap'); break;
                    case 'robots': filtered = filtered.filter(r => r.category === 'Robots.txt'); break;
                    case 'scripts': filtered = filtered.filter(r => r.category === 'JS/Scripts'); break;
                    case 'doc': filtered = filtered.filter(r => r.category === 'Doc'); break;
                    case 'css': filtered = filtered.filter(r => r.category === 'CSS'); break;
                    case 'js': filtered = filtered.filter(r => r.category === 'JS/Scripts'); break; // Alias for Scripts
                    case 'font': filtered = filtered.filter(r => r.category === 'Font'); break;
                    case 'img': filtered = filtered.filter(r => r.category === 'Img'); break;
                    case 'media': filtered = filtered.filter(r => r.category === 'Media'); break;
                    case 'manifest': filtered = filtered.filter(r => r.category === 'Manifest'); break;
                    case 'wasm': filtered = filtered.filter(r => r.category === 'Wasm'); break;
                    case 'options': filtered = filtered.filter(r => r.category === 'Options'); break;
                    case 'all-endpoints':
                        filtered = filtered.filter(r => ['XHR', 'Fetch'].includes(r.type) || r.url.includes('api') || r.url.includes('/v'));
                        break;
                    case 'browser': // Full modern scan
                    case 'full':
                    case 'all':
                        // All categories
                        break;
                    default:
                        filtered = filtered.filter(r => ['XHR', 'Fetch', 'Hidden APIs', 'Socket'].includes(r.category));
                }
                data.items = filtered.map(item => ({ ...item, score: calculateScore(item) }))
                    .sort((a, b) => (b.score || 0) - (a.score || 0))
                    .slice(0, 200);
                data.count = data.items.length;
                data.pageInfo = pageInfo;
            }

            res.json(data);
        } catch (err) {
            clearTimeout(timeoutId);
            if (attempt < 3) return attemptScan(attempt + 1);
            console.error(`v5 Error ${mode} ${norm}:`, err.message);
            res.status(err.name === 'AbortError' ? 408 : 500).json({ error: 'Scan failed after retries.', details: err.message });
        }
    }

    await attemptScan();
};
