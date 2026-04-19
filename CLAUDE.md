# RentScope — CLAUDE.md

> Chrome Extension: Rental price intelligence. Shows HUD Fair Market Rents overlay on Zillow listings so renters can instantly judge "is this rent fair?" + Section 8 HCV eligibility.
> US market, English only. Follows the same architecture as JobScope / CarScope.

---

## Project Overview

| Item | Value |
|------|-------|
| Name | RentScope |
| Version | v1.0.0 (in development) |
| Status | **開發中** |
| Manifest | MV3 (Service Worker) |
| Architecture | Zero-build, vanilla JS |
| Supported Platforms | Zillow (Phase 1) → Apartments.com (Phase 2) |
| Language | English only |
| Brand Color  | Teal `#00C9A7` (brand) + Green `#30D158` (semantic: below FMR = good) |
| Theme        | Slate Navy dark — bg `#0F172A`, surface `#1E293B`, surface-2 `#334155` |
| Storage Prefix | `rent_` |

---

## File Structure

```
RentScope/
├── manifest.json
├── background.js          # loadIndex() + LOOKUP_FMR handler + badge
├── content.js             # Zillow page detection + SPA watcher + overlay (shadow DOM)
├── extractors/
│   └── zillow.js          # 4-layer fallback extractor
├── lib/
│   └── storage.js         # rent_ prefix; Listing schema; makeListing()
├── i18n/
│   └── locales.js         # English only
├── data/
│   ├── fmr_index.json     # bundled HUD data (~2–3 MB)
│   └── fmr_meta.json      # lightweight meta for popup
├── scripts/
│   └── process_fmr.py     # HUD raw → fmr_index.json (run annually)
├── popup.html / popup.js / popup.css
├── about.html / about.css
├── privacy.html
└── imag/
```

---

## Data Pipeline

### Source Files (auto-downloaded by process_fmr.py — no auth required)

| File | URL | Purpose |
|------|-----|---------|
| `fy2025_safmrs_revised.xlsx` | `huduser.gov/.../fy2025_safmrs_revised.xlsx` | ZIP-level FMR (53 metros) |
| `FY25_FMRs_revised.xlsx` | `huduser.gov/.../FY25_FMRs_revised.xlsx` | County-level FMR (full US) |
| `tab20_zcta520_county20_natl.txt` | `census.gov/.../tab20_zcta520_county20_natl.txt` | ZIP→County FIPS (Census) |

### SAFMR Column Names (actual, FY2025)
- ZIP: `ZIP\nCode` (newline in header)
- FMR: `SAFMR\n0BR`, `SAFMR\n1BR`, ..., `SAFMR\n4BR`
- HCV 110%: `SAFMR\n0BR -\n110%\nPayment\nStandard`, etc.
- `find_col()` normalizes newlines → spaces before matching

### HUD Excel Bug Workaround
`FY25_FMRs_revised.xlsx` contains malformed datetime `2025- 2-18T20:40:31Z` in `docProps/core.xml`.
Fix: `read_hud_excel()` opens xlsx as zip, patches `core.xml` datetime with zero-padded values, passes fixed bytes to pandas. Applied to both SAFMR and County FMR reads.

### fmr_index.json Schema
```json
{
  "meta": { "fy": 2025, "generated": "2026-04-12", "safmr_zips": 38642, "county_count": 2600, "xwk_count": 33000 },
  "safmr": {
    "10001": { "0": 2200, "1": 2450, "2": 2950, "3": 3500, "4": 4000,
               "hcv": [2420, 2695, 3245, 3850, 4400] }
  },
  "county": {
    "36061": { "name": "New York County, NY", "state": "NY", "0": 1980, "1": 2200, "2": 2650, "3": 3150, "4": 3600 }
  },
  "zip_to_county": { "10001": "36061" }
}
```

`hcv` array = official 110% Payment Standard from HUD (when available in SAFMR file).
Lookup: `safmr[zip]` → `county[zip_to_county[zip]]` → null.

### Run
```bash
python RentScope/scripts/process_fmr.py   # from chrome plugin root
```
Cached in `inputs/` after first run. Re-run annually after HUD releases new FY data (October).

---

## Zillow Extractor — Three URL Patterns

### Pattern 0: `/b/` (individual building pages)

URL format: `/b/<address-slug>/` e.g. `/b/639-e-82nd-st-los-angeles-ca-65ZHHz/`

Same `gdp.building` extraction as `/apartments/` — routes to `extractApartmentsPanel()`.

### Pattern 1: `/apartments/` (SPA panel mode — most rentals)

URL format: `/apartments/<area>/<building-name>/<id>/`

