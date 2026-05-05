# ProLoco Facebook Scraper

Actor Apify per scrapare posts ed eventi da pagine Facebook Pro Loco e Comuni italiani.

## Features
- Valida che la pagina sia pertinente al comune cercato
- Legge sia **posts** (ultimi N giorni) che **events** (futuri)
- Filtra per data direttamente in JS — zero sprechi
- Restituisce un oggetto unico con pageTitle, isRelevant, posts[], events[]

## Input
```json
{
  "fbUrl": "https://www.facebook.com/prolocoseregno",
  "comune": "Seregno",
  "fromDate": "2026-04-20",
  "toDate": "2026-08-01",
  "maxPosts": 20
}
```

## Output
```json
{
  "fbUrl": "...",
  "comune": "Seregno",
  "pageTitle": "Pro Loco Seregno",
  "isRelevant": true,
  "posts": [...],
  "events": [...]
}
```
