// RentScope — extractors/apartments.js
// Extracts rental listing data from Apartments.com.
//
// URL pattern: https://www.apartments.com/<property-slug>/<listing-id>/[section/]
// Listing IDs are 5–12 lowercase alphanumeric chars (e.g. "hfvljnj", "cxx5rnj").
//
// Extraction layers (in order):
//   L0: __NEXT_DATA__ recursive key scan
//   L1: JSON-LD schema.org (ApartmentComplex / Apartment / Product)
//   L2: Meta tags (og:title, og:description, og:street-address)
//   L3: DOM selectors
//
// Returns: { price, beds, zipCode, address, city, state, homeStatus, isBuilding, source }
//          or null if extraction fails.

function extractApartments() {
  const fromND = extractAptFromNextData();
  if (fromND) return fromND;

  const fromJLD = extractAptFromJsonLd();
  if (fromJLD) return fromJLD;

  const fromMeta = extractAptFromMeta();
  if (fromMeta) return fromMeta;

  return extractAptFromDOM();
}

// ── L0: __NEXT_DATA__ recursive scan ─────────────────────────────────────────

function extractAptFromNextData() {
  try {
    const nd = JSON.parse(
      document.getElementById('__NEXT_DATA__')?.textContent || '{}'
    );
    const hit = findAptListing(nd, 0);
    if (hit) return { ...hit, source: 'nextdata' };
  } catch (_) {}
  return null;
}

// Recursively find an object that has ZIP + price + beds fields.
function findAptListing(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 12) return null;

  const keys = Object.keys(obj);

  const hasZip   = keys.some(k => /^(postalCode|zipCode|zip)$/i.test(k));
  const hasPrice = keys.some(k => /^(price|minRent|lowPrice|rentAmount|rent)$/i.test(k));
  const hasBeds  = keys.some(k => /^(beds|bedrooms|numBedrooms|minBeds|bedroomCount)$/i.test(k));

  if (hasZip && hasPrice && hasBeds) {
    const zip   = String(obj.postalCode || obj.zipCode || obj.zip || '').trim();
    const price = aptParsePrice(
      obj.price || obj.minRent || obj.lowPrice || obj.rentAmount || obj.rent
    );
    const beds  = aptParseBeds(
      obj.beds ?? obj.bedrooms ?? obj.numBedrooms ?? obj.minBeds ?? obj.bedroomCount
    );
    const city    = obj.city    || obj.addressLocality || null;
    const state   = obj.state   || obj.addressRegion   || null;
    const address = obj.streetAddress || obj.address   || null;

    if (/^\d{5}$/.test(zip) && price > 100 && beds != null) {
      return { price, beds, zipCode: zip, address, city, state,
               homeStatus: 'FOR_RENT', isBuilding: false };
    }
  }

  for (const k of keys) {
    const v = obj[k];
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (let i = 0; i < Math.min(v.length, 6); i++) {
        const hit = findAptListing(v[i], depth + 1);
        if (hit) return hit;
      }
    } else {
      const hit = findAptListing(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// ── L1: JSON-LD ───────────────────────────────────────────────────────────────
// Apartments.com typically has:
//   • ApartmentComplex — reliable address + ZIP
//   • Apartment / Product — individual unit price + beds

function extractAptFromJsonLd() {
  // Flatten all JSON-LD blocks (handle single obj, array, @graph)
  const blocks = [];
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(el.textContent);
      if (Array.isArray(parsed))    blocks.push(...parsed);
      else if (parsed['@graph'])    blocks.push(...parsed['@graph']);
      else                          blocks.push(parsed);
    } catch (_) {}
  }
  if (blocks.length === 0) return null;

  // Collect ApartmentComplex address for fallback
  let complexAddr = null;
  for (const b of blocks) {
    const type = String(b['@type'] || '').toLowerCase();
    if (['apartmentcomplex', 'localbusiness', 'realestatecondominiumunit',
         'residentialbuilding'].includes(type) || (type === 'place' && b.address)) {
      const zip = jldZip(b.address || b);
      if (zip) {
        complexAddr = {
          zipCode: zip,
          address: b.address?.streetAddress || null,
          city:    b.address?.addressLocality || null,
          state:   b.address?.addressRegion   || null,
        };
        break;
      }
    }
  }

  // Look for specific unit data (Apartment / Product)
  for (const b of blocks) {
    const type = String(b['@type'] || '').toLowerCase();
    if (['apartment', 'product', 'accommodation', 'residence',
         'singlefamilyresidence', 'house', 'condominium', 'townhouse',
         'apartmentunit'].includes(type)) {
      const price = aptParsePrice(b.offers?.price || b.offers?.lowPrice || b.price);
      const beds  = aptParseBeds(b.numberOfBedrooms || b.numberOfRooms || b.name);
      const zip   = jldZip(b.address) || complexAddr?.zipCode;

      if (price > 100 && beds != null && zip) {
        return {
          price, beds, zipCode: zip,
          address: b.address?.streetAddress || complexAddr?.address || null,
          city:    b.address?.addressLocality || complexAddr?.city   || null,
          state:   b.address?.addressRegion   || complexAddr?.state  || null,
          homeStatus: 'FOR_RENT',
          isBuilding: false,
          source: 'jsonld',
        };
      }
    }
  }

  // Have address but no unit price — try priceRange or any offer price
  if (complexAddr) {
    for (const b of blocks) {
      // priceRange: "$1,500 - $3,000"
      if (b.priceRange) {
        const m = String(b.priceRange).match(/\$([\d,]+)/);
        if (m) {
          const price = parseInt(m[1].replace(/,/g, ''), 10);
          if (price > 100) {
            const isRange = String(b.priceRange).includes('-') ||
                            String(b.priceRange).includes('+');
            return { ...complexAddr, price, beds: 0,
                     homeStatus: 'FOR_RENT', isBuilding: false,
                     source: 'jsonld_complex' };
          }
        }
      }
      // aggregateOffer lowPrice
      const low = aptParsePrice(b.offers?.lowPrice || b.offers?.price);
      if (low > 100) {
        return { ...complexAddr, price: low, beds: 0,
                 homeStatus: 'FOR_RENT', isBuilding: false,
                 source: 'jsonld_complex' };
      }
    }
  }

  return null;
}

