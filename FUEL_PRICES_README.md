# Fuel Price Auto-Update System

EuroRoads uses **live fuel price data** updated weekly from official sources.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       GitHub Repo                             │
│                                                               │
│   index.html  ← fetch() → fuel-prices.json                   │
│                              ▲                                │
│                              │ auto-commit                    │
│                              │                                │
│   .github/workflows/update-fuel-prices.yml                   │
│     ↓ runs Thu 18:00 CET                                     │
│   scripts/update-fuel-prices.js                              │
│     ↓ fetches                                                │
│   ┌─────────────────────┐   ┌──────────────┐                │
│   │ fuel-prices.eu      │   │ nafta.hr     │                │
│   │ (EU 27 countries,   │   │ (Croatia,    │                │
│   │  CC BY 4.0)         │   │  gov-regulated) │             │
│   └─────────────────────┘   └──────────────┘                │
│     ↓ merges with                                            │
│   balkan-manual.json (BA, RS, ME, MK, AL, XK, ...)          │
└──────────────────────────────────────────────────────────────┘
```

## Files

- **`fuel-prices.json`** — Live fuel prices consumed by `index.html`. Auto-generated, do NOT edit manually.
- **`balkan-manual.json`** — Manual prices for non-EU countries. Edit monthly.
- **`scripts/update-fuel-prices.js`** — Fetches & merges prices from all sources.
- **`.github/workflows/update-fuel-prices.yml`** — Runs the updater weekly.

## How it works

### Automatic (weekly)

Every Thursday at 18:00 CET (after EU Weekly Oil Bulletin release), GitHub Action:

1. Fetches `https://www.fuel-prices.eu/llms-full.txt` → extracts 27 EU prices
2. Fetches `https://nafta.hr/` → extracts Croatia prices (government-regulated, updated every 14 days)
3. Merges with `balkan-manual.json` → non-EU countries (BA, RS, ME, MK, AL, XK, CH, NO, UK, TR, UA, MD, GE)
4. Writes `fuel-prices.json` with timestamp
5. If prices changed: commits with message `data: auto-update fuel prices YYYY-MM-DD`
6. Vercel auto-deploys the new data

### Manual trigger

Go to GitHub → Actions → "Update Fuel Prices" → "Run workflow"

### Updating Balkán prices

Edit `balkan-manual.json` when prices change significantly (typically monthly). Sources for each country are in the file.

Recommended check: https://www.globalpetrolprices.com/

## Testing locally

```bash
node scripts/update-fuel-prices.js
```

## Fallback behavior

If the live JSON fetch fails in the browser (rare), `index.html` uses an **inline fallback** dataset baked into the HTML. User will see prices from the last deploy, never broken.

## Data sources & licensing

- **EU Oil Bulletin** via fuel-prices.eu: CC BY 4.0 — Attribution: fuel-prices.eu
- **Croatia**: Government of Croatia (public data via nafta.hr)
- **Balkán**: GlobalPetrolPrices.com + national sources (compiled manually)

Attribution displayed in the EuroRoads UI fuel breakdown panel.
