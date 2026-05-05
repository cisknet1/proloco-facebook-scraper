/**
 * ProLoco Facebook Scraper v2
 * Usa proxy residenziali Apify per bypassare il redirect di Facebook
 */

import { Actor } from 'apify';
import { CheerioCrawler, Dataset, log, ProxyConfiguration } from 'crawlee';

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
const baseUrl    = fbUrl.replace(/\/$/, '');
const postsUrl   = baseUrl + '/posts/';
const eventsUrl  = baseUrl + '/events/';

log.info(`Scraping: ${baseUrl} | Comune: ${comune} | Dal: ${fromDate} | Al: ${toDate}`);

const results = {
    fbUrl: baseUrl, comune,
    pageTitle: '', isRelevant: false,
    posts: [], events: [],
};

function parseDate(str) {
    if (!str) return null;
    try { return new Date(str); } catch { return null; }
}

function isInRange(dateStr) {
    const d = parseDate(dateStr);
    return d ? d >= cutoffFrom && d <= cutoffTo : false;
}

function isFuture(dateStr) {
    const d = parseDate(dateStr);
    return d ? d >= new Date() : false;
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

// Proxy residenziale Apify — necessario per Facebook
const proxyConfig = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'IT',
});

const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestsPerCrawl: 60,
    requestHandlerTimeoutSecs: 30,
    maxConcurrency: 2,

    async requestHandler({ $, request }) {
        const url = request.url;
        log.info(`Pagina: ${url}`);

        // Pagina principale
        if (url === baseUrl || url === baseUrl + '/') {
            const title = $('meta[property="og:title"]').attr('content')
                || $('title').text().replace(' | Facebook', '').trim();
            results.pageTitle  = title;
            results.isRelevant = isPageRelevant(title);
            if (!results.isRelevant) {
                log.warning(`Non pertinente: "${title}"`);
            } else {
                log.info(`Valida: "${title}"`);
            }
            return;
        }

        // Posts
        if (url.includes('/posts/') && !url.includes('/events/')) {
            if (!results.isRelevant || results.posts.length >= maxPosts) return;
            const testo    = $('meta[property="og:description"]').attr('content') || '';
            const dataRaw  = $('meta[property="article:published_time"]').attr('content') || '';
            const immagine = $('meta[property="og:image"]').attr('content') || '';
            if (!testo || testo.length < 20) return;
            if (dataRaw && !isInRange(dataRaw)) return;
            results.posts.push({ url, testo, data: dataRaw, immagine });
            log.info(`  ✅ Post: ${testo.substring(0, 60)}`);
            return;
        }

        // Lista eventi
        if (url === eventsUrl || url.endsWith('/events/')) {
            if (!results.isRelevant) return;
            const eventLinks = new Set();
            $('a[href]').each((_, el) => {
                const href = $(el).attr('href') || '';
                const match = href.match(/\/events\/(\d+)/);
                if (match) eventLinks.add(`https://www.facebook.com/events/${match[1]}/`);
            });
            log.info(`  ${eventLinks.size} link eventi`);
            for (const evUrl of [...eventLinks].slice(0, 30)) {
                await crawler.addRequests([{ url: evUrl }]);
            }
            return;
        }

        // Singolo evento
        if (/\/events\/\d+/.test(url)) {
            if (!results.isRelevant) return;
            const titolo   = $('meta[property="og:title"]').attr('content') || '';
            const dataRaw  = $('meta[property="event:start_time"]').attr('content')
                          || $('meta[property="og:event:start_time"]').attr('content') || '';
            const descr    = $('meta[property="og:description"]').attr('content') || '';
            const immagine = $('meta[property="og:image"]').attr('content') || '';
            if (!titolo || !dataRaw) return;
            if (!isFuture(dataRaw)) {
                log.info(`  Skip passato: ${titolo}`);
                return;
            }
            results.events.push({ url, titolo, data: dataRaw, descr, immagine });
            log.info(`  ✅ Evento: ${titolo} (${dataRaw})`);
        }
    },

    failedRequestHandler({ request, error }) {
        log.warning(`Fallito: ${request.url} — ${error.message}`);
    },
});

await crawler.run([
    { url: baseUrl },
    { url: postsUrl },
    { url: eventsUrl },
]);

log.info(`✅ ${comune}: "${results.pageTitle}" pertinente=${results.isRelevant} posts=${results.posts.length} eventi=${results.events.length}`);

await Dataset.pushData(results);
await Actor.exit();
