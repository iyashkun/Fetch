const fetch = require('node-fetch');
const cheerio = require('cheerio');
const axios = require('axios');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        console.log(`Invalid method: ${req.method} at ${new Date().toISOString()}`);
        return res.status(405).json({ error: 'Only POST requests allowed.' });
    }

    const { url, mode = 'posts' } = req.body;

    function normalizeUrl(u) {
        try {
            if (!u.startsWith('http')) u = 'https://' + u;
            return new URL(u).href;
        } catch (e) {
            return null;
        }
    }

    const norm = normalizeUrl(url);
    if (!norm) {
        return res.status(400).json({ error: 'Invalid URL.' });
    }

    console.log(`v3 Scan: Mode ${mode} on ${norm} at ${new Date().toISOString()}`);

    // extractPosts (unchanged from previous, with score)
    async function extractPosts(html, baseUrl) {
        const $ = cheerio.load(html);
        const results = new Map();
        // ... (same as previous extractPosts code, omitted for brevity – copy from last version)
        // Return sorted by score
        return Array.from(results.values()).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 200);
    }

    // Enhanced extractNetworkCalls (fixed scope, added sitemap/robots)
    async function extractNetworkCalls(html, baseUrl, mode) {
        const $ = cheerio.load(html);
        const results = new Set();

        const commonCapture = '["\']([^"\',\\s]+)["\']';  // Defined here for scope

        // JS Collection (up to 10, staggered)
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

        // Staggered batch fetch
        const concurrency = 3;
        for (let i = 0; i < jsUrls.length; i += concurrency) {
            const batch = jsUrls.slice(i, i + concurrency);
            const batchPromises = batch.map(async (jsUrl, batchIndex) => {
                try {
                    await new Promise(resolve => setTimeout(resolve, batchIndex * 500));  // Stagger
                    const response = await axios.get(jsUrl, {
                        headers: { 'User-Agent': 'ProNetAnalyzer/3.0' },
                        timeout: 4000
                    });
                    return response.data;
                } catch (e) {
                    return '';
                }
            });
            const batchCodes = await Promise.all(batchPromises);
            batchCodes.forEach(code => { if (code.trim()) jsCodes.push(code); });
        }

        // getPatternsForMode (now includes graphql/ws/sitemap inside)
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

            // GraphQL specific
            if (m === 'graphql') {
                patterns.push(
                    { regexStr: `/graphql\\s*${commonCapture}`, flags: 'gi', group: 1, method: 'POST', modeMatch: ['graphql'] },
                    { regexStr: `(query|mutation)\\s*{[^}]+}`, flags: 'gi', group: 0, method: 'GRAPHQL', modeMatch: ['graphql'] }
                );
            }

            // WebSockets
            if (m === 'ws') {
                patterns.push(
                    { regexStr: `(ws|wss):/{2}[^"\',\\s]+`, flags: 'gi', group: 0, method: 'WS', modeMatch: ['ws'] }
                );
            }

            // Sitemap/Robots (fetch external)
            if (m === 'sitemap') {
                try {
                    const sitemapUrl = new URL('/sitemap.xml', baseUrl).href;
                    const sitemapResp = await axios.get(sitemapUrl, { timeout: 5000 });
                    const sitemap$ = cheerio.load(sitemapResp.data);
                    sitemap$('loc').each((i, el) => {
                        const loc = sitemap$(el).text().trim();
                        if (loc) results.add(JSON.stringify({ url: loc, method: 'SITEMAP', context: 'Sitemap entry', score: 0.9 }));
                    });
                } catch (e) {
                    console.log('Sitemap fetch failed');
                }
                return [];
            }

            if (m === 'robots') {
                try {
                    const robotsUrl = new URL('/robots.txt', baseUrl).href;
                    const robotsResp = await axios.get(robotsUrl, { timeout: 5000 });
                    const lines = robotsResp.data.split('\n');
                    lines.forEach(line => {
                        if (line.startsWith('Disallow:') && line.includes('/api/')) {
                            const path = line.split(':')[1].trim();
                            results.add(JSON.stringify({ url: new URL(path, baseUrl).href, method: 'ROBOTS-HIDDEN', context: 'Disallowed path', score: 0.95 }));
                        }
                    });
                } catch (e) {
                    console.log('Robots fetch failed');
                }
                return [];
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
                            // Base64 decode for hidden
                            if (mode === 'hidden' && endpoint.match(/[A-Za-z0-9+/=]{20,}/)) {
                                try {
                                    const decoded = Buffer.from(endpoint, 'base64').toString();
                                    if (decoded.includes('http')) endpoint = decoded;
                                } catch {}
                            }
                            const item = { url: endpoint, method: meth, context, score: 0.7 + (endpoint.includes('/api/') || endpoint.includes('/v') ? 0.3 : 0) };
                            results.add(JSON.stringify(item));
                        } catch (e) {}
                    }
                    regex.lastIndex = match.index + 1;
                }
            });
        });

        // Hidden mode extras (sitemap/robots already handled in getPatternsForMode)
        if (mode === 'hidden') {
            const allText = html + jsCodes.join('\n');
            const hiddenPatterns = [
                /\/api(\/[a-z0-9_-]+){1,6}/gi,
                /\/(internal|debug|beta|staging|v\d+)\/[^"\s]+/gi,
                /serviceWorker\.register\s*\(\s*['"]([^'"]+)['"]\)/gi
            ];
            hiddenPatterns.forEach(pat => {
                let match;
                while ((match = pat.exec(allText)) !== null) {
                    const endpoint = match[1] || match[0];
                    if (endpoint) {
                        try {
                            const full = new URL(endpoint.startsWith('http') ? endpoint : baseUrl + endpoint).href;
                            results.add(JSON.stringify({ url: full, method: 'HIDDEN', context: 'Obfuscated grep', score: 0.95 }));
                        } catch {}
                    }
                }
            });
        }

        // Scripts mode
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

    // Main Try-Catch (enhanced timeout 25s)
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 25000);
        const resp = await fetch(norm, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
                'User-Agent': 'ProNetAnalyzer/3.0 (Study Project)',
                'Accept': 'text/html,*/*;q=0.9'
            }
        });

        if (!resp.ok) return res.status(502).json({ error: `HTTP ${resp.status}: Site issue.` });

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
        console.error(`v3 Error ${mode} ${norm}:`, err.message, err.stack);
        res.status(err.name === 'AbortError' ? 408 : 500).json({ error: 'Scan failed.', details: err.message });
    }
};
