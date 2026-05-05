/**
 * ProLoco Facebook Events Scraper
 * Legge eventi pubblici da pagina Facebook Pro Loco/Comune
 * Filtra per data direttamente in JS — zero sprechi
 * Gli eventi FB sono sempre pubblici, non richiedono login
 *
 * Input:
 *   fbUrl:     URL pagina Facebook
 *   comune:    Nome comune (per validazione pertinenza)
 *   fromDate:  Data minima eventi YYYY-MM-DD (default: oggi)
 *   toDate:    Data massima eventi YYYY-MM-DD (default: oggi + 90gg)
 *   maxEvents: Max eventi da raccogliere (default: 15)
 */

import { Actor } from 'apify';
import { CheerioCrawler, Dataset, log, ProxyConfiguration } from 'crawlee';

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

log.info(`Scraping eventi: ${baseUrl}`);
log.info(`Comune: ${comune} | Dal: ${fromDate} | Al: ${toDate} | Max: ${maxEvents}`);

const results = {
    fbUrl:      baseUrl,
    comune,
    pageTitle:  '',
    isRelevant: false,
    events:     [],
};

// ── Helpers ────────────────────────────────────────────────────────────────
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

// ── Proxy residenziale italiano ────────────────────────────────────────────
const proxyConfig = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'IT',
});

// ── Crawler ────────────────────────────────────────────────────────────────
const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestsPerCrawl: 80,
    requestHandlerTimeoutSecs: 30,
    maxConcurrency: 2,

    async requestHandler({ $, request }) {
        const url = request.url;
        log.info(`Pagina: ${url}`);

        // ── Pagina principale — valida pertinenza ────────────────────────
        if (url === baseUrl || url === baseUrl + '/') {
            const title = $('meta[property="og:title"]').attr('content')
                || $('title').text().replace(' | Facebook', '').trim();
            results.pageTitle  = title;
            results.isRelevant = isPageRelevant(title);
            if (!results.isRelevant) {
                log.warning(`Non pertinente: "${title}" — stop`);
            } else {
                log.info(`Valida: "${title}"`);
            }
            return;
        }

        // ── Lista eventi ─────────────────────────────────────────────────
        if (url === eventsUrl || url.endsWith('/events/')) {
            if (!results.isRelevant) return;
            const eventLinks = new Set();
            $('a[href]').each((_, el) => {
                const href = $(el).attr('href') || '';
                const match = href.match(/\/events\/(\d+)/);
                if (match) {
                    eventLinks.add(`https://www.facebook.com/events/${match[1]}/`);
                }
            });
            log.info(`  ${eventLinks.size} link eventi trovati`);
            for (const evUrl of [...eventLinks].slice(0, 50)) {
                await crawler.addRequests([{ url: evUrl }]);
            }
            return;
        }

        // ── Singolo evento ────────────────────────────────────────────────
        if (/\/events\/\d+/.test(url)) {
            if (!results.isRelevant) return;
            if (results.events.length >= maxEvents) {
                log.info(`  Limite ${maxEvents} eventi raggiunto — skip`);
                return;
            }

            const titolo   = $('meta[property="og:title"]').attr('content') || '';
            const dataRaw  = $('meta[property="event:start_time"]').attr('content')
                          || $('meta[property="og:event:start_time"]').attr('content') || '';
            const descr    = $('meta[property="og:description"]').attr('content') || '';
            const immagine = $('meta[property="og:image"]').attr('content') || '';

            if (!titolo || !dataRaw) {
                log.info(`  Skip — dati mancanti`);
                return;
            }

            // Filtra per range date
            if (!isInRange(dataRaw)) {
                log.info(`  Skip fuori range: ${titolo} (${dataRaw})`);
                return;
            }

            results.events.push({
                url,
                titolo,
                data:    dataRaw,
                descr,
                immagine,
                comune,
            });
            log.info(`  ✅ Evento: ${titolo} (${dataRaw})`);
        }
    },

    failedRequestHandler({ request, error }) {
        log.warning(`Fallito: ${request.url} — ${error.message}`);
    },
});

// Avvia da pagina principale + lista eventi
await crawler.run([
    { url: baseUrl },
    { url: eventsUrl },
]);

log.info(`\n✅ ${comune}: pertinente=${results.isRelevant} | eventi=${results.events.length}`);
if (results.events.length > 0) {
    results.events.forEach(e => log.info(`   - ${e.titolo} (${e.data})`));
}

await Dataset.pushData(results);
await Actor.exit();
