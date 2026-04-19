// RentScope — background.js
// Loads fmr_index.json and handles FMR lookup requests from content.js.

let fmrIndex = null; // { meta, safmr, county, zip_to_county }

// ── Load index ────────────────────────────────────────────────────────────────

async function loadIndex() {
  if (fmrIndex) return fmrIndex;
  try {
    const url = chrome.runtime.getURL('data/fmr_index.json');
    const res = await fetch(url);
    fmrIndex = await res.json();
  } catch (e) {
    // Fail silently — queries will return not_loaded
  }
  return fmrIndex;
}

chrome.runtime.onInstalled.addListener((details) => {
  loadIndex();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('about.html') });
  }
});
chrome.runtime.onStartup.addListener(() => loadIndex());

// ── FMR Lookup ────────────────────────────────────────────────────────────────

function lookupFMR(zipCode) {
  if (!fmrIndex) return { error: 'not_loaded' };

  const zip = String(zipCode).trim().padStart(5, '0');

  // 1. SAFMR (ZIP-level, 53 metros — most precise)
  if (fmrIndex.safmr[zip]) {
    return {
      level: 'SAFMR',
      zip,
      fmr:  fmrIndex.safmr[zip],          // { "0":n, "1":n, ..., "4":n }
      hcv:  fmrIndex.safmr[zip].hcv || null, // official 110% payment standard, or null
      fy:   fmrIndex.meta.fy,
    };
  }

  // 2. County FMR fallback
  const fips = fmrIndex.zip_to_county[zip];
  if (fips && fmrIndex.county[fips]) {
    const c = fmrIndex.county[fips];
    return {
      level:    'county',
      zip,
      fips,
      areaName: c.name,
      state:    c.state,
      fmr:      { '0': c['0'], '1': c['1'], '2': c['2'], '3': c['3'], '4': c['4'] },
      hcv:      null, // county FMR doesn't include payment standard
      fy:       fmrIndex.meta.fy,
    };
  }

  return { error: 'not_found', zip };
}

// ── Badge ─────────────────────────────────────────────────────────────────────

function setBadge(tabId, diffPct) {
  const abs = Math.abs(Math.round(diffPct));
  const text = (diffPct > 0 ? '+' : '-') + abs + '%';
  const color = diffPct > 20  ? '#FF453A'   // red   — significantly above FMR
              : diffPct < 0   ? '#30D158'   // green — below FMR
              :                 '#FF9F0A';  // amber — within 0–20% above FMR
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
}

function clearBadge(tabId) {
  chrome.action.setBadgeText({ text: '', tabId });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    clearBadge(tabId);
    // Clear stored listing so popup never shows stale data from a previous site/page.
    chrome.storage.local.remove('rent_current');
  }
});

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // content.js → background: look up FMR for a ZIP
  if (msg.action === 'LOOKUP_FMR') {
    loadIndex().then(() => {
      sendResponse(lookupFMR(msg.zipCode));
    });
    return true; // async
  }

  // content.js → background: set badge after computing diff
  if (msg.action === 'SET_BADGE') {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    if (msg.diffPct != null) {
      setBadge(tabId, msg.diffPct);
    } else {
      clearBadge(tabId);
    }
    return false;
  }

});