Zillow rentals open as a floating panel; `__NEXT_DATA__` remains the search page data.
The `<id>` segment (e.g. `5Xk3wy`) matches `listResults[i].detailUrl` last segment.

**Matching strategy:**
```
urlId = pathname.split('/').filter(Boolean).at(-1)  // '5Xk3wy'
match = listResults.find(r => r.detailUrl.includes(`/${urlId}/`))
```

**Top-level `listResults[i]` fields used** (no need for `hdpData.homeInfo`):
- `addressZipcode` — ZIP (direct, reliable)
- `beds` — bedrooms (number or "Studio")
- `unformattedPrice` — numeric price
- `price` — string, contains `+` if multi-unit building (shows minimum)
- `addressStreet / addressCity / addressState`
- `statusType` / `rawHomeStatusCd` — "FOR_RENT" check

**Multi-unit building**: `price` string contains `+` (e.g. `"$2,800+"`) → `isBuilding: true`
→ overlay shows FMR table + "Building starting from $X" without diff%

Fallback: DOM text extraction.

### Pattern 2: `/homedetails/` (traditional page — some rentals + for-sale)

| Layer | Strategy |
|-------|----------|
| 1 | `__NEXT_DATA__` recursive key scan — finds object with {price, bedrooms, zip}, rejects non-FOR_RENT |
| 2 | JSON-LD `schema.org/Apartment` (`offers.price`, `address.postalCode`) |
| 3 | Meta tags regex (`$X/mo`, `N bed`, 5-digit ZIP) |
| 4 | DOM text scan (last resort) |

Fields extracted: `price`, `beds`, `zipCode`, `address`, `city`, `state`, `homeStatus`, `isBuilding`.

---

## Overlay Design (Shadow DOM)

```
┌─ RentScope ──────────── FY2025 FMR · ✕ ┐
│ ZIP 10001 · Manhattan, NY               │
│ Studio $2,200  1BR $2,450               │
│ ► 2BR  $2,950 ◄  3BR $3,500  4BR $4,000 │
│                                         │
│ Your listing: $3,200/mo · 2BR           │
│ ┌ +8.5% above FMR ($3,200 vs $2,950) ┐  │
│ └─────────────────────────────────────┘  │
│ ✅ Within Section 8 HCV limit           │
│    (HCV cap: $3,245 · 110% of FMR)      │
│ Source: HUD SAFMR · ZIP-level           │
└─────────────────────────────────────────┘
```

Color coding: green = at/below FMR, amber = 0–20% above, red = >20% above.

HCV judgement: use `hcv[br]` from fmr_index if available (official HUD value), else fallback to `fmr[br] × 1.10`.

---

## Fraud Signal (FMR-relative, Phase 1 addition)

Better than hardcoded price thresholds (RentGuard uses $400/$700 nationwide).
Add to overlay when price is far below FMR:

- price < FMR × 0.50 → ⚠ Price is unusually low (verify authenticity)
- price < FMR × 0.35 → ⛔ Extremely below market rate — potential fraud

This is market-relative: adjusts automatically for rural Iowa vs Manhattan.

---

## Popup Design (Phase 1)

```
Header: [🏠 RentScope]  [FY2025 HUD FMR]

Section 1 — Current Listing (if on Zillow listing page)
  address / ZIP / bedrooms / price
  FMR diff % (large, colored)
  FMR full table
  HCV status

Section 2 — ZIP Lookup
  [Input: ZIP code]  [Look up]
  → shows FMR full table for that ZIP

Footer: RentScope · About · Privacy · HUD Data
```

Data flow: content.js writes `rent_current` to `chrome.storage.session` on extract → popup reads it.
ZIP Lookup: popup fetches `chrome.runtime.getURL('data/fmr_index.json')` directly (same as JobScope popup).

---

## Listing Schema (storage.js)

```javascript
{
  id,           // urlToId(url) — djb2 hash
  url,
  source,       // 'zillow' | 'apartments'
  savedAt,
  address, city, state, zipCode,
  bedrooms,     // 0=Studio, 1, 2, 3, 4
  price,        // monthly rent
  sqft,
  fmrLevel,     // 'SAFMR' | 'county'
  fmrAreaName,
  fmrValue,     // FMR for detected BR
  fmrYear,      // 2025
  diffPct,      // (price - fmrValue) / fmrValue * 100
  hcvEligible,  // boolean
}
```

---

## Phase Roadmap