function jldZip(addr) {
  if (!addr) return null;
  if (typeof addr === 'string') {
    const m = addr.match(/\b(\d{5})\b/);
    return m ? m[1] : null;
  }
  const z = String(addr.postalCode || addr.zipCode || addr.zip || '').trim();
  return /^\d{5}$/.test(z) ? z : null;
}

// ── L2: Meta tags ─────────────────────────────────────────────────────────────

function extractAptFromMeta() {
  const title = document.querySelector('meta[property="og:title"]')?.content
              || document.title || '';
  const desc  = document.querySelector('meta[property="og:description"]')?.content
              || document.querySelector('meta[name="description"]')?.content
              || '';
  const combined = title + ' ' + desc;

  // Price: "$1,500/mo" or "$1,500 - $3,000/mo"
  const priceM = combined.match(/\$([\d,]+)\s*(?:\/\s*mo|per month)/i);
  const price  = priceM ? parseInt(priceM[1].replace(/,/g, ''), 10) : null;
  const isRange = /\$([\d,]+)\s*[-–]\s*\$([\d,]+)/i.test(combined);

  // Beds
  let beds = null;
  if (/\bstudio\b/i.test(combined)) beds = 0;
  else {
    const bm = combined.match(/(\d+)\s*(?:bed|br)\b/i);
    if (bm) beds = parseInt(bm[1], 10);
  }

  // ZIP
  const zipM = combined.match(/\b(\d{5})\b/);
  const zip  = zipM?.[1] ?? null;

  // City/state from og:title: "Property Name - City, ST | Apartments.com"
  let city = null, state = null;
  const locM = title.match(/[-–]\s*([^,|–-]+),\s*([A-Z]{2})\b/);
  if (locM) { city = locM[1].trim(); state = locM[2]; }

  // og:street-address may include ZIP
  const streetMeta = document.querySelector('meta[property="og:street-address"]')?.content;
  const zipFromStreet = streetMeta?.match(/\b(\d{5})\b/)?.[1];

  if (price && price > 100 && beds != null && (zip || zipFromStreet)) {
    return {
      price, beds,
      zipCode:   zip || zipFromStreet,
      address:   streetMeta || null,
      city, state,
      homeStatus: 'FOR_RENT',
      isBuilding: false,
      source: 'meta',
    };
  }
  return null;
}

