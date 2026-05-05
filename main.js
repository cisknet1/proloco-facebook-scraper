/**
 * ProLoco Facebook Events Scraper — Playwright
 * Usa browser reale per vedere eventi caricati via JavaScript
 * Proxy residenziale italiano per bypassare blocchi Facebook
 *
 * Input:
 *   fbUrl:     URL pagina Facebook
 *   comune:    Nome comune
 *   fromDate:  Data minima eventi YYYY-MM-DD (default: oggi)
 *   toDate:    Data massima eventi YYYY-MM-DD (default: oggi + 90gg)
 *   maxEvents: Max eventi da raccogliere (default: 15)
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

if (!fbUrl) {
    log.error('fbUrl mancante');
    await Actor.exit();
}

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

// Proxy residenziale italiano
const proxyConfig = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'IT',
});

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestsPerCrawl: 50,
    requestHandlerTimeoutSecs: 60,
    maxConcurrency: 1,
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
    },

    async requestHandler({ page, request }) {
        const url = request.url;
        log.info(`Pagina: ${url}`);

        // Accetta cookie se appare il banner
        try {
            const cookieBtn = page.locator('[data-cookiebanner="accept_button"], button:has-text("Accetta"), button:has-text("Accept all")');
            if (await cookieBtn.count() > 0) {
                await cookieBtn.first().click();
                await page.waitForTimeout(1000);
                log.info('  Cookie accettati');
            }
        } catch {}

        // ── Pagina principale — valida pertinenza ────────────────────────
        if (url === baseUrl || url === baseUrl + '/') {
            await page.waitForTimeout(2000);
            const title = await page.title();
            const ogTitle = await page.$eval(
                'meta[property="og:title"]',
                el => el.getAttribute('content')
            ).catch(() => '');

            const pageTitle = ogTitle || title.replace(' | Facebook', '').trim();
            results.pageTitle  = pageTitle;
            results.isRelevant = isPageRelevant(pageTitle);

            if (!results.isRelevant) {
                log.warning(`Non pertinente: "${pageTitle}"`);
            } else {
                log.info(`Valida: "${pageTitle}"`);
                // Naviga agli eventi
                await page.goto(eventsUrl, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(3000);

                // Scrolla per caricare più eventi
                for (let i = 0; i < 3; i++) {
                    await page.evaluate(() => window.scrollBy(0, 800));
                    await page.waitForTimeout(1000);
                }

                // Estrai link eventi dalla pagina
                const eventLinks = await page.$$eval('a[href]', links =>
                    links
                        .map(a => a.href)
                        .filter(href => /\/events\/\d+/.test(href))
                        .map(href => {
                            const match = href.match(/\/events\/(\d+)/);
                            return match ? `https://www.facebook.com/events/${match[1]}/` : null;
                        })
                        .filter(Boolean)
                );

                const uniqueLinks = [...new Set(eventLinks)];
                log.info(`  ${uniqueLinks.length} link eventi trovati`);

                // Visita ogni evento e filtra per data
                for (const evUrl of uniqueLinks.slice(0, 40)) {
                    if (results.events.length >= maxEvents) break;

                    try {
                        await page.goto(evUrl, { waitUntil: 'domcontentloaded' });
                        await page.waitForTimeout(1500);

                        const titolo = await page.$eval(
                            'meta[property="og:title"]',
                            el => el.getAttribute('content')
                        ).catch(() => '');

                        const dataRaw = await page.$eval(
                            'meta[property="event:start_time"], meta[property="og:event:start_time"]',
                            el => el.getAttribute('content')
                        ).catch(() => '');

                        const descr = await page.$eval(
                            'meta[property="og:description"]',
                            el => el.getAttribute('content')
                        ).catch(() => '');

                        const immagine = await page.$eval(
                            'meta[property="og:image"]',
                            el => el.getAttribute('content')
                        ).catch(() => '');

                        if (!titolo || !dataRaw) {
                            log.info(`  Skip — dati mancanti: ${evUrl}`);
                            continue;
                        }

                        if (!isInRange(dataRaw)) {
                            log.info(`  Skip fuori range: ${titolo} (${dataRaw})`);
                            continue;
                        }

                        results.events.push({
                            url: evUrl, titolo, data: dataRaw,
                            descr, immagine, comune,
                        });
                        log.info(`  ✅ Evento: ${titolo} (${dataRaw})`);

                    } catch (e) {
                        log.warning(`  Errore evento ${evUrl}: ${e.message}`);
                    }
                }
            }
            return;
        }
    },

    failedRequestHandler({ request, error }) {
        log.warning(`Fallito: ${request.url} — ${error.message}`);
    },
});

// Avvia solo dalla pagina principale
await crawler.run([{ url: baseUrl }]);

log.info(`\n✅ ${comune}: pertinente=${results.isRelevant} | eventi=${results.events.length}`);
results.events.forEach(e => log.info(`   - ${e.titolo} (${e.data})`));

await Dataset.pushData(results);
await Actor.exit();
