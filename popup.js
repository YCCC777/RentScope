// RentScope — popup.js
// Reads rent_current from session storage (set by content.js).
// Also supports manual ZIP lookup by fetching fmr_index.json directly.

(function () {
  'use strict';

  const BR_LABELS = ['Studio', '1BR', '2BR', '3BR', '4BR'];

  // ── Init ────────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    loadCurrentListing();
    setupZipLookup();
    setupFooter();
  });

  // ── Section 1: Current listing ─────────────────────────────────────────────

  function rentKeyForUrl(url) {
    if (url.includes('zillow.com'))     return 'rent_zillow';
    if (url.includes('apartments.com')) return 'rent_apartments';
    return 'rent_current';
  }

  function loadCurrentListing() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url || '';
      const onListing = url.includes('zillow.com/apartments/') ||
                        url.includes('zillow.com/homedetails/') ||
                        url.includes('zillow.com/b/') ||
                        isAptComListing(url);

      if (!onListing) { showState('no-page'); return; }

      const key = rentKeyForUrl(url);
      chrome.storage.local.get(key, (result) => {
        const data = result[key];

        // Reject stale data from a different listing on the same site.
        const getPath = (u) => { try { return new URL(u).pathname; } catch(_) { return null; } };
        const dataPath = data?.url ? getPath(data.url) : null;
        const tabPath  = getPath(url);
        const isStale  = dataPath && tabPath && dataPath !== tabPath;

        if (!data || isStale) {
          showState('loading');
          setTimeout(() => {
            chrome.storage.local.get(key, (r2) => {
              if (r2[key]) renderCurrentListing(r2[key]);
              else showState('no-data');
            });
          }, 1500);
          return;
        }

        renderCurrentListing(data);
      });
    });
  }

  function renderCurrentListing(data) {
    // Show current section, hide state cards
    show('current-section');
    hide('state-no-page');
    hide('state-loading');

    // Address / meta
    const addressEl = document.getElementById('listing-address');
    const metaEl    = document.getElementById('listing-meta');

    const addrParts = [data.address, data.city, data.state].filter(Boolean);
    addressEl.textContent = addrParts.length ? addrParts.join(', ') : `ZIP ${data.zipCode}`;

    const br      = parseInt(data.beds ?? 0, 10);
    const brLabel = data.isBuilding ? 'Building' : (BR_LABELS[br] || `${br}BR`);
    const price   = data.price ? fmtPrice(data.price) + '/mo' : '—';
    metaEl.innerHTML =
      `<span class="price">${esc(price)}</span>` +
      `<span class="sep">·</span>${esc(brLabel)}` +
      (data.zipCode ? `<span class="sep">·</span>ZIP ${esc(data.zipCode)}` : '');

    // FMR comes from content.js enrichment — look it up fresh if not present
    if (data.fmrValue) {
      renderFMRSection(data);
    } else {
      // Re-lookup FMR in popup (e.g. if content.js ran before index loaded)
      loadFmrIndex().then(index => {
        if (!index || !data.zipCode) return;
        const fmrData = lookupFMR(index, data.zipCode);
        if (!fmrData || fmrData.error) return;
        renderFMRSection({ ...data, ...enrichWithFmr(data, fmrData) });
      });
    }
  }

  function enrichWithFmr(listing, fmrData) {
    const br       = parseInt(listing.beds ?? 0, 10);
    const brCapped = Math.min(br, 4);
    const fmrValue = fmrData.fmr?.[String(brCapped)] ?? null;
    const diffPct  = (fmrValue && !listing.isBuilding)
      ? (listing.price - fmrValue) / fmrValue * 100 : null;
    const officialHcvCap = fmrData.hcv?.[brCapped] ?? null;
    const cap = officialHcvCap || (fmrValue ? Math.round(fmrValue * 1.10) : null);

    // Re-enrich building plans if not yet done (e.g. popup opened before content.js finished)
    let buildingPlans = listing.buildingPlans || null;
    if (listing.isBuilding && Array.isArray(listing.buildingPlans) && listing.buildingPlans.length) {
      buildingPlans = listing.buildingPlans.map(plan => {
        if (plan.diffPct != null) return plan; // already enriched
        const pBr  = Math.min(plan.beds, 4);
        const pFmr = fmrData.fmr?.[String(pBr)] ?? null;
        const diff = pFmr ? (plan.minPrice - pFmr) / pFmr * 100 : null;
        const pCap = fmrData.hcv?.[pBr] ?? (pFmr ? Math.round(pFmr * 1.10) : null);
        return { ...plan, fmrValue: pFmr, diffPct: diff, hcvCap: pCap,
                 hcvEligible: pCap != null ? plan.minPrice <= pCap : null };
      });
    }

    return {
      fmrLevel:     fmrData.level,
      fmrAreaName:  fmrData.areaName || null,
      fmrValue,
      fmrYear:      fmrData.fy,
      fmr:          fmrData.fmr,
      hcv:          fmrData.hcv,
      diffPct,
      hcvEligible:  (!listing.isBuilding && cap != null) ? listing.price <= cap : null,
      hcvCap:       cap,
      buildingPlans,
    };
  }

  function renderFMRSection(data) {
    const br       = parseInt(data.beds ?? 0, 10);
    const brCapped = Math.min(br, 4);
    const fmrValue = data.fmrValue;
    const diffPct  = data.diffPct;

    // Header badge
    if (data.fmrYear) {
      document.getElementById('header-badge').textContent = `HUD FMR · FY${data.fmrYear}`;
    }

    // Area tag
    const tag = data.fmrLevel === 'SAFMR' ? 'ZIP-level' : 'County-level';
    document.getElementById('fmr-area-tag').textContent = tag;

    // ── Multi-unit building: replace FMR table + diff + HCV with per-unit table ──
    const plans = data.buildingPlans;
    if (data.isBuilding && Array.isArray(plans) && plans.length > 0 && plans[0].diffPct != null) {
      let tableHtml = '';
      for (const plan of plans) {
        const brLabel  = BR_LABELS[Math.min(plan.beds, 4)] || `${plan.beds}BR`;
        const priceStr = plan.maxPrice > plan.minPrice
          ? `${fmtPrice(plan.minPrice)}+`
          : fmtPrice(plan.minPrice);
        let diffStr = '', diffCls = '';
        if (plan.diffPct != null) {
          const sign = plan.diffPct >= 0 ? '+' : '-';
          diffCls  = plan.diffPct > 20 ? 'red' : plan.diffPct < 0 ? 'green' : 'amber';
          diffStr  = `${sign}${Math.abs(plan.diffPct).toFixed(0)}%`;
        }
        const hcvIcon = plan.hcvEligible === true ? '✅' : plan.hcvEligible === false ? '⚠️' : '';
        tableHtml += `
          <div class="fmr-row building-plan-row">
            <span class="fmr-br">${esc(brLabel)}</span>
            <span class="fmr-price">${esc(priceStr)}/mo</span>
            ${diffStr ? `<span class="fmr-hcv plan-diff-${diffCls}">${diffStr}</span>` : ''}
            <span style="font-size:12px">${hcvIcon}</span>
          </div>`;
      }
      const tbl = document.getElementById('fmr-table');
      tbl.classList.add('building-plans-mode');
      tbl.innerHTML = tableHtml;
      // Hide single-unit diff badge + fraud signal for buildings
      hide('diff-badge');
      hide('fraud-signal');

      // Show HCV note for buildings (✅/⚠️ icons explained)
      const hcvCard   = document.getElementById('hcv-card');
      const statusEl  = document.getElementById('hcv-status');
      const capLineEl = document.getElementById('hcv-cap-line');
      hcvCard.classList.remove('eligible', 'over');
      hcvCard.classList.add('info');
      statusEl.textContent  = '✅ = may qualify for Section 8 rental assistance';
      capLineEl.textContent = 'Actual eligibility depends on your local housing authority';
      show('hcv-card');

      // Photo verification
      if (data.photoUrl) {
        const lensLink = document.getElementById('lens-link');
        if (lensLink) {
          const isZillow = data.url?.includes('zillow.com');
          lensLink.href = isZillow
            ? `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(data.photoUrl)}`
            : `https://www.bing.com/images/search?q=imgurl:${encodeURIComponent(data.photoUrl)}&view=detailv2&iss=sbi`;
          lensLink.textContent = isZillow ? '🔍 Verify photos with Google Lens' : '🔍 Verify photos with Bing';
          show('lens-wrap');
        }
      }
      setupFmrToggle(true);
      return;
    }

    // ── Single unit: standard FMR table + diff badge + HCV card ──────────────
    const fmr = data.fmr || buildFmrFromValue(data.fmrValue, brCapped);
    renderFmrTable('fmr-table', fmr, data.isBuilding ? -1 : brCapped);

    // Diff badge
    const diffEl = document.getElementById('diff-badge');
    if (diffPct != null && fmrValue) {
      const sign    = diffPct >= 0 ? '+' : '';
      const cls     = diffPct > 20 ? 'red' : diffPct < 0 ? 'green' : 'amber';
      const label   = diffPct >= 0 ? 'above fair market rent' : 'below fair market rent';
      diffEl.className = `diff-badge ${cls}`;
      diffEl.innerHTML =
        `${sign}${Math.abs(diffPct).toFixed(1)}% ${label} ` +
        `<span class="diff-detail">(${fmtPrice(data.price)} vs benchmark ${fmtPrice(fmrValue)})</span>`;
      show('diff-badge');
    }

    // Fraud signal
    const fraudEl = document.getElementById('fraud-signal');
    if (fmrValue && diffPct != null) {
      const ratio = data.price / fmrValue;
      if (ratio < 0.35) {
        fraudEl.textContent = '⛔ Extremely below market — potential fraud';
        show('fraud-signal');
      } else if (ratio < 0.50) {
        fraudEl.textContent = '⚠️ Unusually low price — verify authenticity';
        show('fraud-signal');
      }
    }

    // Photo verification link
    if (data.photoUrl) {
      const lensLink = document.getElementById('lens-link');
      if (lensLink) {
        const isZillow = data.url?.includes('zillow.com');
        lensLink.href = isZillow
          ? `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(data.photoUrl)}`
          : `https://www.bing.com/images/search?q=imgurl:${encodeURIComponent(data.photoUrl)}&view=detailv2&iss=sbi`;
        lensLink.textContent = isZillow ? '🔍 Verify photos with Google Lens' : '🔍 Verify photos with Bing';
        show('lens-wrap');
      }
    }

    // HCV card
    if (fmrValue != null && data.hcvEligible != null) {
      const hcvCard   = document.getElementById('hcv-card');
      const statusEl  = document.getElementById('hcv-status');
      const capLineEl = document.getElementById('hcv-cap-line');
      const officialCap = data.hcv?.[brCapped] ?? null;
      const cap         = officialCap || Math.round(fmrValue * 1.10);
      const capLabel    = officialCap ? 'official HUD standard' : 'estimated';

      if (data.hcvEligible) {
        hcvCard.classList.add('eligible');
        statusEl.textContent = '✅ May qualify for Section 8 rental assistance';
      } else {
        hcvCard.classList.add('over');
        const overPct = Math.round((data.price / cap - 1) * 100);
        statusEl.textContent = `⚠️ Likely over Section 8 limit · ${overPct}% above cap`;
      }
      capLineEl.textContent = `Section 8 limit: ${fmtPrice(cap)}/mo · ${capLabel}`;
      show('hcv-card');
    }

    setupFmrToggle(false);
  }

  // ── FMR table collapse toggle ──────────────────────────────────────────────

  function setupFmrToggle(isBuilding) {
    const header = document.getElementById('fmr-toggle-header');
    const wrap   = document.getElementById('fmr-collapse-wrap');
    const arrow  = document.getElementById('fmr-toggle-arrow');
    if (!header || !wrap || !arrow) return;

    if (isBuilding) {
      // Building mode: table IS the main content — no toggle
      header.classList.add('no-toggle');
      arrow.style.display = 'none';
      return;
    }

    // Restore collapse state from sessionStorage
    const isCollapsed = sessionStorage.getItem('fmrCollapsed') === 'true';
    if (isCollapsed) {
      wrap.classList.add('collapsed');
      arrow.classList.add('collapsed');
    }

    header.addEventListener('click', () => {
      const nowCollapsed = wrap.classList.toggle('collapsed');
      arrow.classList.toggle('collapsed', nowCollapsed);
      sessionStorage.setItem('fmrCollapsed', nowCollapsed);
    });
  }

  // Build a minimal fmr object from a single value (when only fmrValue stored, not full table)
  function buildFmrFromValue(fmrValue, br) {
    if (!fmrValue) return null;
    return { [String(br)]: fmrValue };
  }

  // ── Section 2: ZIP Lookup ──────────────────────────────────────────────────

  let fmrIndexCache = null;

  async function loadFmrIndex() {
    if (fmrIndexCache) return fmrIndexCache;
    try {
      const url = chrome.runtime.getURL('data/fmr_index.json');
      const res = await fetch(url);
      fmrIndexCache = await res.json();
      return fmrIndexCache;
    } catch (e) {
      return null;
    }
  }

  function lookupFMR(index, zipCode) {
    if (!index) return { error: 'not_loaded' };
    const zip = String(zipCode).trim().padStart(5, '0');

    if (index.safmr[zip]) {
      return {
        level: 'SAFMR', zip,
        fmr:   index.safmr[zip],
        hcv:   index.safmr[zip].hcv || null,
        fy:    index.meta.fy,
      };
    }
    const fips = index.zip_to_county[zip];
    if (fips && index.county[fips]) {
      const c = index.county[fips];
      return {
        level: 'county', zip, fips,
        areaName: c.name, state: c.state,
        fmr: { '0': c['0'], '1': c['1'], '2': c['2'], '3': c['3'], '4': c['4'] },
        hcv: null,
        fy:  index.meta.fy,
      };
    }
    return { error: 'not_found', zip };
  }

  function setupZipLookup() {
    const input  = document.getElementById('zip-input');
    const btn    = document.getElementById('zip-btn');
    const result = document.getElementById('lookup-result');

    async function doLookup() {
      const zip = input.value.trim().replace(/\D/g, '');
      if (zip.length !== 5) { input.focus(); return; }

      btn.disabled = true;
      result.classList.add('hidden');

      const index = await loadFmrIndex();
      btn.disabled = false;

      if (!index) {
        showLookupError(result, 'Unable to load FMR data');
        return;
      }

      const fmrData = lookupFMR(index, zip);
      if (fmrData.error) {
        showLookupError(result, `No FMR data found for ZIP ${zip}`);
        return;
      }

      renderLookupResult(result, fmrData);
    }

    btn.addEventListener('click', doLookup);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLookup(); });
    // Only allow digits
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 5);
    });
  }

  function showLookupError(container, msg) {
    container.innerHTML = `<div class="lookup-error">${esc(msg)}</div>`;
    container.classList.remove('hidden');
  }

  function renderLookupResult(container, fmrData) {
    const { fmr, hcv, fy, level, zip, areaName, state } = fmrData;

    let areaText = `ZIP ${zip}`;
    if (areaName)        areaText += ` · ${areaName}`;
    else if (state)      areaText += ` · ${state}`;
    const levelTag = level === 'SAFMR' ? 'ZIP-level' : 'County-level';

    let tableHtml = '';
    for (let n = 0; n <= 4; n++) {
      const val = fmr?.[String(n)];
      if (!val) continue;
      const hcvCap = hcv?.[n] ?? Math.round(val * 1.10);
      tableHtml += `
        <div class="fmr-row">
          <span class="fmr-br">${BR_LABELS[n]}</span>
          <span class="fmr-price">${fmtPrice(val)}</span>
          <span class="fmr-hcv">&nbsp;(HCV cap: ${fmtPrice(hcvCap)})</span>
        </div>`;
    }

    container.innerHTML = `
      <div class="lookup-area">
        ${esc(areaText)}
        <span class="level-tag">${levelTag} · FY${fy}</span>
      </div>
      <div class="lookup-fmr-table">${tableHtml}</div>
    `;
    container.classList.remove('hidden');
  }

  // ── Footer ─────────────────────────────────────────────────────────────────

  function setupFooter() {
    document.getElementById('footer-about').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('about.html') });
    });
    document.getElementById('footer-privacy').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('privacy.html') });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function renderFmrTable(containerId, fmr, activeBr) {
    if (!fmr) return;
    const container = document.getElementById(containerId);
    if (!container) return;
    let html = '';
    for (let n = 0; n <= 4; n++) {
      const val = fmr[String(n)];
      if (!val) continue;
      const active = n === activeBr;
      html += `
        <div class="fmr-row${active ? ' active' : ''}">
          <span class="fmr-br">${BR_LABELS[n]}</span>
          <span class="fmr-price">${fmtPrice(val)}</span>
        </div>`;
    }
    container.innerHTML = html;
  }

  function showState(state) {
    hide('current-section');
    const states = ['no-page', 'no-data', 'loading'];
    for (const s of states) {
      const el = document.getElementById(`state-${s}`);
      if (el) el.classList.toggle('hidden', s !== state);
    }
  }

  function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
  function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

  function fmtPrice(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  // Apartments.com listing pages have /property-slug/listing-id/ structure.
  // The ID is 5–12 alphanumeric chars with no hyphens.
  function isAptComListing(url) {
    try {
      const u = new URL(url);
      if (!u.hostname.includes('apartments.com')) return false;
      const segs = u.pathname.split('/').filter(Boolean);
      return segs.length >= 2 && /^[a-z0-9]{5,12}$/i.test(segs[1]);
    } catch (_) { return false; }
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

})();
