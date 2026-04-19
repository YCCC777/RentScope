// RentScope — extractors/zillow.js
//
// Pre-navigation fingerprint for stale-gdp detection:
//   undefined = initial F5 (no SPA nav recorded yet)
//   null      = prior page had no gdp.building (e.g. search page)
//   string    = bestMatchedUnit.hdpUrl of the building shown before nav
// Set by window.__rsSnapshotGdp(), called from content.js on every URL change.
let _preNavBmuHdpUrl; // eslint-disable-line prefer-const
// Extracts rental listing data from Zillow.
//
// Zillow has two URL patterns:
//   1. /apartments/.../<name>/<id>/  → building detail page (gdp.building Redux state)
//   2. /homedetails/.../             → Traditional detail page (some rentals + for-sale)
//
// /apartments/ extraction layers (tried in order):
//   L0: gdp.building Redux state  — current structure (2026+)
//       initialReduxState.gdp.building → zipcode/city/state + floorPlans[].beds/price
//   L1: __NEXT_DATA__ listResults — legacy structure (pre-2026)
//   L2: DOM text fallback
//
// Returns: { price, beds, zipCode, address, city, state, homeStatus, isBuilding, source }
//          or null if extraction fails.

function extractZillow() {
  const path = location.pathname;
  if (path.includes('/apartments/')) return extractApartmentsPanel();
  if (path.includes('/homedetails/'))  return extractHomeDetails();
  // /b/<address-slug>/ — individual building pages (same gdp.building structure)
  if (path.startsWith('/b/')) return extractApartmentsPanel();
  return null;
}

// ── Pattern 1: /apartments/ building detail page ──────────────────────────────

// Returns true when the gdp.building data in window.__NEXT_DATA__ corresponds to
// the building currently shown in the URL (i.e. it is fresh, not stale from a
// prior navigation). Called only for building-level URLs (no unit zpid in URL).
//
// Primary check: compare the trailing alphanumeric ID in the URL
//   (".../urbanlux-sunset-premium-5YsP4L/") with the ID embedded in
//   gdp.bestMatchedUnit.hdpUrl (".../1425-n-alta-vista-blvd-Cr7yCW/<zpid>_zpid/").
// If they don't match, the gdp came from a different building → stale.
//
// Fallback checks (when bestMatchedUnit is absent): static tag comparison and
// listResults. If no signal is available → assume fresh to avoid infinite retry.
function isBuildingGdpFresh(gdp) {
  const urlId = location.pathname.split('/').filter(Boolean).at(-1);
  console.log('[RS-DBG] isBuildingGdpFresh: urlId=', urlId,
    '| bmuHouseNum=', gdp.bmuHouseNum,
    '| bmuHdpUrl=', gdp.bmuHdpUrl,
    '| preNav=', _preNavBmuHdpUrl,
    '| zip=', gdp.zipCode);

  // ── Primary: house-number comparison via bestMatchedUnit.hdpUrl ───────────
  // bestMatchedUnit.hdpUrl is a /homedetails/ URL whose slug encodes the unit's
  // street address, e.g. "/homedetails/1425-N-Alta-Vista-Blvd-APT-223.../zpid/".
  // Extracting the leading house number ("1425") and comparing it with the current
  // URL's leading house number (if the URL uses an address-based slug) is the most
  // reliable per-building identifier available without network requests.
  //
  // Covers:
  //   Address-slug URL  "1425-n-alta-vista-blvd-Cr7yCW": house="1425" → compare ✓
  //   Name-slug URL     "urbanlux-sunset-premium-5YsP4L": no leading digit → skip
  //   Pure-ID URL       "5XjSGZ": no leading digit → skip
  if (gdp.bmuHouseNum) {
    const urlHouseNum = urlId.match(/^(\d+)-/)?.[1] || null;
    if (urlHouseNum) {
      return urlHouseNum === gdp.bmuHouseNum; // address-slug URL: exact house-number check
    }
    // name-slug or pure-ID URL → fall through to tag/listResults checks below
  }

  // ── Fallback 1: URL area-segment ZIP mismatch → definitely stale ──────────
  // Pattern: /apartments/los-angeles-ca/-90046/building-name-5YsP4L/
  const urlZip = location.pathname.match(/-(\d{5})\/[A-Za-z0-9_-]+\/?$/)?.[1];
  if (urlZip && urlZip !== gdp.zipCode) return false;

  // ── Fallback 2: static __NEXT_DATA__ script tag ───────────────────────────
  let staticNd = null;
  try { staticNd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}'); } catch (_) {}

  if (staticNd) {
    // 2-pre. query.slug check — most reliable signal for pure-ID / name-slug URLs.
    //
    // Next.js stores dynamic route segments in __NEXT_DATA__.query.slug (array).
    // For /apartments/los-angeles-ca/urbanlux-fleur/5XjSGZ/ the static tag's
    // query.slug = ['los-angeles-ca', 'urbanlux-fleur', '5XjSGZ'] when the page
    // was server-loaded (F5) for that specific building.
    //
    // When Zillow intercepts a browser bookmark / address-bar navigation as SPA,
    // the static tag retains the PREVIOUS page's data — urlId will NOT appear in
    // the prior page's slug → stale. This runs BEFORE the building-comparison
    // block (2a) which would otherwise falsely confirm fresh when the static
    // building's houseNum/zip happen to match the stale live gdp data.
    const slugArr = staticNd?.query?.slug;
    if (Array.isArray(slugArr) && slugArr.length > 0) {
      const found = slugArr.includes(urlId);
      console.log('[RS-DBG] query.slug=', slugArr, '| urlId in slug:', found);
      if (found)  return true;  // static tag was loaded FOR this building → fresh
      return false;             // static tag was for a different building → stale
    }

    // 2a. F5 on /apartments/: static tag has gdp.building for the page that was loaded.
    //     Use house-number comparison — but for name-slug / pure-ID URLs (urlHouseNum null)
    //     only return FALSE (contradicting evidence), never TRUE:
    //     a house-number match only proves the static and live gdp are from the SAME
    //     prior building, not that the current URL IS that building.
    const sb = staticNd?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building;
    if (sb) {
      const sbBmuUrl   = sb.bestMatchedUnit?.hdpUrl || '';
      const sbHouseNum = sbBmuUrl.match(/\/homedetails\/(\d+)-/)?.[1] || null;
      if (sbHouseNum && gdp.bmuHouseNum) {
        const sz = String(sb.zipcode || '').trim().padStart(5, '0');
        if (sbHouseNum !== gdp.bmuHouseNum || sz !== gdp.zipCode) {
          console.log('[RS-DBG] Fallback2a: static bldg mismatch → STALE');
          return false;
        }
        // match — but urlHouseNum is null (name-slug), can't confirm current URL → fall through
        console.log('[RS-DBG] Fallback2a: houseNum/zip match but name-slug → fall through');
      } else {
        const sz = String(sb.zipcode || '').trim().padStart(5, '0');
        if (sz && gdp.zipCode && sz !== gdp.zipCode) return false;
      }
    }

    // 2b. F5 on search page: static tag has listResults — find this building.
    const listR = staticNd?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults;
    if (Array.isArray(listR)) {
      const hit = listR.find(r => typeof r.detailUrl === 'string' && r.detailUrl.includes(`/${urlId}/`));
      if (hit) {
        const hz = String(hit.addressZipcode || '').trim().padStart(5, '0');
        const ha = (hit.addressStreet || '').toLowerCase().trim();
        const ga = (gdp.address     || '').toLowerCase().trim();
        return hz === gdp.zipCode && (!ha || !ga || ha === ga);
      }
    }
  }

  // ── Fallback 3: live window.__NEXT_DATA__ listResults ────────────────────
  try {
    const liveNd    = readPageVar('window.__NEXT_DATA__');
    const liveListR = liveNd?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults;
    if (Array.isArray(liveListR)) {
      const hit = liveListR.find(r => typeof r.detailUrl === 'string' && r.detailUrl.includes(`/${urlId}/`));
      if (hit) {
        const hz = String(hit.addressZipcode || '').trim().padStart(5, '0');
        const ha = (hit.addressStreet || '').toLowerCase().trim();
        const ga = (gdp.address     || '').toLowerCase().trim();
        return hz === gdp.zipCode && (!ha || !ga || ha === ga);
      }
    }
  } catch (_) {}

  // ── Fallback 4: URL ZIP matched and no contradicting evidence ─────────────
  if (urlZip) return true;

  // ── Pre-navigation fingerprint ────────────────────────────────────────────
  // Guards the gap when query.slug is absent (e.g. F5 on search page) and
  // gdp.building came from the Redux store which persists across SPA navs.
  //
  //   undefined → first content-script run, no prior URL change recorded.
  //               query.slug above would have caught SPA-intercepted cases
  //               where slug is available → assume fresh here.
  //   null      → prior page had no gdp.building (search page) →
  //               Redux may hold stale building data → retry.
  //   equal     → gdp.building unchanged since URL change → stale.
  //   not equal → gdp.building was updated by Zillow → fresh.
  if (_preNavBmuHdpUrl === undefined) {
    console.log('[RS-DBG] isBuildingGdpFresh: preNav=undefined → FRESH');
    return true;
  }
  if (_preNavBmuHdpUrl === null) {
    console.log('[RS-DBG] isBuildingGdpFresh: preNav=null (from search) → STALE');
    return false;
  }
  if (gdp.bmuHdpUrl && gdp.bmuHdpUrl === _preNavBmuHdpUrl) {
    console.log('[RS-DBG] isBuildingGdpFresh: bmuHdpUrl unchanged → STALE');
    return false;
  }
  console.log('[RS-DBG] isBuildingGdpFresh: bmuHdpUrl changed → FRESH');
  return true;
}

