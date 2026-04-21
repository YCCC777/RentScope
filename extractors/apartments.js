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
  if (fromND) return attachPlans(fromND);

  const fromJLD = extractAptFromJsonLd();
  if (fromJLD) return attachPlans(fromJLD);

  const fromMeta = extractAptFromMeta();
  if (fromMeta) return attachPlans(fromMeta);

  return attachPlans(extractAptFromDOM());
}

function attachPlans(result) {
  if (!result) return null;
  if (result.isBuilding && !result.buildingPlans) {
    const plans = extractAptBuildingPlans();
    if (plans) {
      result.buildingPlans = plans;
      // Use cheapest plan's minPrice as the building price
      result.price = plans[0].minPrice;
    }
  }
  return result;
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
//   • Apartment / Product (often @type array) — individual unit price + beds
//   • Some pages use @graph with mainEntity.address for ZIP

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

  // @type may be a string or an array — normalize to lowercase string array
  function typeList(b) {
    const t = b['@type'];
    if (!t) return [];
    return (Array.isArray(t) ? t : [t]).map(s => String(s).toLowerCase());
  }
  function isType(b, ...types) {
    const tl = typeList(b);
    return types.some(t => tl.includes(t));
  }

  // Parse beds from free-text description: "4 SPACIOUS BEDROOMS", "1 bedroom", "Studio"
  function bedsFromText(text) {
    if (!text) return null;
    const s = String(text);
    if (/\bstudio\b/i.test(s)) return 0;
    // "4 SPACIOUS BEDROOMS" — allow up to 2 filler words between number and bedroom(s)
    const m = s.match(/\b(\d+)\s+(?:\w+\s+){0,2}bedrooms?\b/i)
           || s.match(/\b(\d+)\s*(?:bed|br)\b/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // Collect ApartmentComplex address for fallback
  let complexAddr = null;
  for (const b of blocks) {
    if (isType(b, 'apartmentcomplex', 'localbusiness', 'realestatecondominiumunit',
               'residentialbuilding') || (isType(b, 'place') && b.address)) {
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

  // Look for specific unit data (Apartment / Product / etc.)
  let buildingCandidate = null;  // price+zip found but no beds — building fallback
  for (const b of blocks) {
    if (!isType(b, 'apartment', 'product', 'accommodation', 'residence',
                   'singlefamilyresidence', 'house', 'condominium', 'townhouse',
                   'apartmentunit', 'realestalelisting', 'realestatelisting')) continue;

    const price = aptParsePrice(
      b.offers?.price || b.offers?.lowPrice || b.price
    );

    // ZIP: own address → mainEntity.address → complexAddr
    const addrSrc = b.address || b.mainEntity?.address;
    const zip = jldZip(addrSrc) || complexAddr?.zipCode;

    // Beds: structured fields → description free text
    let beds = aptParseBeds(b.numberOfBedrooms ?? b.numberOfRooms);
    if (beds == null) beds = bedsFromText(b.name);
    if (beds == null) beds = bedsFromText(b.description);
    // mainEntity may carry beds info
    if (beds == null && b.mainEntity) {
      beds = aptParseBeds(b.mainEntity.numberOfBedrooms ?? b.mainEntity.numberOfRooms);
      if (beds == null) beds = bedsFromText(b.mainEntity.description);
    }

    if (price > 100 && beds != null && zip) {
      return {
        price, beds, zipCode: zip,
        address: addrSrc?.streetAddress || complexAddr?.address || null,
        city:    addrSrc?.addressLocality || complexAddr?.city   || null,
        state:   addrSrc?.addressRegion   || complexAddr?.state  || null,
        homeStatus: 'FOR_RENT',
        isBuilding: false,
        source: 'jsonld',
      };
    }

    // Price + zip but no beds → save as building candidate
    if (price > 100 && zip && !buildingCandidate) {
      buildingCandidate = { price, zip, addrSrc };
    }
  }

  // No unit with beds — return as building if we have price + zip
  if (buildingCandidate) {
    const { price, zip, addrSrc } = buildingCandidate;
    return {
      price, beds: 0, zipCode: zip,
      address: addrSrc?.streetAddress || complexAddr?.address || null,
      city:    addrSrc?.addressLocality || complexAddr?.city   || null,
      state:   addrSrc?.addressRegion   || complexAddr?.state  || null,
      homeStatus: 'FOR_RENT',
      isBuilding: true,
      source: 'jsonld_building',
    };
  }

  // Have address but no unit price — try priceRange or any offer price
  if (complexAddr) {
    for (const b of blocks) {
      // priceRange: "$1,500 - $3,000" — building-level data, mark as isBuilding
      if (b.priceRange) {
        const m = String(b.priceRange).match(/\$([\d,]+)/);
        if (m) {
          const price = parseInt(m[1].replace(/,/g, ''), 10);
          if (price > 100) {
            return { ...complexAddr, price, beds: 0,
                     homeStatus: 'FOR_RENT', isBuilding: true,
                     source: 'jsonld_complex' };
          }
        }
      }
      // aggregateOffer lowPrice
      const low = aptParsePrice(b.offers?.lowPrice || b.offers?.price);
      if (low > 100) {
        return { ...complexAddr, price: low, beds: 0,
                 homeStatus: 'FOR_RENT', isBuilding: true,
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

  // Price: "$1,500/mo", "$1,500 - $3,000/mo", "from $4,500", "starting at $852"
  const priceM = combined.match(/\$([\d,]+)\s*(?:\/\s*mo|per month)/i)
              || combined.match(/\b(?:from|starting\s+at)\s+\$([\d,]+)/i);
  const price  = priceM ? parseInt(priceM[1].replace(/,/g, ''), 10) : null;
  const isRange = /\$([\d,]+)\s*[-–]\s*\$([\d,]+)/i.test(combined);

  // Beds — explicit count takes priority over "studio" keyword (building titles often
  // mention "Studio, 1-4 Beds" even on non-studio unit pages)
  let beds = null;
  const bm = combined.match(/(\d+)\s*(?:bed|br)\b/i);
  if (bm) beds = parseInt(bm[1], 10);
  else if (/\bstudio\b/i.test(combined)) beds = 0;

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

  if (price && price > 100 && (zip || zipFromStreet)) {
    const hasUnit = beds != null;
    return {
      price,
      beds:      hasUnit ? beds : 0,
      zipCode:   zip || zipFromStreet,
      address:   streetMeta || null,
      city, state,
      homeStatus: 'FOR_RENT',
      isBuilding: !hasUnit,
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
    const m = bodyText.match(/(\d+)\s*(?:bed|br)\b/i);
    if (m) beds = parseInt(m[1], 10);
    else if (/\bstudio\b/i.test(bodyText)) beds = 0;
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

// Parse bed count from Apartments.com floor plan labels: "Studio", "One Bedroom", "1 Bed", etc.
function aptParseBedLabel(text) {
  if (!text) return null;
  const s = text.toLowerCase().trim();
  if (/^studio/.test(s)) return 0;
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  for (var w in words) {
    if (s.startsWith(w + ' ')) return words[w];
  }
  const m = s.match(/^(\d+)\s*(?:bed|br)/);
  return m ? parseInt(m[1], 10) : null;
}

// Extract per-unit floor plan data from Apartments.com pricingGrid DOM.
// Returns array of { beds, minPrice, maxPrice } or null.
function extractAptBuildingPlans() {
  var items = document.querySelectorAll('[class*="pricingGridItem"]');
  if (!items.length) return null;

  var seen = {};
  var plans = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];

    var bedEl   = item.querySelector('[class*="priceBedRange"],[class*="bedLabel"],[class*="modelName"]');
    var bedText = bedEl ? bedEl.textContent.trim() : '';
    var beds = aptParseBedLabel(bedText);
    if (beds == null) {
      // fallback: first line of item text
      beds = aptParseBedLabel(item.textContent.trim().split(/\n/)[0]);
    }
    if (beds == null) continue;
    if (seen[beds]) continue;
    seen[beds] = true;

    var priceEl   = item.querySelector('[class*="rentLabel"]');
    var priceText = priceEl ? priceEl.textContent.trim() : item.textContent;
    var prices = [];
    var re = /\$([\d,]+)/g;
    var pm;
    while ((pm = re.exec(priceText)) !== null) {
      prices.push(parseInt(pm[1].replace(/,/g, ''), 10));
    }
    var minPrice = prices[0];
    var maxPrice = prices[1] || prices[0];
    if (!minPrice || minPrice < 100) continue;

    plans.push({ beds: beds, minPrice: minPrice, maxPrice: maxPrice });
  }

  return plans.length > 0 ? plans : null;
}

// Register as shared extractor name used by content.js
window.__extractListing = extractApartments;
