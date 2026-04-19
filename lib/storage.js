// RentScope — lib/storage.js
// Storage helpers with rent_ prefix. Listing schema + makeListing().

const STORAGE_PREFIX = 'rent_';

// ── Keys ───────────────────────────────────────────────────────────────────────

const KEYS = {
  current:  STORAGE_PREFIX + 'current',   // active listing (session)
  saved:    STORAGE_PREFIX + 'saved',     // saved listings array (local)
  settings: STORAGE_PREFIX + 'settings', // user settings (local)
};

// ── Listing schema ─────────────────────────────────────────────────────────────
//
// {
//   id,           // urlToId(url) — djb2 hash
//   url,
//   source,       // 'zillow'
//   savedAt,
//   address, city, state, zipCode,
//   bedrooms,     // 0=Studio, 1..4
//   price,        // monthly rent
//   sqft,
//   fmrLevel,     // 'SAFMR' | 'county'
//   fmrAreaName,
//   fmrValue,     // FMR for the detected BR count
//   fmrYear,      // e.g. 2025
//   diffPct,      // (price - fmrValue) / fmrValue * 100
//   hcvEligible,  // boolean
// }

function urlToId(url) {
  // djb2 hash
  let h = 5381;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) + h) ^ url.charCodeAt(i);
    h = h >>> 0; // keep 32-bit unsigned
  }
  return h.toString(36);
}

function makeListing(raw, fmrData) {
  const br       = parseInt(raw.beds ?? 0, 10);
  const fmrValue = fmrData?.fmr?.[String(br)] ?? null;
  const diffPct  = (fmrValue && !raw.isBuilding)
    ? (raw.price - fmrValue) / fmrValue * 100
    : null;
  const officialHcvCap = fmrData?.hcv?.[br] ?? null;
  const hcvCap         = officialHcvCap || (fmrValue ? Math.round(fmrValue * 1.10) : null);
  const hcvEligible    = hcvCap != null ? raw.price <= hcvCap : null;

  return {
    id:          urlToId(raw.url || ''),
    url:         raw.url || '',
    source:      raw.source?.startsWith('nextdata') || raw.source?.startsWith('jsonld') || raw.source?.startsWith('meta') || raw.source?.startsWith('dom')
                   ? 'zillow' : (raw.source || 'zillow'),
    savedAt:     Date.now(),
    address:     raw.address  || null,
    city:        raw.city     || null,
    state:       raw.state    || null,
    zipCode:     raw.zipCode  || null,
    bedrooms:    br,
    price:       raw.price,
    sqft:        raw.sqft     || null,
    fmrLevel:    fmrData?.level    || null,
    fmrAreaName: fmrData?.areaName || null,
    fmrValue,
    fmrYear:     fmrData?.fy       || null,
    diffPct,
    hcvEligible,
  };
}

// ── Session helpers ────────────────────────────────────────────────────────────

function getCurrentListing(cb) {
  chrome.storage.session.get(KEYS.current, (r) => cb(r[KEYS.current] || null));
}

function setCurrentListing(data, cb) {
  chrome.storage.session.set({ [KEYS.current]: data }, cb);
}

function clearCurrentListing(cb) {
  chrome.storage.session.remove(KEYS.current, cb);
}

// ── Exports ────────────────────────────────────────────────────────────────────

window.RentStorage = {
  KEYS,
  urlToId,
  makeListing,
  getCurrentListing,
  setCurrentListing,
  clearCurrentListing,
};
