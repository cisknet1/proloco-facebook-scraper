/**
 * ProLoco Facebook Scraper
 * Legge posts E events da una pagina Facebook Pro Loco/Comune
 * Filtra per data e valida che la pagina sia pertinente al comune cercato
 *
 * Input:
 *   fbUrl:    URL pagina Facebook
 *   comune:   Nome comune (per validazione pertinenza)
 *   fromDate: Data minima post/eventi YYYY-MM-DD (default: oggi - 30gg)
 *   toDate:   Data massima eventi YYYY-MM-DD (default: oggi + 90gg)
 *   maxPosts: Max post da raccogliere (default: 20)
 */

import { Actor } from 'apify';
import { CheerioCrawler, Dataset, log } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
const {
    fbUrl    = '',
    comune   = '',
    fromDate = new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0],
    toDate   = new Date(Date.now() + 90 * 864e5).toISOString().split('T')[0],
    maxPosts = 20,
} = input;

if (!fbUrl) {
    log.error('fbUrl mancante');
    await Actor.exit();
}

const cutoffFrom = new Date(fromDate);
const cutoffTo   = new Date(toDate);
const comuneLow  = comune.toLowerCase();

log.info(`Scraping: ${fbUrl}`);
log.info(`Comune: ${comune} | Dal: ${fromDate} | Al: ${toDate}`);

// ── Risultati ──────────────────────────────────────────────────────────────
const results = {
    fbUrl,
    comune,
    pageTitle:  '',
    isRelevant: false,
    posts:      [],
    events:     [],
};

// ── Helpers ────────────────────────────────────────────────────────────────
function parseDate(str) {
    if (!str) return null;
    try { return new Date(str); } catch { return null; }
}

function isInRange(dateStr) {
    const d = parseDate(dateStr);
    if (!d) return false;
    return d >= cutoffFrom && d <= cutoffTo;
}

function isFuture(dateStr) {
    const d = parseDate(dateStr);
    if (!d) return false;
    return d >= new Date();
}

function isPageRelevant(title) {
    const t = title.toLowerCase();
    const keywords = ['pro loco', 'proloco', 'comune', 'municipio', 'associazione'];
    const hasKeyword = keywords.some(k => t.includes(k));
    // Verifica che il titolo contenga almeno una parola del comune
    const comuneWords = comuneLow.split(' ').filter(w => w.length > 3);
    const hasComune = comuneWords.length === 0 || comuneWords.some(w => t.includes(w));
    return hasKeyword || hasComune;
}

// ── Crawler ────────────────────────────────────────────────────────────────
const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 60,
    requestHandlerTimeoutSecs: 30,
    maxConcurrency: 3,

    async requestHandler({ $, request }) {
        const url = request.url;
        log.info(`Pagina: ${url}`);

        // ── Pagina principale — valida pertinenza ────────────────────────
        if (url === fbUrl || url === fbUrl + '/') {
            const title = $('meta[property="og:title"]').attr('content')
                || $('title').text().replace(' | Facebook', '').trim();

            results.pageTitle = title;
            results.isRelevant = isPageRelevant(title);

            if (!results.isRelevant) {
                log.warn(`Pagina non pertinente: "${title}" — stop`);
                return;
            }
            log.info(`Pagina valida: "${title}"`);
            return;
        }

        // ── Pagina /posts/ ────────────────────────────────────────────────
        if (url.includes('/posts/') && !url.includes('/events/')) {
            if (!results.isRelevant) return;
            if (results.posts.length >= maxPosts) return;

            const testo    = $('meta[property="og:description"]').attr('content') || '';
            const dataRaw  = $('meta[property="article:published_time"]').attr('content')
                          || $('meta[property="og:updated_time"]').attr('content') || '';
            const immagine = $('meta[property="og:image"]').attr('content') || '';

            if (!testo || testo.length < 20) return;
            if (dataRaw && !isInRange(dataRaw)) {
                log.info(`  Post fuori range: ${dataRaw}`);
                return;
            }

            results.posts.push({
                url,
                testo,
                data:    dataRaw,
                immagine,
            });
            log.info(`  ✅ Post: ${testo.substring(0, 60)}...`);
            return;
        }

        // ── Pagina /events/ — lista eventi ───────────────────────────────
        if (/\/events\/?$/.test(url) || /\/events\/\?/.test(url)) {
            if (!results.isRelevant) return;
            // Trova link a singoli eventi
            const eventLinks = new Set();
            $('a[href]').each((_, el) => {
                const href = $(el).attr('href') || '';
                const match = href.match(/\/events\/(\d+)/);
                if (match) {
                    const evUrl = `https://www.facebook.com/events/${match[1]}/`;
                    eventLinks.add(evUrl);
                }
            });
            log.info(`  ${eventLinks.size} eventi trovati nella lista`);
            for (const evUrl of [...eventLinks].slice(0, 30)) {
                await crawler.addRequests([{ url: evUrl }]);
            }
            return;
        }

        // ── Singolo evento ────────────────────────────────────────────────
        if (/\/events\/\d+/.test(url)) {
            if (!results.isRelevant) return;

            const titolo   = $('meta[property="og:title"]').attr('content') || '';
            const dataRaw  = $('meta[property="event:start_time"]').attr('content')
                          || $('meta[property="og:event:start_time"]').attr('content') || '';
            const descr    = $('meta[property="og:description"]').attr('content') || '';
            const immagine = $('meta[property="og:image"]').attr('content') || '';

            if (!titolo || !dataRaw) return;
            if (!isFuture(dataRaw)) {
                log.info(`  Skip evento passato: ${titolo} (${dataRaw})`);
                return;
            }

            results.events.push({
                url,
                titolo,
                data:     dataRaw,
                descr,
                immagine,
            });
            log.info(`  ✅ Evento futuro: ${titolo} (${dataRaw})`);
        }
    },

    failedRequestHandler({ request, error }) {
        log.warning(`Fallito: ${request.url} — ${error.message}`);
    },
});

// Avvia da pagina principale + posts + events
const startUrls = [
    { url: fbUrl },
    { url: fbUrl.rstrip?.('/') + '/posts/' || fbUrl + 'posts/' },
    { url: fbUrl.replace(/\/$/, '') + '/events/' },
];

await crawler.run(startUrls);

// Salva risultati
log.info(`\n✅ Risultati per ${comune}:`);
log.info(`   Pagina: ${results.pageTitle} (pertinente: ${results.isRelevant})`);
log.info(`   Posts: ${results.posts.length}`);
log.info(`   Eventi: ${results.events.length}`);

await Dataset.pushData(results);
await Actor.exit();
