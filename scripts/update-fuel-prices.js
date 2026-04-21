#!/usr/bin/env node
/**
 * EuroRoads Fuel Price Auto-Updater
 *
 * Fetches fresh fuel prices from:
 *   1. EU Oil Bulletin via fuel-prices.eu (27 EU countries, CC BY 4.0)
 *   2. Croatian government via nafta.hr (HR only, highest accuracy)
 *   3. balkan-manual.json (non-EU countries, manually curated)
 *
 * Merges them into fuel-prices.json at repo root.
 *
 * Runs weekly via GitHub Action (Thursdays 18:00 CET after EU Bulletin release).
 * Manual trigger: gh workflow run update-fuel-prices.yml
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Config ─────────────────────────────────────────────────
const EU_URL = 'https://www.fuel-prices.eu/llms-full.txt';
const HR_URL = 'https://nafta.hr/';
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(REPO_ROOT, 'fuel-prices.json');
const BALKAN_FILE = path.join(REPO_ROOT, 'balkan-manual.json');

// ── Fetch helper ───────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'EuroRoads-FuelUpdater/1.0' } }, (res) => {
      if(res.statusCode !== 200){
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// ── Parse EU Oil Bulletin table from llms-full.txt ─────────
// Looking for section "CURRENT FUEL PRICES — ALL COUNTRIES" with rows like:
//   "CC   Country                Euro95/L   Diesel/L  E95 $/gal ..."
//   "MT   Malta               €     1.340 €     1.210 $5.85 ..."
function parseEUPrices(text) {
  const prices = {};
  const sectionStart = text.indexOf('CURRENT FUEL PRICES');
  if(sectionStart === -1) throw new Error('Could not find EU prices section in llms-full.txt');

  const section = text.slice(sectionStart, sectionStart + 10000);
  const lines = section.split('\n');

  for(const line of lines){
    // Match: "CC  Country Name  €  1.340 €  1.210 ..."
    const m = line.match(/^([A-Z]{2})\s+[\w\s&.'-]+?€\s+([\d.]+)\s+€\s+([\d.]+)/);
    if(m){
      const cc = m[1];
      const petrol = parseFloat(m[2]);
      const diesel = parseFloat(m[3]);
      if(!isNaN(petrol) && !isNaN(diesel) && petrol > 0.5 && petrol < 5){
        prices[cc] = { petrol, diesel };
      }
    }
  }

  if(Object.keys(prices).length < 20){
    throw new Error(`Parsed only ${Object.keys(prices).length} EU prices, expected 27. Format may have changed.`);
  }
  return prices;
}

// ── Scrape Croatia from nafta.hr ───────────────────────────
// HTML contains: "Eurosuper 95: 1,64 €" / "Eurodizel: 1,78 €" etc.
function parseHRPrices(html) {
  const result = {};
  // Match patterns like: Eurosuper 95 ... 1,64 € or 1.64 €
  const petrolMatch = html.match(/(?:Eurosuper\s*95|Eurosuper-?95)[^0-9]{0,50}([\d]+[,.][\d]+)\s*€/i);
  const dieselMatch = html.match(/(?:Eurodizel|Euro\s*dizel|Dizel)[^0-9]{0,50}([\d]+[,.][\d]+)\s*€/i);

  if(petrolMatch){
    result.petrol = parseFloat(petrolMatch[1].replace(',', '.'));
  }
  if(dieselMatch){
    result.diesel = parseFloat(dieselMatch[1].replace(',', '.'));
  }

  if(!result.petrol || !result.diesel){
    throw new Error('Could not parse Croatia prices from nafta.hr HTML');
  }
  // Sanity check: €0.80 - €3.00 range
  if(result.petrol < 0.8 || result.petrol > 3 || result.diesel < 0.8 || result.diesel > 3){
    throw new Error(`HR prices out of range: petrol=${result.petrol}, diesel=${result.diesel}`);
  }
  return result;
}

// ── Main ───────────────────────────────────────────────────
(async () => {
  console.log('🔄 EuroRoads fuel price updater starting…');

  // 1. Load existing JSON for fallback
  let existing = { prices: {} };
  try {
    existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    console.log(`📄 Loaded existing fuel-prices.json (last updated ${existing._updated})`);
  } catch(e) {
    console.log('📄 No existing fuel-prices.json, starting fresh');
  }

  // 2. Load manual Balkan data
  let balkanData = { prices: {} };
  try {
    balkanData = JSON.parse(fs.readFileSync(BALKAN_FILE, 'utf8'));
    console.log(`📄 Loaded balkan-manual.json (${Object.keys(balkanData.prices).length} countries)`);
  } catch(e) {
    console.warn('⚠️  No balkan-manual.json found, using existing Balkan prices');
    for(const cc of ['BA','RS','ME','MK','AL','XK','CH','NO','UK','TR','UA','MD','GE']){
      if(existing.prices?.[cc]) balkanData.prices[cc] = existing.prices[cc];
    }
  }

  // 3. Fetch EU prices
  const merged = {};
  let euCount = 0;
  try {
    console.log(`🌍 Fetching EU prices from ${EU_URL}…`);
    const euText = await fetchText(EU_URL);
    const euPrices = parseEUPrices(euText);
    euCount = Object.keys(euPrices).length;
    console.log(`✅ Parsed ${euCount} EU countries`);
    Object.assign(merged, euPrices);
  } catch(e) {
    console.error(`❌ EU fetch failed: ${e.message}`);
    console.log('   Falling back to existing EU prices');
    // Fallback: use existing EU prices
    const EU_CODES = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
    for(const cc of EU_CODES){
      if(existing.prices?.[cc]) merged[cc] = existing.prices[cc];
    }
  }

  // 4. Scrape Croatia (overrides EU's HR value with fresher data)
  try {
    console.log(`🇭🇷 Scraping Croatia from ${HR_URL}…`);
    const hrHtml = await fetchText(HR_URL);
    const hrPrices = parseHRPrices(hrHtml);
    console.log(`✅ Croatia: petrol €${hrPrices.petrol}, diesel €${hrPrices.diesel}`);
    merged.HR = hrPrices;
  } catch(e) {
    console.error(`⚠️  HR scrape failed: ${e.message} (using EU Bulletin value)`);
  }

  // 5. Merge manual Balkan data
  Object.assign(merged, balkanData.prices);
  console.log(`🔀 Merged ${Object.keys(balkanData.prices).length} Balkan/non-EU countries`);

  // 6. Build final JSON
  const today = new Date().toISOString().split('T')[0];
  const output = {
    _updated: today,
    _sources: {
      eu_27: 'EU Oil Bulletin via fuel-prices.eu (CC BY 4.0)',
      hr: 'Government of Croatia via nafta.hr (updated every 14 days)',
      balkan: `Manual via balkan-manual.json (last edit ${balkanData._updated || 'unknown'})`
    },
    _auto_updated: new Date().toISOString(),
    _notes: 'Prices are national weekly averages including all taxes. Highway stations may charge 10-25% more.',
    prices: merged
  };

  // 7. Compare with existing - exit with no-change code if identical
  const existingPricesJson = JSON.stringify(existing.prices || {});
  const newPricesJson = JSON.stringify(merged);
  if(existingPricesJson === newPricesJson){
    console.log('ℹ️  No price changes detected. Not rewriting file.');
    process.exit(78); // GitHub Actions "neutral" exit code
  }

  // 8. Write file
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + '\n');
  console.log(`✅ Wrote ${OUTPUT}`);
  console.log(`📊 Total countries: ${Object.keys(merged).length}`);
})().catch(err => {
  console.error('💥 Fatal:', err);
  process.exit(1);
});