// ── L3: DOM selectors ─────────────────────────────────────────────────────────

function extractAptFromDOM() {
  const bodyText = document.body?.innerText || '';

  // ── Price ────────────────────────────────────────────────────────────────
  let price = null, isBuilding = false;

  const PRICE_SELS = [
    '[data-testid*="price"]',
    '[class*="pricingColumn"]',
    '[class*="rentInfo"]',
    '[class*="priceRange"]',
    '[class*="rentRange"]',
    '.rentInfoDetail',
    '[class*="Price"]',
  ];
  for (const sel of PRICE_SELS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = el.textContent;
    const m = text.match(/\$([\d,]+)/);
    if (m) {
      price = parseInt(m[1].replace(/,/g, ''), 10);
      isBuilding = /\$([\d,]+)\s*[-–+]\s*(?:\$[\d,]+)?/i.test(text);
      if (price > 100) break;
      price = null;
    }
  }

  if (!price) {
    const m = bodyText.match(/\$\s*([\d,]+)\s*(?:\/\s*mo|per month)/i);
    if (m) {
      price = parseInt(m[1].replace(/,/g, ''), 10);
      isBuilding = /\$([\d,]+)\s*[-–]\s*\$([\d,]+)/i.test(bodyText);
    }
  }

  // ── Beds ──────────────────────────────────────────────────────────────────
  let beds = null;

  const BED_SELS = [
    '[data-testid*="bed"]',
    '[class*="bedsColumn"]',
    '[class*="bedsDetail"]',
    '[class*="bedroomCount"]',
    '[class*="floorPlan"]',
  ];
  for (const sel of BED_SELS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = el.textContent;
    if (/\bstudio\b/i.test(text)) { beds = 0; break; }
    const m = text.match(/(\d+)\s*(?:bed|br)\b/i);
    if (m) { beds = parseInt(m[1], 10); break; }
  }

  if (beds == null) {
    if (/\bstudio\b/i.test(bodyText)) beds = 0;
    else {
      const m = bodyText.match(/(\d+)\s*(?:bed|br)\b/i);
      if (m) beds = parseInt(m[1], 10);
    }
  }

  // ── ZIP ───────────────────────────────────────────────────────────────────
  let zip = null;

  const ADDR_SELS = [
    '[itemprop="postalCode"]',
    '[data-testid*="address"]',
    '[class*="propertyAddress"]',
    '[class*="address"]',
    'address',
  ];
  for (const sel of ADDR_SELS) {
    const el = document.querySelector(sel);
    const m  = el?.textContent?.match(/\b(\d{5})\b/);
    if (m) { zip = m[1]; break; }
  }

  if (!zip) {
    const m = document.title.match(/\b(\d{5})\b/);
    if (m) zip = m[1];
  }

  if (!zip) {
    for (const m of bodyText.matchAll(/\b(\d{5})\b/g)) {
      const n = parseInt(m[1], 10);
      if (n >= 500 && n <= 99999) { zip = m[1].padStart(5, '0'); break; }
    }
  }

  // ── City / state from title ───────────────────────────────────────────────
  let city = null, state = null;
  const locM = document.title.match(/[-–]\s*([^,|–-]+),\s*([A-Z]{2})\b/);
  if (locM) { city = locM[1].trim(); state = locM[2]; }

  if (price && price > 100 && beds != null && zip) {
    return { price, beds, zipCode: zip, address: null, city, state,
             homeStatus: 'FOR_RENT', isBuilding: false, source: 'dom' };
  }
  return null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function aptParsePrice(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function aptParseBeds(v) {
  if (v === 0 || v === '0') return 0;
  if (!v) return null;
  const s = String(v);
  if (/studio/i.test(s)) return 0;
  const m = s.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Register as shared extractor name used by content.js
window.__extractListing = extractApartments;