function extractApartmentsPanel() {
  // Unit-specific /apartments/ URL: /apartments/.../<zpid>_zpid/
  // Zillow navigates here (not /homedetails/) when clicking a unit within a building panel.
  const zpidM  = location.pathname.match(/\/(\d+)_zpid/);
  const urlZpid = zpidM?.[1] || null;
  console.log('[RS-DBG] extractApartmentsPanel: urlZpid=', urlZpid, '| path=', location.pathname);

  // L1 (building-level only): listResults — URL-ID match is always fresh.
  // Try this BEFORE gdp.building for building-level URLs because gdp.building
  // persists from a prior building navigation and is often stale. listResults
  // is matched by the current URL's last path segment → always the right building.
  if (!urlZpid) {
    const listHit = extractFromListResults();
    console.log('[RS-DBG] listResults hit:', listHit ? `zip=${listHit.zipCode} price=${listHit.price}` : 'null');
    if (listHit) return listHit;
  }

  // L0: gdp.building — pass URL zpid so we look up the exact unit, not bestMatchedUnit.
  // If urlZpid is provided but unit not found in floor plans (stale/different building),
  // extractFromGdpBuilding returns null and we fall through to meta-based sources.
  const gdp = extractFromGdpBuilding(urlZpid || undefined);
  console.log('[RS-DBG] extractFromGdpBuilding:', gdp ? `zip=${gdp.zipCode} price=${gdp.price} bmuHdpUrl=${gdp.bmuHdpUrl}` : 'null');
  if (gdp) {
    if (!urlZpid) {
      // listResults already tried above and returned null (building not in search results).
      // Verify gdp is for this building before returning it — gdp.building can be stale
      // from a prior navigation. isBuildingGdpFresh() uses house-number from
      // bestMatchedUnit.hdpUrl vs current URL slug, plus tag/listResults cross-checks.
      const fresh = isBuildingGdpFresh(gdp);
      console.log('[RS-DBG] isBuildingGdpFresh result:', fresh);
      if (!fresh) return null; // stale — retry
    }
    return gdp;
  }

  // L1 (unit-specific): listResults fallback
  if (urlZpid) {
    const listHit = extractFromListResults();
    if (listHit) return listHit;
  }

  // L2: For unit-specific URLs (/apartments/.../ZPID_zpid/), use meta/JSON-LD extraction.
  // The page meta[name="description"] updates to reflect the specific unit on SPA nav.
  // DOM is skipped — /apartments/ page has building/search content → wrong data.
  if (urlZpid) {
    // ZIP may not be in URL slug for building-ID style URLs (e.g. /urbanlux-sunset/5YsP4L/...)
    // Fall back to gdp.building.zipcode if extractHomeDetailsMultiSource can't find it.
    let multiHit = extractHomeDetailsMultiSource();
    if (!multiHit) {
      const liveNd = readPageVar('window.__NEXT_DATA__');
      const bldgZip = String(
        liveNd?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building?.zipcode || ''
      ).trim().padStart(5, '0');
      if (bldgZip && bldgZip !== '00000') multiHit = extractHomeDetailsMultiSource(bldgZip);
    }
    if (multiHit) return { ...multiHit, source: 'multi_source' };
    return null; // retry — wait for meta to update
  }

  // L2: DOM fallback (building-level page, no specific unit in URL).
  // Skip for /b/ and /apartments/ — stale content causes wrong results.
  if (location.pathname.startsWith('/b/') || location.pathname.includes('/apartments/')) return null;

  return extractFromDOM();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Content scripts run in an isolated world and cannot read page JS variables
// (e.g. window.__NEXT_DATA__). We inject a tiny inline script that copies the
// value to a DOM attribute so our isolated-world script can read it.
function readPageVar(varPath) {
  try {
    const attr = 'data-rentscope-tmp';
    const s = document.createElement('script');
    s.textContent = `document.documentElement.setAttribute(
      '${attr}', JSON.stringify(${varPath} || null));`;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    const raw = document.documentElement.getAttribute(attr);
    document.documentElement.removeAttribute(attr);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

// ── L0: gdp.building Redux state ──────────────────────────────────────────────
// Structure (verified 2026-04-13):
//   __NEXT_DATA__.props.pageProps.componentProps.initialReduxState.gdp.building
//   building.zipcode / city / state / streetAddress
//   building.floorPlans[i] → { beds, minPrice, maxPrice, units: [{price, beds, zpid}] }
//   building.bestMatchedUnit → { hdpUrl: ".../<zpid>_zpid/", unitNumber }

// overrideZpid: when called from extractHomeDetails() with stale gdp.building,
// pass the current URL's zpid so we search the floor plans by that zpid rather
// than by bestMatchedUnit (which may point to a different unit in the old building).
function extractFromGdpBuilding(overrideZpid) {
  try {
    // Try SSR __NEXT_DATA__ first (populated on SPA navigation)
    // Then try live window Redux store (populated after CSR hydration on direct navigation)
    let b = null;

    // On SPA navigation Next.js updates window.__NEXT_DATA__ (page JS variable) but
    // NOT the script tag. Content scripts can't read page JS directly (isolated world),
    // so we use readPageVar() which injects a tiny inline script to bridge the gap.
    const liveNd = readPageVar('window.__NEXT_DATA__');
    const nd = liveNd
      || JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}');
    b = nd?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building;

    // ── asPath freshness gate ──────────────────────────────────────────────────
    // Next.js stores the current route's as-path in window.__NEXT_DATA__.asPath.
    // It is updated atomically with the rest of __NEXT_DATA__ on every SPA nav,
    // making it the most reliable freshness signal available without extra network
    // requests. Compare it (pathname only — strip query) with location.pathname:
    //
    //   match   → __NEXT_DATA__ (and its gdp.building) belongs to this page.
    //   mismatch → __NEXT_DATA__ still reflects a prior navigation; gdp.building
    //              inside it is stale. Do NOT use it, and do NOT fall back to the
    //              Redux store either — Redux holds the same-vintage stale data.
    //              Return null so the retry loop waits for Next.js to update.
    //   absent  → unknown (older Zillow build or search page); fall through to
    //              Redux fallback with existing house-number / ZIP checks.
    const ndAsPath   = (liveNd?.asPath || '').split('?')[0]; // strip query string
    const curPath    = location.pathname;
    const asPathMatch =
      ndAsPath
        ? ndAsPath.replace(/\/$/, '') === curPath.replace(/\/$/, '')
        : null; // null = asPath absent — can't determine
    console.log('[RS-DBG] extractFromGdpBuilding: asPath=', ndAsPath || '(none)',
      '| match=', asPathMatch, '| gdpB=', b ? 'found' : 'null');

    if (asPathMatch === false) {
      // __NEXT_DATA__ is for a different URL — the entire Redux state inside it
      // (including gdp.building) is from the previous page. Returning null forces
      // a retry and prevents stale data from ever reaching isBuildingGdpFresh().
      console.log('[RS-DBG] asPath mismatch → discarding, returning null (will retry)');
      return null;
    }

    if (!b && asPathMatch === true) {
      // __NEXT_DATA__ is current (asPath matches) but gdp.building is not yet
      // populated — Zillow is still doing CSR / API fetch. Do NOT fall back to
      // the Redux store: it contains the previous building's data and would cause
      // stale data to appear. Return null → retry loop waits for CSR to finish.
      console.log('[RS-DBG] asPath matches but gdp.building null → waiting for CSR');
      return null;
    }

    // asPathMatch === null (asPath absent — search page or older Zillow build):
    // fall through to Redux for backward compat.

    // On direct URL navigation Zillow does CSR: Redux state empty in __NEXT_DATA__.
    // After hydration, the live store is accessible via window globals.
    if (!b) {
      // Try common Next.js/Redux window globals
      for (const key of ['__NEXT_REDUX_STORE__', '__reduxStore__', '__store__']) {
        const store = window[key];
        if (store?.getState) {
          b = store.getState()?.gdp?.building;
          if (b) break;
        }
      }
    }

    // Try reading from any window key that looks like a Redux store with gdp state
    if (!b) {
      for (const key of Object.keys(window)) {
        if (key.startsWith('__') && window[key]?.getState) {
          try {
            const s = window[key].getState();
            if (s?.gdp?.building) { b = s.gdp.building; break; }
          } catch (_) {}
        }
      }
    }

    if (!b) return null;

    const zipCode = String(b.zipcode || '').trim().padStart(5, '0');
    if (!zipCode || zipCode === '00000') return null;

    const floorPlans = Array.isArray(b.floorPlans) ? b.floorPlans : [];
    if (floorPlans.length === 0) return null;

    // Pin to the specific unit:
    // - overrideZpid: provided by extractHomeDetails() from the current URL — avoids
    //   relying on bestMatchedUnit which may point to a different unit when gdp.building
    //   is stale from a prior /apartments/ navigation.
    // - bmuZpid fallback: normal /apartments/ + /b/ usage where bestMatchedUnit is fresh.
    const bmuZpid = overrideZpid
      || b.bestMatchedUnit?.hdpUrl?.match(/\/(\d+)_zpid\//)?.[1];

    let price = null;
    let beds  = null;
    let isBuilding = false;

    if (bmuZpid) {
      // Find the matching unit across all floor plans
      outer: for (const plan of floorPlans) {
        for (const unit of (plan.units || [])) {
          if (String(unit.zpid) === bmuZpid) {
            price = unit.price ?? unit.minPrice ?? plan.minPrice;
            // plan.beds defines the floor plan type and is more reliable than unit.beds,
            // which Zillow sometimes sets to 0 even for non-Studio units (data quality issue).
            beds  = plan.beds ?? unit.beds;
            // isBuilding: true when the building lists multiple floor plan types,
            // regardless of how many currently have available units.
            isBuilding = floorPlans.length > 1;
            break outer;
          }
        }
      }
    }

    // Unit not found: when overrideZpid was given, the building data is stale or from a
    // different building — don't fall back to cheapest floor plan (would show Studio).
    // Return null so extractApartmentsPanel() can try meta/JSON-LD sources instead.
    if (price == null && overrideZpid) return null;

    if (price == null) {
      // No unit match — use available floor plans to show building-level data
      const available = floorPlans.filter(p => (p.units || []).length > 0);
      if (available.length > 0) {
        // Show cheapest available floor plan
        available.sort((a, b) => (a.minPrice || 0) - (b.minPrice || 0));
        price = available[0].minPrice;
        beds  = available[0].beds;
      } else {
        // Nothing available — show cheapest listed floor plan
        const cheapest = [...floorPlans].sort((a, b) =>
          (a.minPrice || 0) - (b.minPrice || 0)
        )[0];
        price = cheapest?.minPrice;
        beds  = cheapest?.beds;
      }
      // More than one floor plan type → building-level display
      isBuilding = floorPlans.length > 1;
    }

    if (!price || price < 100) return null;
    beds = parseBeds(beds);
    if (beds == null) return null;

    // For multi-unit buildings, collect all floor plan types (including those with no
    // currently available units) so the overlay shows the full BR breakdown.
    // Deduplicates by bed count — Zillow sometimes lists the same BR type multiple
    // times (e.g. two "2BR" plans at the same price); keep the lowest minPrice each.
    let buildingPlans = null;
    if (isBuilding) {
      const allPlans = floorPlans
        .map(p => ({
          beds:     parseBeds(p.beds) ?? 0,
          minPrice: p.minPrice || 0,
          maxPrice: p.maxPrice || p.minPrice || 0,
        }))
        .filter(p => p.minPrice > 100)
        .sort((a, b) => a.beds - b.beds);
      const seen = new Set();
      const deduped = [];
      for (const p of allPlans) {
        if (!seen.has(p.beds)) { seen.add(p.beds); deduped.push(p); }
      }
      if (deduped.length > 1) buildingPlans = deduped;
    }

    // Extract the house number from bestMatchedUnit's homedetails URL so that
    // isBuildingGdpFresh() can detect cross-building staleness via address mismatch.
    // bestMatchedUnit.hdpUrl is always a /homedetails/ URL (unit-level), e.g.:
    //   /homedetails/1425-N-Alta-Vista-Blvd-APT-223-Los-Angeles-CA-90046/2088603809_zpid/
    // The leading house number ("1425") uniquely identifies the street address — if the
    // current URL's slug starts with a different house number, the building is different.
    const bmuHdpUrl   = b.bestMatchedUnit?.hdpUrl || null;
    const bmuHouseNum = bmuHdpUrl?.match(/\/homedetails\/(\d+)-/)?.[1] || null;

    return {
      price,
      beds,
      zipCode,
      address:      b.streetAddress || null,
      city:         b.city          || null,
      state:        b.state         || null,
      homeStatus:   'FOR_RENT',
      isBuilding,
      buildingPlans,
      bmuHouseNum, // house number from bestMatchedUnit — used by isBuildingGdpFresh()
      bmuHdpUrl,   // full hdpUrl — used by isBuildingGdpFresh() fingerprint check
      source:       'gdp_building',
    };
  } catch (_) {
    return null;
  }
}

// ── L1: legacy listResults (pre-2026 Zillow structure) ────────────────────────

function extractFromListResults() {
  try {
    // Try live window.__NEXT_DATA__ first (updated by Next.js on every SPA nav).
    // The live variable carries searchPageState from the search context the user
    // navigated from — even on /b/ and /apartments/ pages. This lets us find the
    // listing in search results regardless of which page triggered the navigation.
    // Falls back to the static script tag (initial page-load data).
    const liveNd = readPageVar('window.__NEXT_DATA__');
    const nd = liveNd
      || JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}');

    const results =
      nd?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults;
    if (!Array.isArray(results)) return null;

    const urlId = location.pathname.split('/').filter(Boolean).at(-1);
    const match = results.find(r =>
      typeof r.detailUrl === 'string' && r.detailUrl.includes(`/${urlId}/`)
    );
    return match ? parseListResult(match) : null;
  } catch (_) {
    return null;
  }
}

function parseListResult(r) {
  const status = (r.statusType || r.rawHomeStatusCd || '').toUpperCase();
  if (status && !status.includes('RENT')) return null;

  const zipCode = String(r.addressZipcode || '').trim().padStart(5, '0');
  if (!zipCode || zipCode === '00000') return null;

  // /apartments/ buildings use r.isBuilding=true + r.units[{price,beds}]
  // Legacy individual units use r.price / r.unformattedPrice / r.beds
  const isBuilding = r.isBuilding === true || String(r.price || '').includes('+');

  let price = null;
  let beds  = null;
  let buildingPlans = null;

  if (isBuilding && Array.isArray(r.units) && r.units.length > 0) {
    // Build floor plans from units array; each entry is one bed-type tier
    const plans = r.units
      .filter(u => !u.roomForRent)
      .map(u => ({
        beds:     parseBeds(u.beds) ?? 0,
        minPrice: toNumber(u.price),
        maxPrice: toNumber(u.price),
      }))
      .filter(p => p.minPrice > 100)
      .sort((a, b) => a.minPrice - b.minPrice);

    if (plans.length === 0) return null;
    price = plans[0].minPrice;   // cheapest floor plan's starting price
    beds  = plans[0].beds;
    if (plans.length > 1) buildingPlans = plans;
  } else {
    // Individual unit (homedetails SPA nav) or older building format
    const priceStr = String(r.price || '');
    if (!isNaN(r.unformattedPrice)) {
      price = parseInt(r.unformattedPrice, 10);
    } else {
      const m = priceStr.match(/[\d,]+/);
      if (m) price = parseInt(m[0].replace(/,/g, ''), 10);
    }
    beds = parseBeds(r.beds);
    if (beds == null) {
      if (isBuilding) beds = 0; // older building with no single bed type
      else return null;
    }
  }

  if (!price || price < 100) return null;
  if (beds == null) return null;

  return {
    price, beds, zipCode,
    address:       r.addressStreet || null,
    city:          r.addressCity   || null,
    state:         r.addressState  || null,
    homeStatus:    'FOR_RENT',
    isBuilding,
    buildingPlans: buildingPlans || null,
    source:        'nextdata_apartments',
  };
}

// ── Pattern 2: /homedetails/ traditional page ─────────────────────────────────

function extractHomeDetails() {
  // Extract zpid from URL: /homedetails/<address>/<zpid>_zpid/
  const zpidM      = location.pathname.match(/\/(\d+)_zpid/);
  const targetZpid = zpidM?.[1] || null;

  // Hoisted so the DOM-block check after try/catch can see it.
  let hasStaleBuilding = false;

  // L1: __NEXT_DATA__ — zpid-targeted first (avoids adjacent-listing false matches),
  //     then generic recursive scan as fallback.
  try {
    const liveNd = readPageVar('window.__NEXT_DATA__');
    const nd = liveNd || JSON.parse(
      document.getElementById('__NEXT_DATA__')?.textContent || '{}'
    );

    // Detect whether live __NEXT_DATA__ has gdp.building — this means we are on a
    // /homedetails/ page for a unit that is PART OF A BUILDING (building context
    // is included in the page's Redux state so the floor-plan sidebar can render).
    hasStaleBuilding =
      !!(liveNd?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building);

    // ── Stale-building path ───────────────────────────────────────────────────
    // After F5 on /apartments/, window.__NEXT_DATA__ carries gdp.building from that
    // page. On SPA nav to /homedetails/ Next.js keeps componentProps (floor-plan
    // sidebar still needs it), so hasStaleBuilding stays true throughout all retries.
    //
    // We do NOT call extractFromGdpBuilding(targetZpid) here: Zillow stores some units
    // under the wrong floor plan (e.g. a 1BR unit in the Studio plan with plan.beds=0),
    // so extractFromGdpBuilding returns incorrect beds=0. Skip it entirely and wait for
    // meta[name="description"] to carry the correct per-unit data instead.
    //
    // Strategy:
    //   1. Wait for meta[name="description"] to update to homedetails content
    //      ("listed for rent at $X /mo" is unique to single-unit pages).
    //      The apartments-page meta may mention "Studio" as a unit type → if we read
    //      it too early we get wrong beds=0. Return null to keep the retry loop alive.
    //   2. Once meta is ready, extractHomeDetailsMultiSource() reads it correctly.
    //
    // extractFromListResults() is skipped here: searchPageState in this context may
    // be the building's unit list where r.beds=0 for non-Studio units (Zillow bug).
    if (hasStaleBuilding) {
      // Wait until meta[name="description"] reflects THIS listing, not the previous
      // /apartments/ building page. Homedetails meta always starts with the street
      // address ("1341 E 60th St..."); building meta starts with the building name
      // ("Metro at Florence..."). Extract the house number from the URL and verify
      // the meta starts with it — cheap, reliable, no false positives.
      const houseNum = location.pathname.match(/\/homedetails\/(\d+)-/)?.[1];
      const metaContent =
        document.querySelector('meta[name="description"]')?.content || '';
      if (!houseNum || !metaContent.startsWith(houseNum)) return null; // retry

      // Meta is verified fresh. Extract directly from meta only — skip JSON-LD and
      // page title which may still carry stale building floor-plan data:
      // - JSON-LD numberOfBedrooms can be 0 for non-Studio units (Zillow data quality)
      // - JSON-LD / title descriptions mention "Studio" floor plan even on 1BR/2BR pages
      // Explicit bed count takes priority over the "studio" keyword.
      const zip = location.pathname.match(/-(\d{5})\/\d+_zpid/)?.[1];
      if (!zip) return null;
      let beds = null;
      // Match "3 bed", "3-bed", "3bedroom", "3-bedroom" — Zillow uses both formats
      const bedM = metaContent.match(/\b(\d+)[-\s]*bed(?:room)?/i);
      if (bedM) beds = parseInt(bedM[1], 10);
      else if (/\bstudio\b/i.test(metaContent)) beds = 0;
      // Also check price from meta
      let price = null;
      const priceM = metaContent.match(/\$\s*([\d,]+)\s*\/\s*mo/i);
      if (priceM) price = parseInt(priceM[1].replace(/,/g, ''), 10);
      // If price not in meta, try JSON-LD (price fields are reliable; skip beds fields)
      if (!price) {
        for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const d = JSON.parse(el.textContent);
            const t = [].concat(d['@type'] || '').join(',').toLowerCase();
            if (t.includes('breadcrumb') || t.includes('itemlist') ||
                t.includes('place')      || t.includes('website')) continue;
            const p = toNumber(d.offers?.price || d.price);
            if (p > 100) { price = p; break; }
          } catch (_) {}
        }
      }
      if (beds == null || !price) return null; // not ready yet — retry
      return {
        price, beds,
        zipCode:    zip.padStart(5, '0'),
        address:    null, city: null, state: null,
        homeStatus: 'FOR_RENT',
        isBuilding: false,
        source:     'meta_stale',
      };
    } else {
      // ── Normal path (no stale building) ──────────────────────────────────

      // L1a: zpid-targeted lookup in gdpClientCache (direct URL navigation)
      if (targetZpid) {
        const hit = findByZpid(nd, targetZpid);
        if (hit) return { ...hit, source: 'nextdata_zpid' };
      }

      // L1b: listResults — SPA nav from search page; listing in searchPageState
      const listHit = extractFromListResults();
      if (listHit) return listHit;

      // L1c: generic recursive scan (last resort for direct nav)
      const hit = findRentalObject(nd);
      if (hit) return { ...hit, source: 'nextdata_homedetails' };
    }
  } catch (_) {}

  // L2: Multi-source — combines URL zip + JSON-LD price + title/meta beds.
  // Zillow homedetails pages have no listing data in __NEXT_DATA__ (Apollo GraphQL
  // fetches it client-side). But URL slug always has the ZIP, JSON-LD has price.
  // Beds come from JSON-LD description text, page title, or og:description (F5 only).
  const multiHit = extractHomeDetailsMultiSource();
  if (multiHit) return { ...multiHit, source: 'multi_source' };

  // L3: DOM (last resort).
  // Skip DOM in three cases — all share the same root: the static __NEXT_DATA__ script
  // tag (or live window.__NEXT_DATA__) is from a different page, so the DOM contains
  // content from that previous page mixed in, causing wrong beds (e.g. "Studio").
  //
  // 1. hasStaleBuilding: live __NEXT_DATA__ still has gdp.building from a prior
  //    /apartments/ page — DOM has building floor-plan content → wrong beds.
  // 2. Static tag has searchPageState: F5/nav was from a search page → DOM has
  //    search-result tiles from multiple listings → wrong beds.
  // 3. Static tag has gdp.building: F5 was on an /apartments/ building, user then
  //    navigated (search → homedetails) — static tag is apartments data, DOM content
  //    may include "Studio" from building floor-plan widgets → wrong beds.
  if (hasStaleBuilding) return null;
  try {
    const staticNd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}');
    if (staticNd?.props?.pageProps?.searchPageState) return null;
    if (staticNd?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building) return null;
  } catch (_) {}

  return extractFromDOM();
}

