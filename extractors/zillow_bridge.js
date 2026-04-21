// Runs in MAIN world (page JS context) so it can read window.__NEXT_DATA__ directly.
// Communicates with the isolated-world content script via DOM attributes + CustomEvents.
// Zillow's CSP blocks inline script injection from the isolated world, so this bridge
// is the only reliable way to expose live page variables to the extension.
(function () {
  'use strict';

  const ATTR = 'data-rs-nd';

  function sync() {
    try {
      const nd = window.__NEXT_DATA__;
      if (!nd) { document.documentElement.removeAttribute(ATTR); return; }

      const b  = nd?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building ?? null;
      const lr = nd?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults ?? null;

      // Trim listResults to only the fields used by extractors — avoids storing thumbnail
      // URLs, marketing copy, and other large per-listing blobs in the DOM attribute.
      const lrSlim = Array.isArray(lr) ? lr.map(r => ({
        detailUrl:        r.detailUrl,
        statusType:       r.statusType,
        rawHomeStatusCd:  r.rawHomeStatusCd,
        addressZipcode:   r.addressZipcode,
        addressStreet:    r.addressStreet,
        addressCity:      r.addressCity,
        addressState:     r.addressState,
        isBuilding:       r.isBuilding,
        price:            r.price,
        unformattedPrice: r.unformattedPrice,
        beds:             r.beds,
        roomForRent:      r.roomForRent,
        units: Array.isArray(r.units) ? r.units.map(u => ({
          zpid: u.zpid, beds: u.beds, price: u.price, roomForRent: u.roomForRent,
        })) : undefined,
      })) : null;

      const slim = {
        query: nd.query,
        props: { pageProps: {
          componentProps: b ? { initialReduxState: { gdp: { building: b } } } : undefined,
          searchPageState: lrSlim
            ? { cat1: { searchResults: { listResults: lrSlim } } }
            : undefined,
        }},
      };

      document.documentElement.setAttribute(ATTR, JSON.stringify(slim));
    } catch (_) {
      document.documentElement.removeAttribute(ATTR);
    }
  }

  // Sync on demand from isolated world (synchronous — fires before dispatchEvent returns)
  document.addEventListener('rs-sync-nd', sync);

  // Proactive re-sync after SPA navigation. Zillow updates window.__NEXT_DATA__ after
  // React re-renders, which happens asynchronously after history.pushState fires.
  // Schedule multiple syncs to catch it as soon as React finishes updating.
  const _push = history.pushState.bind(history);
  history.pushState = function (...args) {
    const r = _push(...args);
    setTimeout(sync, 0);
    setTimeout(sync, 500);
    return r;
  };
  window.addEventListener('popstate', () => {
    setTimeout(sync, 0);
    setTimeout(sync, 500);
  });

  // Initial sync: window.__NEXT_DATA__ is set after DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sync);
  } else {
    sync();
  }
})();
