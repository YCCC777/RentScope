<p align="center">
  <img src="imag/RentScope_logo.png" alt="RentScope" width="110" style="border-radius:22px;">
</p>

<h1 align="center">RentScope</h1>

<p align="center">
  Is your rent fair? See HUD Fair Market Rents on Zillow and Apartments.com.<br>
  Know instantly if a listing is overpriced — and whether Section 8 vouchers apply.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/rentscope">
    <img src="https://img.shields.io/badge/Chrome_Web_Store-coming_soon-teal?logo=googlechrome&logoColor=white" alt="Chrome Web Store">
  </a>
  <img src="https://img.shields.io/badge/version-1.2.0-00C9A7" alt="version">
  <img src="https://img.shields.io/badge/data-HUD_FY2025-blue" alt="HUD FY2025">
  <img src="https://img.shields.io/badge/privacy-zero_data_collection-30D158" alt="privacy">
</p>

---

## What RentScope does

| | |
|---|---|
| 📊 | HUD Fair Market Rents overlay on Zillow & Apartments.com |
| 🏠 | Studio through 4BR FMR table per listing |
| 📍 | ZIP-level precision (38,000+ ZIPs) |
| 🎫 | Section 8 HCV payment standard check |
| ⚠️ | Market-relative fraud signal |
| 🔍 | Manual ZIP code lookup for any US ZIP |

## How to use

1. Go to **zillow.com** or **apartments.com** and open a rental listing
2. RentScope automatically shows an **FMR overlay** on the listing page
3. The overlay shows the **full FMR table** (Studio–4BR) — your unit size is highlighted
4. See the **% above or below FMR** at a glance — green means fair, red means overpriced
5. Multi-unit buildings show a **per floor plan breakdown** with individual diff% for each unit type
6. Check **Section 8 HCV eligibility** — whether the listing is within payment standard limits
7. Use the popup's **ZIP lookup** to check any area's FMR without opening a listing

## Data sources

### 🏛️ HUD Fair Market Rents (FY2025)
Source: **U.S. Department of Housing and Urban Development**. Fair Market Rents (FMRs) represent HUD's estimate of the 40th percentile gross rent for standard quality units in each area. RentScope uses SAFMR (Small Area FMRs) for ZIP-level precision where available, with county-level FMRs as fallback.

> 38,642 ZIP codes (SAFMR) + 2,600+ counties · updated annually in October

### 🗺️ Census ZCTA–County Crosswalk
Source: **U.S. Census Bureau** — ZCTA to county relationship file. Used to map ZIP codes to county FIPS codes for the county-level FMR fallback.

> 33,000+ ZIP-to-county mappings · Census 2020

All data is from public U.S. government sources and is bundled inside the extension — no network requests are made at runtime.

## Privacy

**RentScope collects no personal data and sends nothing to any server.** All processing happens entirely within your browser. No analytics, no tracking pixels, no third-party SDKs, and no network requests to any external service.

## Changelog

### v1.2.0
- Bug fixes and stability improvements for SPA navigation on Zillow
- Popup "No data found" hint when overlay cannot load (prompts F5 refresh)

### v1.1.0 — Apartments.com support
- HUD FMR overlay on Apartments.com rental listings
- Multi-unit buildings: per floor plan breakdown (Studio / 1BR / 2BR …) with individual diff%
- Photo verification via Bing Image Search on Apartments.com

### v1.0.0 — Initial Release
- HUD FMR overlay on Zillow rental listings (apartments + homedetails)
- ZIP-level SAFMR precision for 38,000+ ZIPs; county fallback for the rest
- Full FMR table (Studio–4BR) with active unit highlighted
- Diff % badge — green (at/below FMR), amber (+0–20%), red (>+20%)
- Section 8 HCV payment standard check (official HUD cap where available)
- Market-relative fraud signal (price < 50% or 35% of FMR)
- Popup ZIP lookup for any US ZIP code
- SPA navigation support (Zillow floating panel mode)

## Support development

RentScope is completely free. If it helps you find a fair place to live, a small contribution keeps the lights on ☕

[![Ko-fi](https://img.shields.io/badge/Ko--fi-ko--fi.com/risa__studio-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/risa_studio)

## About

RentScope is built by [Risa Studio](https://yccc777.github.io/risa-studio/), the same team behind [StayScope](https://chromewebstore.google.com/detail/stayscope/khmhjiafkapmhakmpfcgmgikkffejnpm), [CarScope](https://chromewebstore.google.com/detail/carscope/bgngcnkdeegfjgfblhdkiclomcneiaoj), and JobScope.

> Zero data collection · Local-first · No API keys

For questions or feedback: [risachou7@gmail.com](mailto:risachou7@gmail.com)