### Phase 1 — MVP (current)
- ✅ `process_fmr.py` → `fmr_index.json` (2026-04-12)
- ✅ `background.js` loadIndex + lookupFMR + badge
- ✅ `extractors/zillow.js` 4-layer fallback (/apartments/ + /homedetails/)
- ✅ `content.js` overlay (shadow DOM) + SPA watcher
- ✅ content ↔ background message passing (LOOKUP_FMR + SET_BADGE)
- ✅ Popup UI (current listing + ZIP lookup)
- ✅ FMR-relative fraud signal in overlay (50%/35% thresholds)
- ✅ Chrome testing (2026-04-13) — overlay + popup working; badge shows -14%
- ✅ Direct URL navigation fixed (2026-04-13) — window Redux store scan + 12s retry + DOM fallback
- ✅ SPA navigation from search page fixed (2026-04-14) — manifest broadened to `https://www.zillow.com/*`; `readPageVar()` bridges isolated world → page JS
- ✅ UI retheme (2026-04-13) — Slate Navy bg, teal brand #00C9A7, green semantic #30D158
- ✅ Google Lens photo verification — overlay (footer + fraud signal) + popup button
- 🔲 Icons — placeholder from JobScope; RentScope logo being generated (teal theme)
- 🔲 About / Privacy pages (Phase 1 last item, before CWS)
- 🔲 CWS submission prep (暫不上架，打磨中)

### Known bugs fixed
- `chrome.storage.session` not shared between content scripts and popup in MV3 → `chrome.storage.local`
- Zillow frontend changed: `listResults` path gone → L0 `extractFromGdpBuilding()` reading `initialReduxState.gdp.building`
- Direct URL navigation: Redux state empty in `__NEXT_DATA__` → window Redux store scan + 12s retry
- HUD county `fips` 10-digit; first 5 = real FIPS → fixed `fips5()` in process_fmr.py
- County FMR `state` column is numeric FIPS → use `stusps` column
- SPA navigation from search page broken: manifest `https://www.zillow.com/apartments/*` doesn't match search URLs like `/los-angeles-ca/apartments/` → broadened to `https://www.zillow.com/*`
- `/b/<slug>/` building pages not handled (2026-04-14): third Zillow URL pattern unrecognized → added to `isListingPage()`, `extractZillow()`, popup `onZillow` check
- `window.__NEXT_DATA__` not readable from isolated world: added `readPageVar()` in zillow.js — injects inline script to copy page JS var to DOM attribute, reads it back
- Studio fallback on SPA nav to /homedetails/ after F5 on /apartments/ (2026-04-17): three root causes fixed:
  1. `extractFromGdpBuilding` called without URL zpid → fallback to cheapest floor plan = Studio → now pass URL zpid; return null if unit not found
  2. `extractHomeDetailsMultiSource` studio-first ordering → bed count now takes priority over "studio" keyword in all text checks
  3. DOM ran when static `__NEXT_DATA__` tag was from apartments F5 (no `searchPageState` to trigger existing block) → added `gdp.building` check to static tag DOM guard; also blocked DOM when `hasStaleBuilding=true`
- Bookmark/direct URL navigation shows stale building data (2026-04-18): Fix in `isBuildingGdpFresh()`:
  1. `query.slug` check (before Fallback 2a): static tag's `query.slug` contains path segments of the F5 page → if `urlId` in slug → fresh; if slug exists but no match → stale
  2. Fallback 2a fix: when `urlHouseNum === null` (name-slug URL), houseNum/zip match now falls through instead of returning `true` — prevents false-positive "fresh" when stale gdp matches stale static tag
  NOTE: Zillow's `window.__NEXT_DATA__` NEVER contains `asPath` field — do not attempt asPath-based freshness checks

### Phase 2 — Enrichment (priority order)
- ✅ Apartments.com support (`extractors/apartments.js`) — 4-layer fallback; manifest v1.1.0
- 🔲 FMR YoY trend (FY2024 vs FY2025) — adds analytical depth, increases bundle size
- 🔲 Saved listings (CarScope pattern)
- 🔲 About / Privacy polish

---

## Annual Data Maintenance

| 時機 | 動作 |
|------|------|
| 每年 **10–11 月**（HUD 發布新 FY） | 更新 `SOURCES` URLs → 刪除 `inputs/` cache → 重跑 `process_fmr.py` → commit |
| 更新後 | 更新 manifest version、about.html 年份 badge |

---

## Key Differences from JobScope

| Item | JobScope | RentScope |
|------|---------|-----------|
| Data source | DOL LCA (employer filings) | HUD FMR (gov rent benchmarks) |
| Data granularity | Employer × title × state | ZIP / County |
| Update frequency | Quarterly | Annual |
| Data size | 2.37 MB | ~2–3 MB |
| Primary value | Salary negotiation | Rent fairness |
| Secondary value | — | Section 8 HCV eligibility |

