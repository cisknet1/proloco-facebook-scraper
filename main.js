/**
 * ProLoco Facebook Events Scraper — Playwright v3
 * Gestisce eventi come richieste separate nella coda
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, log } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
const {
    fbUrl     = '',
    comune    = '',
    fromDate  = new Date().toISOString().split('T')[0],
    toDate    = new Date(Date.now() + 90 * 864e5).toISOString().split('T')[0],
    maxEvents = 15,
} = input;

if (!fbUrl) { log.error('fbUrl mancante'); await Actor.exit(); }

const cutoffFrom = new Date(fromDate);
const cutoffTo   = new Date(toDate);
const comuneLow  = comune.toLowerCase();
const baseUrl    = fbUrl.replace(/\/$/, '');
const eventsUrl  = baseUrl + '/events/';

log.info(`Scraping: ${baseUrl} | ${comune} | ${fromDate} → ${toDate}`);

const results = {
    fbUrl: baseUrl, comune,
    pageTitle: '', isRelevant: false,
    events: [],
};

function parseDate(str) {
    if (!str) return null;
    try { return new Date(str); } catch { return null; }
}

function isInRange(dateStr) {
    const d = parseDate(dateStr);
    return d ? d >= cutoffFrom && d <= cutoffTo : false;
}

function isPageRelevant(title) {
    if (!title || title === 'Redirecting...') return false;
    const t = title.toLowerCase();
    const keywords = ['pro loco','proloco','comune','municipio','associazione','unpli'];
    const hasKeyword = keywords.some(k => t.includes(k));
    const comuneWords = comuneLow.split(' ').filter(w => w.length > 3);
    const hasComune = comuneWords.length === 0 || comuneWords.some(w => t.includes(w));
    return hasKeyword || hasComune;
}

const proxyConfig = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'IT',
});

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestsPerCrawl: 60,
    requestHandlerTimeoutSecs: 120,
    maxConcurrency: 1,
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox','--disable-dev-shm-usage'],
        },
    },

    async requestHandler({ page, request, crawler: c }) {
        const url = request.url;
        const label = request.label || '';
        log.info(`[${label || 'main'}] ${url}`);

        // Accetta cookie
        try {
            await page.waitForTimeout(1500);
            const btn = page.locator('button:has-text("Accetta"), button:has-text("Accept"), [data-cookiebanner="accept_button"]');
            if (await btn.count() > 0) {
                await btn.first().click();
                await page.waitForTimeout(800);
            }
        } catch {}

        // ── Pagina principale ────────────────────────────────────────────
        if (label === '' || label === 'MAIN') {
            await page.waitForTimeout(2000);
            const ogTitle = await page.$eval(
                'meta[property="og:title"]',
                el => el.content
            ).catch(() => '');
            const title = ogTitle || (await page.title()).replace(' | Facebook','').trim();

            results.pageTitle  = title;
            results.isRelevant = isPageRelevant(title);

            if (!results.isRelevant) {
                log.warning(`Non pertinente: "${title}"`);
                return;
            }
            log.info(`Valida: "${title}" — navigo agli eventi`);

            await page.goto(eventsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            // Scrolla per caricare più eventi
            for (let i = 0; i < 4; i++) {
                await page.evaluate(() => window.scrollBy(0, 600));
                await page.waitForTimeout(800);
            }

            // Estrai link eventi
            const eventLinks = await page.$$eval('a[href]', links => {
                const seen = new Set();
                return links
                    .map(a => a.href)
                    .filter(href => /\/events\/\d+/.test(href))
                    .map(href => {
                        const m = href.match(/\/events\/(\d+)/);
                        return m ? `https://www.facebook.com/events/${m[1]}/` : null;
                    })
                    .filter(Boolean)
                    .filter(u => { if (seen.has(u)) return false; seen.add(u); return true; });
            });

            log.info(`  ${eventLinks.length} link eventi trovati`);

            // Aggiungi eventi alla coda come richieste separate
            for (const evUrl of eventLinks.slice(0, 40)) {
                await c.addRequests([{ url: evUrl, label: 'EVENT' }]);
            }
            return;
        }

        // ── Singolo evento ────────────────────────────────────────────────
        if (label === 'EVENT') {
            if (results.events.length >= maxEvents) return;

            await page.waitForTimeout(2000);

            // Prova prima con meta tags
            let titolo = await page.$eval(
                'meta[property="og:title"]', el => el.content
            ).catch(() => '');

            let dataRaw = await page.$eval(
                'meta[property="event:start_time"]', el => el.content
            ).catch(() => '') || await page.$eval(
                'meta[property="og:event:start_time"]', el => el.content
            ).catch(() => '');

            // Fallback — cerca nel testo della pagina
            if (!dataRaw) {
                // Cerca JSON-LD o script con la data
                dataRaw = await page.evaluate(() => {
                    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                    for (const s of scripts) {
                        try {
                            const data = JSON.parse(s.textContent);
                            if (data.startDate) return data.startDate;
                            if (data['@graph']) {
                                for (const item of data['@graph']) {
                                    if (item.startDate) return item.startDate;
                                }
                            }
                        } catch {}
                    }
                    return '';
                }).catch(() => '');
            }

            const descr = await page.$eval(
                'meta[property="og:description"]', el => el.content
            ).catch(() => '');

            const immagine = await page.$eval(
                'meta[property="og:image"]', el => el.content
            ).catch(() => '');

            if (!titolo) {
                log.info(`  Skip — titolo mancante: ${url}`);
                return;
            }

            if (!dataRaw) {
                log.info(`  Skip — data mancante: ${titolo}`);
                return;
            }

            if (!isInRange(dataRaw)) {
                log.info(`  Skip fuori range: ${titolo} (${dataRaw})`);
                return;
            }

            results.events.push({ url, titolo, data: dataRaw, descr, immagine, comune });
            log.info(`  ✅ Evento: ${titolo} (${dataRaw})`);
        }
    },

    failedRequestHandler({ request, error }) {
        log.warning(`Fallito: ${request.url} — ${error.message}`);
    },
});

await crawler.run([{ url: baseUrl, label: 'MAIN' }]);

log.info(`\n✅ ${comune}: pertinente=${results.isRelevant} | eventi=${results.events.length}`);
results.events.forEach(e => log.info(`   - ${e.titolo} (${e.data})`));

await Dataset.pushData(results);
await Actor.exit();
