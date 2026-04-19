// RentScope — i18n/locales.js
// English-only string table. Centralised so future locale support is easy to add.

const LOCALES = {
  en: {
    appName:        'RentScope',
    headerBadge:    'HUD FMR',
    noPage:         'Open a Zillow rental listing to see FMR data',
    noPageSub:      'Supports zillow.com/apartments/ and /homedetails/',
    loading:        'Looking up FMR data…',
    zipNotFound:    'No FMR data for this ZIP code',
    zipNotFoundSub: 'HUD may not publish FMR for this area',
    zipLookupLabel: 'ZIP code',
    zipLookupBtn:   'Look up',
    zipLookupPlaceholder: '10001',
    fmrTableTitle:  'Fair Market Rents',
    yourListing:    'Your listing',
    aboveFMR:       'above FMR',
    belowFMR:       'below FMR',
    multiUnit:      'Multi-unit — starting from',
    hcvEligible:    '✅ Within Section 8 HCV limit',
    hcvOver:        '⚠️ Exceeds Section 8 HCV limit',
    hcvCap:         'HCV cap',
    hcvNote:        'Actual approval depends on local PHA',
    fraudLow:       '⚠️ Unusually low — verify authenticity',
    fraudExtreme:   '⛔ Extremely below market — potential fraud',
    sourcePrefix:   'Source:',
    safmrLevel:     'ZIP-level (SAFMR)',
    countyLevel:    'County-level FMR',
    footerBrand:    '🏠 RentScope',
    footerSub:      'About · Privacy · HUD Data',
    brLabels:       ['Studio', '1BR', '2BR', '3BR', '4BR'],
  },
};

// Always use English for now
const L = LOCALES.en;

window.L = L;