function extractHomeDetailsMultiSource(fallbackZip = null) {
  try {
    // ZIP: from URL slug (/homedetails/Addr-City-ST-XXXXX/ZPID_zpid/ or similar),
    // or from fallbackZip (passed by extractApartmentsPanel when ZIP not in URL).
    const zip = location.pathname.match(/-(\d{5})\/\d+_zpid/)?.[1] || fallbackZip;
    if (!zip) return null;

    // Price + address + beds: JSON-LD structured data.
    // NOTE: og:description is NOT updated by Next.js on SPA nav — it stays as the
    // search-page description. JSON-LD tags ARE updated. Extract beds from JSON-LD
    // description text first (Zillow embeds "N bedroom" there), then fall back to
    // page title (also updated on SPA nav), then og:description (reliable on F5 only).
    let price = null;
    let address = null;
    let city = null;
    let state = null;
    let beds = null;

    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(el.textContent);
        // @type can be a string or array — join to a single lowercase string for testing
        const t = [].concat(d['@type'] || '').join(',').toLowerCase();
        // Skip navigation/catalog types that never have listing data
        if (t.includes('breadcrumb') || t.includes('itemlist') ||
            t.includes('place')      || t.includes('website')) continue;

        const p = toNumber(d.offers?.price || d.price);
        if (p > 100 && !price) price = p;
        if (!address) address = d.name || d.address?.streetAddress || null;
        if (!city)    city    = d.address?.addressLocality || null;
        if (!state)   state   = d.address?.addressRegion   || null;

        // Beds: standard schema fields
        if (beds == null) {
          const bVal = d.numberOfBedrooms ?? d.numberOfRooms ?? d.bedrooms;
          if (bVal != null) beds = parseInt(bVal, 10);
        }
        // Beds: description text within JSON-LD (Zillow: "This N sqft home has N bedroom")
        // Explicit bed count takes priority — building descriptions may mention "Studio"
        // alongside other unit types even when the current listing is 1BR/2BR.
        if (beds == null && d.description) {
          const m = d.description.match(/(\d+)\s*bed(?:room)?/i);
          if (m) beds = parseInt(m[1], 10);
          else if (/\bstudio\b/i.test(d.description)) beds = 0;
        }
      } catch (_) {}
    }

    // Beds: page title — Zillow updates <title> on SPA nav
    // Typical format: "N bd, N ba, X sqft - Address | Zillow"
    if (beds == null) {
      const title = document.title;
      const m = title.match(/(\d+)\s*(?:bd|bed(?:room)?)\b/i);
      if (m) beds = parseInt(m[1], 10);
      else if (/\bstudio\b/i.test(title)) beds = 0;
    }

    // Beds: meta[name="description"] — Zillow updates this tag during SPA nav.
    // og:description is NOT updated on SPA nav (stays as search-page text).
    // Format: "...listed for rent at $X /mo. The N sqft unit is a N bed, N bath..."
    if (beds == null) {
      const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
      const m = metaDesc.match(/(\d+)\s*bed(?:room)?/i);
      if (m) beds = parseInt(m[1], 10);
      else if (/\bstudio\b/i.test(metaDesc)) beds = 0;
      if (!price) { const pm = metaDesc.match(/\$\s*([\d,]+)\s*\/\s*mo/i); if (pm) price = parseInt(pm[1].replace(/,/g, ''), 10); }
    }

    // Beds: og:description — reliable on F5/direct nav only; stale on SPA nav
    if (beds == null) {
      const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
      const m = ogDesc.match(/(\d+)\s*bed(?:room)?/i);
      if (m) beds = parseInt(m[1], 10);
      else if (/\bstudio\b/i.test(ogDesc)) beds = 0;
      if (!price) { const pm = ogDesc.match(/\$\s*([\d,]+)\s*\/\s*mo/i); if (pm) price = parseInt(pm[1].replace(/,/g, ''), 10); }
    }

    if (!price || beds == null) return null;

    return {
      price, beds,
      zipCode: zip.padStart(5, '0'),
      address, city, state,
      homeStatus: 'FOR_RENT',
      isBuilding: false,
    };
  } catch (_) { return null; }
}

