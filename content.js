// RentScope — content.js
// Runs on Zillow rental listing pages.
// Extracts listing data → sends LOOKUP_FMR to background → renders FMR overlay (shadow DOM).

(function () {
  'use strict';

  // Incremented on every navigation — lets pending retry loops detect they're stale.
  let activeRunId = 0;

  // Hostname-scoped storage key prevents cross-site popup contamination.
  const RENT_KEY = location.hostname.includes('zillow.com') ? 'rent_zillow' : 'rent_apartments';

  // Start watching immediately; only run extraction on listing pages
  watchForNavigation();
  if (isListingPage()) run(activeRunId);

  // ── Page detection ─────────────────────────────────────────────────────────

  function isListingPage() {
    const host = location.hostname;
    const p    = location.pathname;

    // Zillow
    if (host.includes('zillow.com')) {
      if (p.includes('/homedetails/')) return true;
      // /apartments/<area>/<building-name>/<id>/ needs ≥ 4 non-empty segments
      if (p.includes('/apartments/')) {
        return p.split('/').filter(Boolean).length >= 4;
      }
      // /b/<address-slug>/ — individual building pages (e.g. /b/639-e-82nd-st-...-65ZHHz/)
      // Exclude /b/building/<lat,lng_ll>/ — coordinate-based map pages, no extractable data.
      const segs = p.split('/').filter(Boolean);
      if (segs[0] === 'b' && segs[1] !== 'building' && segs.length >= 2) return true;
      return false;
    }

    // Apartments.com — listing pages: /property-slug/listing-id/[tab/]
    // Listing IDs are 5–12 alphanumeric chars with no hyphens (e.g. "hfvljnj").
    // Exclude search/filter pages whose 2nd segment is a hyphenated phrase.
    if (host.includes('apartments.com')) {
      const segs = p.split('/').filter(Boolean);
      return segs.length >= 2 && /^[a-z0-9]{5,12}$/i.test(segs[1]);
    }

    return false;
  }

  // ── Main flow ──────────────────────────────────────────────────────────────

  function run(runId) {
    waitForContent(attempt, runId);
  }

  // Called repeatedly until extraction succeeds (returns true) or max tries reached.
  function attempt() {
    const listing = window.__extractListing?.();
    if (!listing) return false; // extractor not ready — retry
    // Non-rental page: stop retrying, don't show overlay
    if (listing.homeStatus && !listing.homeStatus.toUpperCase().includes('RENT')) return true;
    if (!listing.zipCode || !listing.price) return false;

    // Capture photo URL for image verification.
    // Zillow → Google Lens. Apartments.com → Yandex Images (Lens is blocked by CDN).
    listing.photoUrl = document.querySelector('meta[property="og:image"]')?.content || null;

    // Persist for popup (use local — session storage is not shared between
    // content scripts and popup in Chrome MV3)
    chrome.storage.local.set({
      [RENT_KEY]: { ...listing, url: location.href, extractedAt: Date.now() },
    });

    // Ask background for FMR data
    chrome.runtime.sendMessage({ action: 'LOOKUP_FMR', zipCode: listing.zipCode }, (fmrData) => {
      if (chrome.runtime.lastError) return;
      if (!fmrData || fmrData.error) { clearBadge(); return; }
      processAndRender(listing, fmrData);
    });

    return true;
  }

  function processAndRender(listing, fmrData) {
    const br       = parseInt(listing.beds ?? 0, 10);
    const brCapped = Math.min(br, 4); // HUD FMR tops out at 4BR
    const fmrValue = fmrData.fmr?.[String(brCapped)];

    // Multi-unit building: enrich each floor plan individually so the overlay
    // can show per-unit comparisons instead of one misleading diff%.
    let enrichedPlans = null;
    if (listing.isBuilding && Array.isArray(listing.buildingPlans) && listing.buildingPlans.length) {
      enrichedPlans = listing.buildingPlans.map(plan => {
        const pBr    = Math.min(plan.beds, 4);
        const pFmr   = fmrData.fmr?.[String(pBr)] ?? null;
        const diff   = pFmr ? (plan.minPrice - pFmr) / pFmr * 100 : null;
        const cap    = fmrData.hcv?.[pBr] ?? (pFmr ? Math.round(pFmr * 1.10) : null);
        return {
          beds: plan.beds, minPrice: plan.minPrice, maxPrice: plan.maxPrice,
          fmrValue: pFmr, diffPct: diff,
          hcvCap: cap, hcvEligible: cap != null ? plan.minPrice <= cap : null,
        };
      });
    }

    if (!fmrValue && !enrichedPlans) {
      renderOverlay(listing, fmrData, null, null);
      clearBadge();
      return;
    }

    // Single unit: compute diff normally. Buildings: no single diff (use plans).
    const diffPct = (!listing.isBuilding && fmrValue)
      ? (listing.price - fmrValue) / fmrValue * 100
      : null;

    const officialHcvCap = fmrData.hcv?.[brCapped] ?? null;
    const hcvCap         = officialHcvCap || (fmrValue ? Math.round(fmrValue * 1.10) : null);

    chrome.storage.local.set({
      [RENT_KEY]: {
        ...listing,
        url:          location.href,
        extractedAt:  Date.now(),
        photoUrl:     listing.photoUrl ?? null,
        fmrLevel:     fmrData.level,
        fmrAreaName:  fmrData.areaName || null,
        fmrValue,
        fmrYear:      fmrData.fy,
        fmr:          fmrData.fmr,
        hcv:          fmrData.hcv,
        diffPct,
        hcvEligible:  (!listing.isBuilding && hcvCap != null) ? listing.price <= hcvCap : null,
        buildingPlans: enrichedPlans ?? null,
      },
    });

    // Badge: single unit uses diffPct; buildings use cheapest plan's diff
    const badgeDiff = enrichedPlans
      ? (enrichedPlans.find(p => p.diffPct != null)?.diffPct ?? null)
      : diffPct;
    if (badgeDiff != null) {
      chrome.runtime.sendMessage({ action: 'SET_BADGE', diffPct: badgeDiff });
    } else {
      clearBadge();
    }

    renderOverlay(listing, fmrData, diffPct, enrichedPlans);
  }

  // ── SPA navigation watcher ─────────────────────────────────────────────────
  // Zillow is a SPA — listings open in-panel without a full reload.

  function watchForNavigation() {
    let lastUrl = location.href;

    const observer = new MutationObserver(() => {
      if (location.href === lastUrl) return;
      // Snapshot gdp.building fingerprint before Zillow updates __NEXT_DATA__.
      // Must be called first — at this moment the departing page's gdp is still live.
      window.__rsSnapshotGdp?.();
      lastUrl = location.href;

      const myId = ++activeRunId; // capture NOW — before the 600ms delay
      removeOverlay();
      clearBadge();
      chrome.storage.local.remove(RENT_KEY);

      if (isListingPage()) {
        // Give Zillow ~600ms to update __NEXT_DATA__ / DOM before extracting.
        // Only start if no newer navigation happened within those 600ms.
        setTimeout(() => { if (activeRunId === myId) run(myId); }, 600);
      } else {
        // Landed on a non-listing page (e.g. search results).
        // At T=800ms window.__NEXT_DATA__ is stable — cache listResults for use
        // when the user clicks into a building whose gdp.building may be stale.
        setTimeout(() => { if (activeRunId === myId) window.__rsCacheSearchResults?.(); }, 800);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Content readiness polling ──────────────────────────────────────────────
  // Zillow SPA panels may render asynchronously; retry up to ~5s.

  function waitForContent(fn, runId) {
    let tries = 0;
    const MAX = 24; // ~12s — Zillow CSR can be slow on direct navigation
    function tick() {
      if (activeRunId !== runId) return; // newer navigation happened — stop this loop
      if (fn()) return;
      if (++tries < MAX) setTimeout(tick, 500);
    }
    tick();
  }

  // ── Overlay (Shadow DOM) ───────────────────────────────────────────────────

  let overlayHost = null;

  function removeOverlay() {
    if (overlayHost) { overlayHost.remove(); overlayHost = null; }
  }

  function clearBadge() {
    chrome.runtime.sendMessage({ action: 'SET_BADGE', diffPct: null });
  }

  const ACCENT    = '#00C9A7'; // brand teal
  const GREEN     = '#30D158'; // semantic: below FMR = good
  const BR_LABELS = ['Studio', '1BR', '2BR', '3BR', '4BR'];

  /* eslint-disable no-multi-str */
  const OVERLAY_CSS = `
    :host { all: initial; }
    .card {
      position: fixed; top: 72px; right: 16px; width: 284px;
      background: #0F172A; border: 1px solid rgba(148,163,184,0.15);
      border-top: 3px solid ${ACCENT}; border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.80);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px; color: #F1F5F9; z-index: 2147483647;
      animation: slide-in 0.18s ease-out;
    }
    @keyframes slide-in {
      from { opacity: 0; transform: translateX(14px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    .header {
      display: flex; align-items: center; gap: 6px;
      padding: 9px 12px 7px; border-bottom: 1px solid rgba(148,163,184,0.12);
    }
    .brand {
      flex: 1; display: flex; align-items: center; gap: 6px;
      font-size: 11px; font-weight: 700; color: ${ACCENT};
      letter-spacing: 0.06em; text-transform: uppercase;
    }
    .brand-logo { width: 16px; height: 16px; border-radius: 3px; flex-shrink: 0; }
    .fy-badge { font-size: 10px; color: #64748B; font-weight: 400;
                text-transform: none; letter-spacing: 0; }
    .close-btn { background: none; border: none; color: #64748B; cursor: pointer;
                 font-size: 18px; line-height: 1; padding: 0 2px; transition: color 0.15s; }
    .close-btn:hover { color: #94A3B8; }
    .body { padding: 10px 12px 12px; }

    .area { font-size: 11px; color: #94A3B8; margin-bottom: 8px; }
    .level-tag { display: inline-block; font-size: 10px; background: #1E293B;
                 color: #64748B; border-radius: 4px; padding: 1px 5px; margin-left: 5px; }

    .fmr-table { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 6px; margin-bottom: 10px; }
    .fmr-cell { font-size: 12px; color: #94A3B8; padding: 2px 6px; border-radius: 5px; }
    .fmr-cell.active { color: #F1F5F9; font-weight: 600; background: #1E293B; }

    .listing-line { font-size: 12px; color: #94A3B8; margin-bottom: 8px; }
    .listing-price { font-weight: 600; color: #F1F5F9; }
    .building-note { font-size: 11px; color: #64748B; margin-bottom: 8px; font-style: italic; }

    .diff { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px;
            padding: 7px 10px; border-radius: 7px; margin-bottom: 9px;
            font-size: 13px; font-weight: 600; }
    .diff.green { background: rgba(48,209,88,0.12);  color: ${GREEN}; }
    .diff.amber { background: rgba(255,159,10,0.12); color: #FF9F0A; }
    .diff.red   { background: rgba(255,69,58,0.12);  color: #FF453A; }
    .diff-detail { font-size: 11px; font-weight: 400; color: #64748B; }

    .fraud { font-size: 12px; margin-bottom: 8px; }
    .verify-btn {
      display: flex; align-items: center; justify-content: center; gap: 6px;
      width: 100%; padding: 8px 12px; margin: 8px 0 4px;
      background: ${ACCENT}; color: #fff;
      font-size: 12px; font-weight: 600; border-radius: 7px;
      text-decoration: none; box-sizing: border-box;
      transition: opacity 0.15s;
    }
    .verify-btn:hover { opacity: 0.82; }
    .hcv   { font-size: 12px; margin-bottom: 3px; }
    .hcv-cap { font-size: 11px; color: #64748B; margin-bottom: 4px; }
    .hcv-note { font-size: 10px; color: #64748B; margin-bottom: 6px; font-style: italic; }

    .plans-title { font-size: 11px; color: #94A3B8; margin-bottom: 5px; }
    .plans-wrap { margin-bottom: 8px; }
    .plan-row {
      display: grid; grid-template-columns: 44px 1fr auto 16px;
      gap: 4px; align-items: center; padding: 4px 0;
      border-bottom: 1px solid rgba(148,163,184,0.07);
    }
    .plan-row:last-child { border-bottom: none; }
    .plan-br    { font-size: 12px; color: #94A3B8; }
    .plan-price { font-size: 12px; color: #F1F5F9; }
    .plan-diff  { font-size: 11px; font-weight: 600; padding: 1px 4px;
                  border-radius: 4px; text-align: center; }
    .plan-diff.green { background: rgba(48,209,88,0.12);  color: ${GREEN}; }
    .plan-diff.amber { background: rgba(255,159,10,0.12); color: #FF9F0A; }
    .plan-diff.red   { background: rgba(255,69,58,0.12);  color: #FF453A; }
    .plan-hcv   { font-size: 12px; text-align: center; }

    .footer {
      font-size: 10px; color: #64748B; margin-top: 6px;
      display: flex; justify-content: space-between; align-items: center;
    }
  `;

  function fmtPrice(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

  function renderOverlay(listing, fmrData, diffPct, enrichedPlans = null) {
    removeOverlay();

    const { price, beds, zipCode, city, state, isBuilding } = listing;
    const { fmr, hcv: hcvArr, fy, level, areaName } = fmrData;
    const br       = parseInt(beds ?? 0, 10);
    const brCapped = Math.min(br, 4); // HUD FMR tops out at 4BR

    // Photo verification: Zillow → Google Lens, Apartments.com → Yandex Images
    const photoUrl = listing.photoUrl
                  || document.querySelector('meta[property="og:image"]')?.content
                  || null;
    let verifyBtnHtml = '';
    if (photoUrl) {
      const isZillow = location.hostname.includes('zillow.com');
      const verifyUrl = isZillow
        ? `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(photoUrl)}`
        : `https://www.bing.com/images/search?q=imgurl:${encodeURIComponent(photoUrl)}&view=detailv2&iss=sbi`;
      const verifyLabel = isZillow ? '🔍 Verify photos' : '🔍 Verify photos with Bing';
      verifyBtnHtml = `<a class="verify-btn" href="${escHtml(verifyUrl)}" target="_blank" rel="noopener">${verifyLabel}</a>`;
    }

    // ── Area line ────────────────────────────────────────────────────────
    let areaText = `ZIP ${zipCode}`;
    if (city && state) areaText += ` · ${city}, ${state}`;
    else if (areaName)  areaText += ` · ${areaName}`;
    const levelTag = level === 'SAFMR' ? 'ZIP-level' : 'County-level';

    // ── FMR value for single-unit diff/HCV ───────────────────────────────
    const fmrValue = fmr?.[String(brCapped)];

    // ── Building plans table (replaces FMR table + diff + HCV for multi-unit buildings) ──
    let mainContentHtml = '';

    if (enrichedPlans && enrichedPlans.length > 0) {
      // Plan A: per-unit comparison table
      const planRows = enrichedPlans.map(plan => {
        const pBrLabel = plan.beds > 4 ? `${plan.beds}BR` : (BR_LABELS[plan.beds] || `${plan.beds}BR`);
        const priceStr = plan.maxPrice > plan.minPrice
          ? `${fmtPrice(plan.minPrice)}–${fmtPrice(plan.maxPrice)}`
          : fmtPrice(plan.minPrice);
        let diffStr = '', diffCls = '';
        if (plan.diffPct != null) {
          const sign = plan.diffPct >= 0 ? '+' : '-';
          diffCls  = plan.diffPct > 20 ? 'red' : plan.diffPct < 0 ? 'green' : 'amber';
          diffStr  = `${sign}${Math.abs(plan.diffPct).toFixed(0)}%`;
        }
        const hcvIcon = plan.hcvEligible === true ? '✅' : plan.hcvEligible === false ? '⚠️' : '';
        return `
          <div class="plan-row">
            <span class="plan-br">${escHtml(pBrLabel)}</span>
            <span class="plan-price">${escHtml(priceStr)}/mo</span>
            ${diffStr ? `<span class="plan-diff ${diffCls}">${diffStr}</span>` : '<span></span>'}
            <span class="plan-hcv">${hcvIcon}</span>
          </div>`;
      }).join('');

      mainContentHtml = `
        <div class="plans-title">Available units <span class="level-tag">${levelTag} · FY${fy}</span></div>
        <div class="plans-wrap">${planRows}</div>
        <div class="hcv-note">✅ = may qualify for Section 8 · depends on local housing authority</div>`;

    } else {
      // Single unit: standard FMR table + diff + HCV
      const fmrCells = [0, 1, 2, 3, 4].map(n => {
        const val = fmr?.[String(n)];
        if (!val) return '';
        const active = !isBuilding && (n === brCapped);
        return `<span class="fmr-cell${active ? ' active' : ''}">${BR_LABELS[n]} ${fmtPrice(val)}</span>`;
      }).join('');

      const brLabel = br > 4 ? `${br}BR` : (BR_LABELS[br] || `${br}BR`);
      const listingLine = isBuilding
        ? `<div class="building-note">Starting from ${fmtPrice(price)}/mo · multiple unit types</div>`
        : `<div class="listing-line">Listing: <span class="listing-price">${fmtPrice(price)}/mo</span> · ${brLabel}</div>`;

      let diffHtml = '';
      if (diffPct != null && fmrValue) {
        const sign  = diffPct >= 0 ? '+' : '';
        const cls   = diffPct > 20 ? 'red' : diffPct < 0 ? 'green' : 'amber';
        const label = diffPct >= 0 ? 'above fair market rent' : 'below fair market rent';
        diffHtml = `
          <div class="diff ${cls}">
            ${sign}${Math.abs(diffPct).toFixed(1)}% ${label}
            <span class="diff-detail">(${fmtPrice(price)} vs benchmark ${fmtPrice(fmrValue)})</span>
          </div>`;
      }

      let fraudHtml = '';
      if (fmrValue && diffPct != null) {
        const ratio = price / fmrValue;
        if (ratio < 0.35)
          fraudHtml = `<div class="fraud">⛔ Extremely below market — potential fraud</div>`;
        else if (ratio < 0.50)
          fraudHtml = `<div class="fraud">⚠️ Unusually low price — verify authenticity</div>`;
      }

      let hcvHtml = '';
      if (fmrValue && !isBuilding) {
        const officialCap = hcvArr?.[brCapped] ?? null;
        const cap         = officialCap || Math.round(fmrValue * 1.10);
        const capLabel    = officialCap ? 'official HUD standard' : 'estimated';
        const eligible    = price <= cap;
        if (eligible) {
          hcvHtml = `
            <div class="hcv">✅ May qualify for Section 8 rental assistance</div>
            <div class="hcv-cap">Section 8 limit: ${fmtPrice(cap)}/mo · ${capLabel}</div>`;
        } else {
          const overPct = Math.round((price / cap - 1) * 100);
          hcvHtml = `
            <div class="hcv">⚠️ Likely over Section 8 limit · ${overPct}% above cap</div>
            <div class="hcv-cap">Section 8 limit: ${fmtPrice(cap)}/mo · ${capLabel}</div>`;
        }
        hcvHtml += `<div class="hcv-note">Actual eligibility depends on your local housing authority</div>`;
      }

      mainContentHtml = `
        <div class="fmr-table">${fmrCells}</div>
        ${listingLine}
        ${diffHtml}
        ${fraudHtml}
        ${hcvHtml}`;
    }

    // ── Source footer ────────────────────────────────────────────────────
    const srcText = level === 'SAFMR'
      ? `HUD SAFMR FY${fy} · ZIP-level`
      : `HUD FMR FY${fy} · ${areaName || 'County-level'}`;

    // ── Assemble ─────────────────────────────────────────────────────────
    const logoUrl = chrome.runtime.getURL('imag/icon32.png');
    const host   = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>${OVERLAY_CSS}</style>
      <div class="card">
        <div class="header">
          <span class="brand">
            <img class="brand-logo" src="${escHtml(logoUrl)}" alt="">
            RentScope
            <span class="fy-badge">FY${fy} FMR</span>
          </span>
          <button class="close-btn" title="Dismiss">×</button>
        </div>
        <div class="body">
          <div class="area">${escHtml(areaText)}${enrichedPlans ? '' : `<span class="level-tag">${levelTag}</span>`}</div>
          ${mainContentHtml}
          ${verifyBtnHtml}
          <div class="footer"><span>Source: ${escHtml(srcText)}</span></div>
        </div>
      </div>
    `;

    shadow.querySelector('.close-btn').addEventListener('click', removeOverlay);
    document.body.appendChild(host);
    overlayHost = host;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

})();
