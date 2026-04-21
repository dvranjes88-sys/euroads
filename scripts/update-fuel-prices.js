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
const HR_HAK_URL = 'https://www.hak.hr/info/cijene-goriva/';        // PRIMARY: official MGOR data, server-rendered, per-company min/max/median
const HR_PRIMARY_URL = 'https://www.cijenegoriva.info/';            // FALLBACK 1
const HR_FALLBACK_URL = 'https://nafta.hr/';                        // FALLBACK 2 (JS-rendered, usually fails)
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(REPO_ROOT, 'fuel-prices.json');
const BALKAN_FILE = path.join(REPO_ROOT, 'balkan-manual.json');

// ── Fetch helper ───────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    // Use a real browser-like User-Agent to avoid bot detection
    const headers = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    };
    https.get(url, { headers }, (res) => {
      if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
        // Follow redirect
        return fetchText(res.headers.location).then(resolve, reject);
      }
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

// ── Scrape Croatia from hak.hr (PRIMARY SOURCE) ────────────
// Hrvatski Autoklub (HAK) gets data directly from MGOR (Ministry).
// HTML is server-rendered with stable structure:
//
//   <div id="div_eurosuper95">
//     <table class="stylized nowrapper">
//       <tr>
//         <td><strong>Adria Oil d.o.o.</strong></td>     ← Obveznik (company)
//         <td>EUROSUPER 95</td>                           ← Gorivo (variant)
//         <td>1,44 €</td>                                 ← Minimalna
//         <td>1,66 €</td>                                 ← Maksimalna
//         <td>1,64 €</td>                                 ← Medijan
//       </tr>
//
// Returns same shape as cijenegoriva parser so downstream code is unchanged:
//   { petrol, diesel, companies: { petrol: [...], diesel: [...] }, validFrom }
//
// Each company entry: { name, price (median), min, max, top, variant }
// Filtering: skip Premium variants (CLASS PLUS PREMIUM, ECTO, G-POWER, V-Power, Q MAX)
// to keep only "basic" fuel grade per company that customers actually buy.

// Map "Obveznik" (full legal name) → friendly brand name
function normalizeHAKCompany(rawName) {
  const name = rawName.replace(/<[^>]+>/g, '').trim();
  const lower = name.toLowerCase();
  if(lower.includes('ina')) return 'INA';
  if(lower.includes('lukoil')) return 'Lukoil';
  if(lower.includes('coral')) return 'Shell';        // Coral Croatia = Shell distributor
  if(lower.includes('shell')) return 'Shell';
  if(lower.includes('petrol')) return 'Petrol';
  if(lower.includes('tifon')) return 'Tifon';
  if(lower.includes('crodux')) return 'Crodux';
  if(lower.includes('adria')) return 'AdriaOil';
  // Fallback: strip "d.o.o.", "d.d." legal suffixes
  return name.replace(/\s+d\.o\.o\.?$/i, '').replace(/\s+d\.d\.?$/i, '').trim();
}

// True for "basic" fuel variants, false for Premium / specialty grades
function isBasicVariant(variantName) {
  const v = variantName.toUpperCase();
  // Premium markers - exclude these
  if(v.includes('PREMIUM')) return false;
  if(v.includes('ECTO')) return false;
  if(v.includes('G-POWER')) return false;
  if(v.includes('V-POWER')) return false;
  if(v.includes('Q MAX')) return false;
  return true;
}

function parseHRPricesFromHAK(html) {
  // Extract date: "Zadnje ažurirano: 21.4.2026."
  let validDate = null;
  const dateMatch = html.match(/Zadnje\s+a[žz]urirano:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
  if(dateMatch) validDate = dateMatch[1];

  // Parse a single fuel-type div (e.g. div_eurosuper95, div_eurodizel)
  // Returns { median, companies } where companies sorted top-brands first
  const parseFuelDiv = (divId, label) => {
    // Extract just this div's content (between id="divId" and next sibling div or table end)
    // We use a generous boundary - look for next <div id="div_..."> or end of #CijeneGorivaTablice
    const divRegex = new RegExp(`<div\\s+id="${divId}"[^>]*>([\\s\\S]*?)(?=<div\\s+id="div_|<\\/div>\\s*<\\/div>)`, 'i');
    const divMatch = html.match(divRegex);
    if(!divMatch){
      console.log(`    ${label}: ❌ <div id="${divId}"> not found`);
      return { median: null, companies: [] };
    }
    const divContent = divMatch[1];

    // Extract all <tr> rows (skip <thead> rows)
    // Match: <tr>...<td><strong>NAME</strong></td><td>VARIANT</td><td>MIN €</td><td>MAX €</td><td>MEDIAN €</td>...</tr>
    const rowRegex = /<tr>\s*<td>\s*<strong>([^<]+)<\/strong>\s*<\/td>\s*<td>([^<]+)<\/td>\s*<td>([\d,.\s]+)\s*€\s*<\/td>\s*<td>([\d,.\s]+)\s*€\s*<\/td>\s*<td>([\d,.\s]+)\s*€\s*<\/td>/gi;
    const allRows = [...divContent.matchAll(rowRegex)];

    if(allRows.length === 0){
      console.log(`    ${label}: ❌ no <tr> rows matched in div content (${divContent.length} chars)`);
      return { median: null, companies: [] };
    }

    // Group by company: pick the BASIC variant per company (skip Premium grades)
    // If a company has ONLY Premium variants, fall back to the cheapest one
    const byCompany = {};
    for(const row of allRows){
      const rawName = row[1];
      const variant = row[2].trim();
      const min = parseFloat(row[3].replace(',', '.'));
      const max = parseFloat(row[4].replace(',', '.'));
      const median = parseFloat(row[5].replace(',', '.'));
      if(isNaN(median) || median < 0.5 || median > 4.0) continue;

      const company = normalizeHAKCompany(rawName);
      if(!company) continue;
      const isBasic = isBasicVariant(variant);

      // Prefer basic variant; if already have basic, skip (unless this is also basic with lower median)
      const existing = byCompany[company];
      if(!existing){
        byCompany[company] = { name: company, price: median, min, max, variant, top: true, isBasic };
      } else if(!existing.isBasic && isBasic){
        // Replace premium with basic
        byCompany[company] = { name: company, price: median, min, max, variant, top: true, isBasic };
      } else if(existing.isBasic && isBasic && median < existing.price){
        // Both basic, prefer lower median
        byCompany[company] = { name: company, price: median, min, max, variant, top: true, isBasic };
      }
    }

    const companies = Object.values(byCompany).map(c => ({
      name: c.name, price: c.price, min: c.min, max: c.max, top: true, variant: c.variant,
    }));

    if(companies.length === 0){
      console.log(`    ${label}: ❌ no companies after grouping`);
      return { median: null, companies: [] };
    }

    // Sort alphabetically (all are top brands here)
    companies.sort((a, b) => a.name.localeCompare(b.name));

    // National median across all companies (their median prices)
    const allMedians = companies.map(c => c.price).sort((a, b) => a - b);
    const nationalMedian = allMedians[Math.floor(allMedians.length / 2)];

    console.log(`    ${label}: ${companies.length} companies, national median €${nationalMedian.toFixed(2)}`);
    return { median: nationalMedian, companies };
  };

  console.log(`    📥 HTML received: ${html.length} chars`);

  const petrolData = parseFuelDiv('div_eurosuper95', 'Eurosuper 95');
  const dieselData = parseFuelDiv('div_eurodizel', 'Eurodizel');

  if(!petrolData.median || !dieselData.median){
    throw new Error(`HAK parse failed (petrol=${petrolData.median}, diesel=${dieselData.median})`);
  }

  return {
    petrol: petrolData.median,
    diesel: dieselData.median,
    companies: {
      petrol: petrolData.companies,
      diesel: dieselData.companies,
    },
    validFrom: validDate,
  };
}

// ── Scrape Croatia from cijenegoriva.info (FALLBACK) ───────
// Page can be served as raw HTML (with <table>, <tr>, <td>, <strong>)
// OR as markdown (with **bold**, | tables |). Parser handles both.
//
// Returns:
//   { petrol: 1.66, diesel: 1.85,
//     companies: { petrol: [{name, price}, ...], diesel: [...] },
//     validFrom: date string }

const TOP_BRANDS = ['ina', 'lukoil', 'shell', 'petrol', 'tifon', 'crodux', 'adriaoil'];

function normalizeCompanyName(raw) {
  // Strip HTML tags first (in case there are any remaining)
  let name = raw.replace(/<[^>]+>/g, '').trim();
  // "Crodux Derivati (Petrol)" → "Crodux"
  // "Attendo centar (Dugo Selo)" → "Attendo centar"
  name = name.replace(/\s*\([^)]+\)/g, '').trim();
  name = name.replace(/\s+Derivati$/i, '').trim();
  if(name.toLowerCase() === 'ina') return 'INA';
  return name;
}

function isTopBrand(name) {
  return TOP_BRANDS.includes(name.toLowerCase());
}

function parseHRPricesFromCijeneGoriva(html) {
  // Step 1: Decode HTML entities BEFORE stripping tags
  // Server sends &euro; (or &#8364; / &#x20AC;) instead of literal € symbol
  let decoded = html
    .replace(/&euro;/gi, '€')
    .replace(/&#8364;/g, '€')
    .replace(/&#x20AC;/gi, '€')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  // Step 2: Strip HTML tags
  const stripped = decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // Extract date "vrijede od 21.04.2026"
  let validDate = null;
  const dateMatch = stripped.match(/vrijede\s+od\s+(\d{1,2}\.\d{1,2}\.\d{4})/i);
  if(dateMatch) validDate = dateMatch[1];

  // SMART keyword finder: keyword must precede an ACTUAL TABLE of prices,
  // not a navigation link or intro text mentioning prices.
  // Heuristic: real table has multiple prices clustered close together.
  // - At least 1 price within 100 chars (table starts immediately after heading)
  // - At least 3 prices within 500 chars (multiple rows)
  const findKeyword = (text, keyword) => {
    let pos = 0;
    while(pos < text.length){
      const idx = text.toLowerCase().indexOf(keyword.toLowerCase(), pos);
      if(idx === -1) return -1;
      // Skip "Premium" prefix
      const before = text.slice(Math.max(0, idx - 25), idx).toLowerCase();
      if(before.includes('premium')){
        pos = idx + keyword.length;
        continue;
      }
      // Check 1: A price must be very close (within 100 chars) — tables start right after heading
      const veryClose = text.slice(idx + keyword.length, idx + keyword.length + 100);
      if(!/[\d]+[,.][\d]+\s*€/.test(veryClose)){
        pos = idx + keyword.length;
        continue;
      }
      // Check 2: At least 3 prices within 500 chars (real table, not just intro mention)
      const tableRange = text.slice(idx + keyword.length, idx + keyword.length + 500);
      const priceCount = (tableRange.match(/[\d]+[,.][\d]+\s*€/g) || []).length;
      if(priceCount < 3){
        pos = idx + keyword.length;
        continue;
      }
      return idx;
    }
    return -1;
  };

  // Get sections between headings
  const extractSection = (startKeyword) => {
    const startIdx = findKeyword(stripped, startKeyword);
    if(startIdx === -1) return null;
    const sectionStart = startIdx + startKeyword.length;
    const rest = stripped.slice(sectionStart);
    // Stop at next heading: any of the fuel/section names
    const nextHeadingRegex = /\b(Premium|Eurosuper|Eurodizel|Autoplin|Lo[žz]\s*ulje|Plavi)\b/i;
    const nextMatch = rest.match(nextHeadingRegex);
    const sectionEnd = nextMatch ? Math.min(nextMatch.index, 3000) : Math.min(rest.length, 3000);
    return rest.slice(0, sectionEnd);
  };

  // Parse companies+prices from a section
  // Permissive: looks for pairs of (CompanyName, NUMBER €)
  // CompanyName is identified by being a sequence of letters before a price.
  const parseSection = (section, label) => {
    if(!section) return { median: null, companies: [] };

    // Extract all price values "1,66 €" or "1.66 €"
    // PLUS the ~80 chars BEFORE each price (where company name lives)
    const priceRegex = /([\d]+[,.][\d]+)\s*€/g;
    const companies = [];
    let m;
    while((m = priceRegex.exec(section)) !== null){
      const price = parseFloat(m[1].replace(',', '.'));
      if(isNaN(price) || price < 0.8 || price > 3.5) continue;
      const before = section.slice(Math.max(0, m.index - 80), m.index);
      // Strip pipes and table headers
      let cleanBefore = before.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();
      // Remove generic table headers if they appear in our search window
      cleanBefore = cleanBefore.replace(/\b(Naftna\s+tvrtka|Cijena|tvrtka|Cijene)\b/gi, '').trim();
      // Now match: capital letter, then word chars/spaces/parens, ending in letter or paren
      const nameMatch = cleanBefore.match(/([A-ZČĆŠĐŽ][a-zA-ZČčĆćŠšĐđŽž0-9 ()]*[a-zA-ZČčĆćŠšĐđŽž)])\s*$/);
      if(!nameMatch) continue;
      const rawName = nameMatch[1].trim();
      // Skip if name is too generic (extra safety)
      if(/^(Naftna|tvrtka|Cijena|tvrtke)$/i.test(rawName)) continue;
      const name = normalizeCompanyName(rawName);
      if(!name || name.length < 2 || name.length > 40) continue;
      // Avoid duplicates (some pages list same company twice)
      if(companies.some(c => c.name === name)) continue;
      companies.push({ name, price, top: isTopBrand(name) });
    }

    if(companies.length === 0){
      // DEBUG: dump section info to diagnose what HTML actually arrived
      const euroCount = (section.match(/€/g) || []).length;
      const eurEntityCount = (section.match(/&euro;|&#8364;|&#x20AC;/gi) || []).length;
      const eurTextCount = (section.match(/\bEUR\b/g) || []).length;
      const numberCount = (section.match(/[\d]+[,.][\d]+/g) || []).length;
      console.log(`    ${label}: ❌ NO companies parsed!`);
      console.log(`      section.length=${section.length}`);
      console.log(`      € symbols: ${euroCount}, EUR entities: ${eurEntityCount}, EUR text: ${eurTextCount}`);
      console.log(`      number patterns (X,XX or X.XX): ${numberCount}`);
      console.log(`      First 500 chars of section:`);
      console.log(`      ---`);
      console.log(`      ${section.slice(0, 500)}`);
      console.log(`      ---`);
      return { median: null, companies: [] };
    }

    // Sort: top brands first, then alphabetically
    companies.sort((a, b) => {
      if(a.top !== b.top) return a.top ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const prices = companies.map(c => c.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    console.log(`    ${label}: ${companies.length} companies, median €${median.toFixed(2)}`);
    return { median, companies };
  };

  // DEBUG: log overall fetch info BEFORE attempting parse
  console.log(`    📥 HTML received: ${html.length} chars`);
  console.log(`    📝 Stripped text: ${stripped.length} chars`);
  console.log(`    💶 Total € in stripped: ${(stripped.match(/€/g) || []).length}`);
  console.log(`    💶 Total &euro;/&#8364; entities: ${(stripped.match(/&euro;|&#8364;|&#x20AC;/gi) || []).length}`);
  console.log(`    💶 Total "EUR" text occurrences: ${(stripped.match(/\bEUR\b/g) || []).length}`);
  console.log(`    🔢 Total decimal numbers (X,XX or X.XX): ${(stripped.match(/[\d]+[,.][\d]+/g) || []).length}`);

  const petrolSection = extractSection('Eurosuper 95');
  const dieselSection = extractSection('Eurodizel');

  console.log(`    📦 Petrol section: ${petrolSection ? petrolSection.length + ' chars' : 'NULL'}`);
  console.log(`    📦 Diesel section: ${dieselSection ? dieselSection.length + ' chars' : 'NULL'}`);

  const petrolData = parseSection(petrolSection, 'Eurosuper 95');
  const dieselData = parseSection(dieselSection, 'Eurodizel');

  if(!petrolData.median || !dieselData.median){
    throw new Error(`Could not parse HR (petrol=${petrolData.median}, diesel=${dieselData.median}, sections found: petrol=${!!petrolSection}, diesel=${!!dieselSection})`);
  }

  return {
    petrol: petrolData.median,
    diesel: dieselData.median,
    companies: {
      petrol: petrolData.companies,
      diesel: dieselData.companies,
    },
    validFrom: validDate,
  };
}

// ── Legacy fallback: Scrape Croatia from nafta.hr ──────────
// Note: nafta.hr uses JS-rendering so raw HTML doesn't have prices.
// This fallback is kept in case they add server-rendered prices.
function parseHRPricesFromNafta(html) {
  const petrolMatch = html.match(/(?:Eurosuper\s*95|Eurosuper-?95)[^0-9]{0,50}([\d]+[,.][\d]+)\s*€/i);
  const dieselMatch = html.match(/(?:Eurodizel|Euro\s*dizel|Dizel)[^0-9]{0,50}([\d]+[,.][\d]+)\s*€/i);
  if(!petrolMatch || !dieselMatch){
    throw new Error('Could not parse Croatia from nafta.hr HTML (JS-rendered?)');
  }
  const petrol = parseFloat(petrolMatch[1].replace(',', '.'));
  const diesel = parseFloat(dieselMatch[1].replace(',', '.'));
  if(petrol < 0.8 || petrol > 3 || diesel < 0.8 || diesel > 3){
    throw new Error(`HR prices out of range: petrol=${petrol}, diesel=${diesel}`);
  }
  return { petrol, diesel };
}

// ── Try all HR sources in order ────────────────────────────
async function scrapeCroatia() {
  // PRIMARY: hak.hr (server-rendered, MGOR official data, per-company min/max/median)
  try {
    console.log(`  → Trying ${HR_HAK_URL}…`);
    const html = await fetchText(HR_HAK_URL);
    const prices = parseHRPricesFromHAK(html);
    console.log(`  ✅ Source: hak.hr`);
    return prices;
  } catch(e) {
    console.warn(`  ⚠️  hak.hr failed: ${e.message}`);
  }

  // FALLBACK 1: cijenegoriva.info (server-rendered tables)
  try {
    console.log(`  → Trying ${HR_PRIMARY_URL}…`);
    const html = await fetchText(HR_PRIMARY_URL);
    const prices = parseHRPricesFromCijeneGoriva(html);
    console.log(`  ✅ Source: cijenegoriva.info`);
    return prices;
  } catch(e) {
    console.warn(`  ⚠️  cijenegoriva.info failed: ${e.message}`);
  }

  // FALLBACK 2: nafta.hr (JS-rendered, probably won't work but try anyway)
  try {
    console.log(`  → Trying ${HR_FALLBACK_URL}…`);
    const html = await fetchText(HR_FALLBACK_URL);
    const prices = parseHRPricesFromNafta(html);
    console.log(`  ✅ Source: nafta.hr`);
    return prices;
  } catch(e) {
    console.warn(`  ⚠️  nafta.hr failed: ${e.message}`);
  }

  throw new Error('All HR sources failed');
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
  let hrLive = null;
  try {
    console.log(`🇭🇷 Scraping Croatia (trying multiple sources)…`);
    const hrPrices = await scrapeCroatia();
    console.log(`✅ Croatia: petrol €${hrPrices.petrol}, diesel €${hrPrices.diesel}`);
    // Base prices go into the standard `prices` object
    merged.HR = { petrol: hrPrices.petrol, diesel: hrPrices.diesel };
    // Extended live data (per-company breakdown) goes into `hr_live`
    if(hrPrices.companies){
      hrLive = {
        validFrom: hrPrices.validFrom || null,
        companies: hrPrices.companies,
        source: 'cijenegoriva.info',
        updatedAt: new Date().toISOString(),
      };
      const topPetrol = hrPrices.companies.petrol.filter(c => c.top).length;
      const topDiesel = hrPrices.companies.diesel.filter(c => c.top).length;
      console.log(`    → ${topPetrol} top petrol brands, ${topDiesel} top diesel brands`);
    }
  } catch(e) {
    console.error(`⚠️  All HR sources failed: ${e.message} (using EU Bulletin value)`);
    // Keep existing hr_live if present (in case only this run failed)
    if(existing.hr_live) hrLive = existing.hr_live;
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
      hr: 'Government of Croatia via cijenegoriva.info (updated every 14 days)',
      balkan: `Manual via balkan-manual.json (last edit ${balkanData._updated || 'unknown'})`
    },
    _auto_updated: new Date().toISOString(),
    _notes: 'Prices are national weekly averages including all taxes. Highway stations may charge 10-25% more.',
    prices: merged,
    hr_live: hrLive,  // null if scrape failed, object if successful
  };

  // 7. Compare with existing - exit with no-change code if identical
  // (compare both prices AND hr_live.companies)
  const existingSnapshot = JSON.stringify({ prices: existing.prices || {}, hr_live: existing.hr_live || null });
  const newSnapshot = JSON.stringify({ prices: merged, hr_live: hrLive });
  if(existingSnapshot === newSnapshot){
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