// Targeted zpid lookup — two strategies:
// 1. Key-based: find gdpClientCache[key containing zpid] (doesn't require obj.zpid property)
// 2. Recursive: scan for obj.zpid === zpid as fallback
function findByZpid(nd, zpid) {
  // Strategy 1: Zillow's gdpClientCache (homedetails page structure).
  // Key may be "461539062_zpid" or similar.
  const cacheRoots = [
    nd?.props?.pageProps?.gdpClientCache,
    nd?.props?.pageProps?.componentProps?.gdpClientCache,
    nd?.props?.pageProps?.componentProps?.initialData?.gdpClientCache,
  ];
  for (const cache of cacheRoots) {
    if (!cache || typeof cache !== 'object') continue;
    const key = Object.keys(cache).find(k => k.includes(zpid));
    if (!key) continue;
    const entry = cache[key];
    // Property data may be nested under 'property', 'hdpData.homeInfo', or at root
    for (const candidate of [entry?.property, entry?.hdpData?.homeInfo, entry]) {
      const hit = parsePropObject(candidate);
      if (hit) return hit;
    }
  }

  // Strategy 2: Recursive scan for an object that has obj.zpid === zpid
  return findByZpidRecursive(nd, zpid, 0);
}

// Extract listing data from a single Zillow property object.
// Checks resoFacts.bedrooms BEFORE falling back to obj.beds to avoid
// Zillow's "beds: 0" field (which can be 0 for non-Studio listings).
function parsePropObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const bedroomVal = obj.bedrooms != null ? obj.bedrooms
                   : obj.resoFacts?.bedrooms != null ? obj.resoFacts.bedrooms
                   : obj.beds;
  const beds  = parseBeds(bedroomVal);
  const price = toNumber(obj.price || obj.listPrice || obj.unformattedPrice || obj.rentPrice);
  const zip   = String(obj.zipcode || obj.zip || obj.postalCode || obj.zipCode || '')
                  .trim().padStart(5, '0');
  if (price > 100 && beds != null && zip && zip !== '00000') {
    return {
      price, beds, zipCode: zip,
      address: obj.streetAddress || obj.address || null,
      city:    obj.city  || null,
      state:   obj.state || null,
      homeStatus: 'FOR_RENT',
      isBuilding: false,
    };
  }
  return null;
}