---

## Debugging Extraction Issues

When overlay/popup shows wrong data and the bug persists after ≥2 fix attempts,
**always provide debug commands first** — inspect actual runtime data before changing code.

### Debug commands (run in DevTools Console on the target page)

```javascript
// 1. Check what __NEXT_DATA__ contains (script tag — static, never updates on SPA nav)
const nd = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
console.log('pageProps keys:', Object.keys(nd?.props?.pageProps || {}));

// 2. Check live window.__NEXT_DATA__ (updated by Next.js on SPA nav) — run in page context
console.log('live pageProps keys:', Object.keys(window.__NEXT_DATA__?.props?.pageProps || {}));

// 3. For /apartments/ or /b/ pages — inspect building + floor plans
const b = window.__NEXT_DATA__?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building;
console.log('floorPlans:', b?.floorPlans?.map(p => ({
  beds: p.beds, minPrice: p.minPrice,
  units: (p.units||[]).slice(0,3).map(u => ({zpid: u.zpid, beds: u.beds, price: u.price}))
})));
console.log('bestMatchedUnit:', b?.bestMatchedUnit);

// 4. Check what content.js extracted and stored
chrome.storage.local.get('rent_current', r => console.log(r.rent_current));
// (run from DevTools → Application → Storage or inject via extension popup console)
```

### Key facts confirmed (2026-04-15)

- Static `__NEXT_DATA__` script tag: **always search-page data** when navigated via SPA — contains `searchPageState.cat1.searchResults.listResults` (multiple listings). `findRentalObject` scanning this array picks a random listing.
- `window.__NEXT_DATA__` JS variable: updated by Next.js on SPA nav, contains homedetails data. Inaccessible from isolated world → use `readPageVar()`.
- Meta tag update behaviour on SPA nav to `/homedetails/`: `og:description` and `og:title` are **NOT updated** (stay as search-page text). `meta[name="description"]` **IS updated** with listing-specific text ("...listed for rent at $X /mo. The N sqft unit is a N bed, N bath..."). Use `meta[name="description"]` as primary beds/price source for SPA nav; `og:description` only reliable on F5.
- `unit.beds` in Zillow's floor plan data can be `0` for non-Studio units (data quality issue). `plan.beds` is more reliable for bedroom type.
- `/b/` building pages use **CSR** (client-side rendering): initial `window.__NEXT_DATA__` has `[fullPage, bodyProps, searchPageState...]`, componentProps arrives only after hydration. DOM fallback must be skipped for `/b/` or it returns wrong data (picks up "Studio" from page text) and stops the retry loop.
- Extraction priority for `/homedetails/`: `findByZpid` (gdpClientCache) → `extractFromListResults` (listResults by zpid) → `findRentalObject` (generic, last resort).

---

## Technical Notes

- `read_hud_excel()` helper in process_fmr.py handles openpyxl datetime bug in HUD files
- Census crosswalk uses `AREALAND_PART` (land area overlap) to find dominant county per ZIP
- SAFMR covers ~38,642 ZIPs; remaining ZIPs use county fallback
- Badge: green (≤FMR), amber (FMR+20%), red (>FMR+20%)
- SPA navigation: MutationObserver on Zillow (same pattern as JobScope)
- For-sale vs for-rent detection: check `homeStatus` in `__NEXT_DATA__` + presence of `/mo` in price
- Zillow migrated from Redux to Apollo GraphQL (confirmed 2026-04-14): `window.__APOLLO_CLIENT__` present, no Redux globals. Apollo cache has minimal data during SPA nav; page JS `window.__NEXT_DATA__` still the primary source
- `readPageVar(varPath)` in zillow.js: injects `<script>` to copy page window variable to `data-rentscope-tmp` attribute, reads+removes it. Bridges MV3 isolated world limitation. May fail if page has strict inline-script CSP (falls back gracefully to script tag parse)
- `window.__NEXT_DATA__` NEVER contains `asPath` field on Zillow (confirmed across multiple debug sessions) — do not use asPath for freshness detection
- `window.__NEXT_DATA__.query.slug` (static script tag): populated by Next.js with path segments of the F5 page URL. For `/apartments/area/building/5XjSGZ/`, slug = `['area', 'building', '5XjSGZ']`. Absent on search-page F5 (slug = undefined or []). Use this as primary freshness signal in `isBuildingGdpFresh()`
- `gdp.building` Redux state persists across SPA nav — NOT cleared when navigating to a search page. This is the root cause of bookmark-nav stale data bugs