function findByZpidRecursive(obj, zpid, depth) {
  if (!obj || typeof obj !== 'object' || depth > 12) return null;
  if (String(obj.zpid) === zpid) {
    const status = (obj.homeStatus || obj.listingType || obj.statusType || '').toUpperCase();
    if (status && !status.includes('RENT')) return null;
    return parsePropObject(obj);
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 20); i++) {
      const hit = findByZpidRecursive(obj[i], zpid, depth + 1);
      if (hit) return hit;
    }
  } else {
    for (const key of Object.keys(obj)) {
      if (SCAN_SKIP_KEYS.has(key)) continue;  // skip "other listings" sections
      const v = obj[key];
      if (!v || typeof v !== 'object') continue;
      const hit = findByZpidRecursive(v, zpid, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// Recursive scan: find first object with price + bedrooms + zip
function findRentalObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 10) return null;

  const keys     = Object.keys(obj);
  const hasPrice = keys.some(k => PRICE_KEYS.has(k));
  const hasBeds  = keys.some(k => BEDS_KEYS.has(k));
  const hasZip   = keys.some(k => ZIP_KEYS.has(k));

  if (hasPrice && hasBeds && hasZip) {
    const status = (obj.homeStatus || obj.listingType || obj.statusType || '').toUpperCase();
    if (status && !status.includes('RENT')) return null;

    const price = toNumber(obj.price || obj.listPrice || obj.unformattedPrice || obj.rentPrice);
    // Prefer obj.bedrooms; fall back to resoFacts.bedrooms before obj.beds
    // (Zillow sometimes stores beds:0 alongside resoFacts.bedrooms:N for non-Studio units)
    const bedroomVal = obj.bedrooms != null ? obj.bedrooms
                     : obj.resoFacts?.bedrooms != null ? obj.resoFacts.bedrooms
                     : obj.beds ?? obj.numBedrooms;
    const beds  = parseBeds(bedroomVal);
    const zip   = String(obj.zipcode || obj.zip || obj.postalCode || obj.zipCode || '')
                    .trim().padStart(5, '0');

    if (price > 100 && beds != null && zip && zip !== '00000') {
      return {
        price, beds, zipCode: zip,
        address: obj.streetAddress || obj.address || null,
        city:    obj.city   || null,
        state:   obj.state  || null,
        homeStatus: 'FOR_RENT',
        isBuilding: false,
      };
    }
  }

  for (const k of keys) {
    if (SCAN_SKIP_KEYS.has(k)) continue;   // skip "other listings" sections
    const v = obj[k];
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (let i = 0; i < Math.min(v.length, 5); i++) {
        const hit = findRentalObject(v[i], depth + 1);
        if (hit) return hit;
      }
    } else {
      const hit = findRentalObject(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

const PRICE_KEYS = new Set(['price','listPrice','unformattedPrice','rentPrice','zestimate','rentZestimate']);
const BEDS_KEYS  = new Set(['bedrooms','beds','numBedrooms','bedroomCount']);
const ZIP_KEYS   = new Set(['zipcode','zip','postalCode','zipCode','addressZipcode']);

// Keys that contain OTHER listings (nearby / similar / comparable) or search-page
// aggregates. Only skip keys we're certain about — aggressive skipping can cut off
// the path to the actual listing when Zillow reuses generic key names.
//
// searchPageState / listResults / searchResults: search-page __NEXT_DATA__ keys.
// On SPA nav from page 2, __NEXT_DATA__ still holds page-1 search results.
// findRentalObject() must NOT scan those — it would return a random page-1 listing.
// extractFromListResults() handles listResults via direct path (unaffected by this set).
const SCAN_SKIP_KEYS = new Set([
  'nearbyHomes', 'similarHomes', 'recentlySoldHomes',
  'homeRecommendations', 'comparables', 'recommendedHomes',
  'searchPageState', 'listResults', 'searchResults',
]);

// ── JSON-LD parser ────────────────────────────────────────────────────────────

function parseJsonLd(obj) {
  if (!obj) return null;
  const type = (obj['@type'] || '').toLowerCase();
  if (!['apartment','residence','house','singlefamilyresidence','product'].includes(type)) return null;

  const price = toNumber(obj.offers?.price || obj.price);
  const zip   = obj.address?.postalCode || obj.postalCode;
  const beds  = parseBeds(obj.numberOfRooms || obj.numberOfBedrooms);

  if (price > 100 && zip && beds != null) {
    return {
      price, beds,
      zipCode:    String(zip).trim().padStart(5, '0'),
      address:    obj.address?.streetAddress  || null,
      city:       obj.address?.addressLocality || null,
      state:      obj.address?.addressRegion   || null,
      homeStatus: 'FOR_RENT',
      isBuilding: false,
    };
  }
  return null;
}

// ── Meta tags ─────────────────────────────────────────────────────────────────

function extractFromMeta() {
  const desc = document.querySelector('meta[property="og:description"]')?.content
             || document.querySelector('meta[name="description"]')?.content
             || '';

  const priceM = desc.match(/\$\s*([\d,]+)\s*(?:\/\s*mo|per month)/i);
  const bedsM  = desc.match(/(\d+)\s*(?:bed|bd)/i);
  const addrMeta = document.querySelector('meta[property="og:street-address"]')?.content
                 || document.querySelector('[itemprop="postalCode"]')?.content
                 || document.title || '';
  const zipM = addrMeta.match(/\b(\d{5})\b/);

  const price = priceM ? parseInt(priceM[1].replace(/,/g, ''), 10) : null;
  const beds  = bedsM  ? parseInt(bedsM[1], 10) : null;
  const zip   = zipM   ? zipM[1] : null;

  if (price && beds != null && zip) {
    return { price, beds, zipCode: zip, homeStatus: 'FOR_RENT', isBuilding: false };
  }
  return null;
}

// ── DOM text extraction ───────────────────────────────────────────────────────

function extractFromDOM() {
  const bodyText = document.body.innerText || '';

  // ── Price ────────────────────────────────────────────────────────────────
  // Try Zillow-specific data-test selectors first (more reliable after CSR render)
  let price = null;
  let isBuilding = false;

  const PRICE_SELECTORS = [
    '[data-test="floor-plan-price"]',
    '[data-test="price-section"]',
    '[class*="floorPlan"][class*="price" i]',
    '[class*="Price"][class*="floor" i]',
  ];
  for (const sel of PRICE_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const m = el.textContent.match(/\$([\d,]+)/);
    if (m) {
      price = parseInt(m[1].replace(/,/g, ''), 10);
      isBuilding = el.textContent.includes('+');
      if (price > 100) break;
      price = null;
    }
  }

  // Fall back: scan full body text for $X/mo pattern
  if (!price) {
    const priceM = bodyText.match(/\$\s*([\d,]+)(\+?)\s*(?:\/\s*mo|per\s+month)/i);
    if (priceM) {
      price     = parseInt(priceM[1].replace(/,/g, ''), 10);
      isBuilding = priceM[2] === '+';
    }
  }

  // ── Beds ─────────────────────────────────────────────────────────────────
  let beds = null;
  if (/\bstudio\b/i.test(bodyText)) {
    beds = 0;
  } else {
    const bedsM = bodyText.match(/(\d+)\s*(?:bed|bd)\b/i);
    if (bedsM) beds = parseInt(bedsM[1], 10);
  }

  // ── ZIP ──────────────────────────────────────────────────────────────────
  // Page title on apartments pages: "Building Name - Street City ST | Zillow"
  // ZIP is often not in the title but IS in the page body once rendered.
  // Try title first (fast), then address elements, then body text.
  let zip = null;

  const titleM = document.title.match(/\b(\d{5})\b/);
  if (titleM) zip = titleM[1];

  if (!zip) {
    for (const sel of ['[data-test*="addr"]', 'address', '[class*="address"]', '[class*="Address"]', 'h1', 'h2']) {
      const el = document.querySelector(sel);
      const m  = el?.textContent?.match(/\b(\d{5})\b/);
      if (m) { zip = m[1]; break; }
    }
  }

  if (!zip) {
    // Find first 5-digit number that looks like a valid US ZIP (not a year)
    const matches = [...bodyText.matchAll(/\b(\d{5})\b/g)];
    for (const m of matches) {
      const n = parseInt(m[1], 10);
      if (n >= 500 && n <= 99999) { zip = m[1].padStart(5, '0'); break; }
    }
  }

  if (price && price > 100 && beds != null && zip) {
    return { price, beds, zipCode: zip, homeStatus: 'FOR_RENT', isBuilding, source: 'dom' };
  }
  return null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function parseBeds(v) {
  if (v === 0 || v === '0') return 0;
  if (/studio/i.test(String(v))) return 0;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

// Called by content.js the moment a URL change is detected, BEFORE Zillow has
// updated window.__NEXT_DATA__ for the new page. Captures the departing
// building's bestMatchedUnit.hdpUrl as the staleness baseline for
// isBuildingGdpFresh()'s fingerprint check.
window.__rsSnapshotGdp = function () {
  try {
    const liveNd = readPageVar('window.__NEXT_DATA__');
    const b = liveNd?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building;
    _preNavBmuHdpUrl = b?.bestMatchedUnit?.hdpUrl || null;
    console.log('[RS-DBG] snapshotGdp →', _preNavBmuHdpUrl, '| url:', location.pathname);
  } catch (_) {
    _preNavBmuHdpUrl = null;
    console.log('[RS-DBG] snapshotGdp error → null');
  }
};

// Register as shared extractor name used by content.js
window.__extractListing = extractZillow;
