# RentScope FMR Pre-processing Script
# =====================================
# Automatically downloads all required HUD / Census data and produces:
#   RentScope/data/fmr_index.json   — bundled into extension (~2–3 MB)
#
# Run (from chrome plugin root dir):
#   python RentScope/scripts/process_fmr.py
#
# Requirements:
#   pip install pandas openpyxl requests
#
# All source files are public government data — no account or token needed.

import pandas as pd
import json
import os
import io
import requests
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────

SCRIPT_DIR  = Path(__file__).resolve().parent
RENTSCOPE   = SCRIPT_DIR.parent
INPUTS_DIR  = RENTSCOPE / "inputs"
OUTPUT_FILE = RENTSCOPE / "data" / "fmr_index.json"

FY = 2025

# Source URLs (all public, no authentication required)
SOURCES = {
    "safmr":   "https://www.huduser.gov/portal/datasets/fmr/fmr2025/fy2025_safmrs_revised.xlsx",
    "county":  "https://www.huduser.gov/portal/datasets/fmr/fmr2025/FY25_FMRs_revised.xlsx",
    "xwk":     "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt",
}

# ── HUD Excel workaround ─────────────────────────────────────────────────────

def read_hud_excel(path, **kwargs):
    """
    Read an HUD-published xlsx file, working around a known metadata bug.

    Some HUD files contain a malformed ISO datetime in docProps/core.xml,
    e.g. "2025- 2-18T20:40:31Z" (space-padded day).  openpyxl validates this
    strictly and raises ValueError before any data is read.

    Fix: open the xlsx as a zip, patch the datetime in core.xml with zero-
    padded values, then hand the corrected bytes to pandas — no extra packages
    required.
    """
    import zipfile, io, re

    def _fix_core_xml(data: bytes) -> bytes:
        text = data.decode("utf-8")
        # Normalise any space-padded month/day: "2025- 2-18" → "2025-02-18"
        text = re.sub(
            r"(\d{4})-\s*(\d{1,2})-\s*(\d{1,2})",
            lambda m: f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}",
            text,
        )
        return text.encode("utf-8")

    try:
        return pd.read_excel(path, dtype=str, **kwargs)
    except ValueError:
        pass  # fall through to XML patch

    with open(path, "rb") as f:
        raw = f.read()

    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw), "r") as zin, \
         zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "docProps/core.xml":
                data = _fix_core_xml(data)
            zout.writestr(item, data)

    buf.seek(0)
    return pd.read_excel(buf, dtype=str, **kwargs)


# ── Download helpers ─────────────────────────────────────────────────────────

def download(url, dest: Path, label: str):
    """Download a file if not already cached in inputs/."""
    if dest.exists():
        print(f"  {label}: cached ({dest.name})")
        return
    print(f"  {label}: downloading from {url} ...")
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(r.content)
    size_kb = dest.stat().st_size / 1024
    print(f"  {label}: saved {size_kb:.0f} KB → {dest.name}")

# ── Column detection ─────────────────────────────────────────────────────────

def norm_col(s):
    """Normalize column name: strip newlines/extra spaces, lowercase."""
    import re
    return re.sub(r"\s+", " ", str(s).replace("\n", " ").replace("\r", " ")).strip().lower()

def find_col(df, candidates, label):
    """Find the first matching column (case-insensitive, newline-tolerant)."""
    # Build a map from normalized name → original column name
    norm_map = {norm_col(c): c for c in df.columns}
    for c in candidates:
        if c in df.columns:
            return c
        if norm_col(c) in norm_map:
            return norm_map[norm_col(c)]
    raise ValueError(
        f"Cannot find '{label}' column.\n"
        f"Tried: {candidates}\n"
        f"Available: {list(df.columns)}"
    )

# ── Normalizers ──────────────────────────────────────────────────────────────

def zip5(z):
    try:
        return str(int(float(str(z)))).zfill(5)
    except (ValueError, TypeError):
        return None

def fips5(f):
    try:
        s = str(f).strip()
        # HUD county FMR uses 10-digit FMR area codes (e.g. "0100199999");
        # the first 5 digits are the standard state+county FIPS ("01001").
        # Census crosswalk uses the same 5-digit format.
        if len(s) >= 5:
            candidate = s[:5]
            if candidate.isdigit():
                return candidate
        # Short strings: zero-pad up to 5
        padded = s.zfill(5)
        return padded if len(padded) == 5 and padded.isdigit() else None
    except (ValueError, TypeError):
        return None

# ── Step 1: SAFMR (ZIP-level, 53 metros) ────────────────────────────────────

def load_safmr():
    dest = INPUTS_DIR / "fy2025_safmrs_revised.xlsx"
    download(SOURCES["safmr"], dest, "SAFMR")

    print(f"\nParsing SAFMR ...")
    df = read_hud_excel(dest)
    print(f"  Rows: {len(df):,}  Columns: {list(df.columns)}")

    col_zip  = find_col(df, ["ZIP Code", "zip", "ZIP", "zcta", "ZCTA", "zip_code"], "ZIP")
    col_fmr0 = find_col(df, ["SAFMR 0BR", "fmr_0", "FMR_0", "Efficiency", "efficiency", "br0"], "Studio FMR")
    col_fmr1 = find_col(df, ["SAFMR 1BR", "fmr_1", "FMR_1", "One-Bedroom", "one_bedroom", "br1"], "1BR FMR")
    col_fmr2 = find_col(df, ["SAFMR 2BR", "fmr_2", "FMR_2", "Two-Bedroom", "two_bedroom", "br2"], "2BR FMR")
    col_fmr3 = find_col(df, ["SAFMR 3BR", "fmr_3", "FMR_3", "Three-Bedroom", "three_bedroom", "br3"], "3BR FMR")
    col_fmr4 = find_col(df, ["SAFMR 4BR", "fmr_4", "FMR_4", "Four-Bedroom", "four_bedroom", "br4"], "4BR FMR")

    # 110% Payment Standard columns (HCV voucher upper limit) — optional
    def try_find(candidates):
        try:
            return find_col(df, candidates, "")
        except ValueError:
            return None

    col_hcv0 = try_find(["SAFMR 0BR - 110% Payment Standard", "hcv_0"])
    col_hcv1 = try_find(["SAFMR 1BR - 110% Payment Standard", "hcv_1"])
    col_hcv2 = try_find(["SAFMR 2BR - 110% Payment Standard", "hcv_2"])
    col_hcv3 = try_find(["SAFMR 3BR - 110% Payment Standard", "hcv_3"])
    col_hcv4 = try_find(["SAFMR 4BR - 110% Payment Standard", "hcv_4"])
    has_hcv  = all([col_hcv0, col_hcv1, col_hcv2, col_hcv3, col_hcv4])
    if has_hcv:
        print(f"  110% Payment Standard columns found — storing HCV limits")

    safmr = {}
    skipped = 0
    for _, row in df.iterrows():
        z = zip5(row[col_zip])
        if not z:
            skipped += 1
            continue
        try:
            vals = [int(float(row[col_fmr0])),
                    int(float(row[col_fmr1])),
                    int(float(row[col_fmr2])),
                    int(float(row[col_fmr3])),
                    int(float(row[col_fmr4]))]
        except (ValueError, TypeError):
            skipped += 1
            continue
        if vals[2] == 0:
            skipped += 1
            continue
        entry = {"0": vals[0], "1": vals[1], "2": vals[2], "3": vals[3], "4": vals[4]}
        if has_hcv:
            try:
                entry["hcv"] = [int(float(row[col_hcv0])),
                                 int(float(row[col_hcv1])),
                                 int(float(row[col_hcv2])),
                                 int(float(row[col_hcv3])),
                                 int(float(row[col_hcv4]))]
            except (ValueError, TypeError):
                pass
        safmr[z] = entry

    print(f"  Valid SAFMR ZIPs: {len(safmr):,}  (skipped: {skipped:,})")
    return safmr

# ── Step 2: County FMR (full US coverage) ────────────────────────────────────

def load_county_fmr():
    dest = INPUTS_DIR / "FY25_FMRs_revised.xlsx"
    download(SOURCES["county"], dest, "County FMR")

    print(f"\nParsing County FMR ...")
    df = read_hud_excel(dest)
    print(f"  Rows: {len(df):,}  Columns: {list(df.columns)}")

    col_fips  = find_col(df, ["fips", "fips2010", "FIPS", "county_code", "countyfips",
                               "Metro_Code", "metro_code", "code"], "FIPS")
    col_name  = find_col(df, ["hud_area_name", "countyname", "areaname", "area_name",
                               "county_name", "Metro_Area_Name", "metro_name", "Area_Name"], "area name")
    # stusps = 2-letter abbreviation; 'state' = numeric FIPS state code
    col_state = find_col(df, ["stusps", "state_alpha", "State_Alpha", "statecode",
                               "state", "STATE"], "state")
    col_fmr0  = find_col(df, ["fmr_0", "FMR_0", "Efficiency", "efficiency", "br0",
                               "Zero-Bedroom", "zero_bedroom"], "Studio FMR")
    col_fmr1  = find_col(df, ["fmr_1", "FMR_1", "One-Bedroom", "one_bedroom", "br1"], "1BR FMR")
    col_fmr2  = find_col(df, ["fmr_2", "FMR_2", "Two-Bedroom", "two_bedroom", "br2"], "2BR FMR")
    col_fmr3  = find_col(df, ["fmr_3", "FMR_3", "Three-Bedroom", "three_bedroom", "br3"], "3BR FMR")
    col_fmr4  = find_col(df, ["fmr_4", "FMR_4", "Four-Bedroom", "four_bedroom", "br4"], "4BR FMR")

    county = {}
    skipped = 0
    for _, row in df.iterrows():
        f = fips5(row[col_fips])
        if not f:
            skipped += 1
            continue
        try:
            vals = [int(float(row[col_fmr0])),
                    int(float(row[col_fmr1])),
                    int(float(row[col_fmr2])),
                    int(float(row[col_fmr3])),
                    int(float(row[col_fmr4]))]
        except (ValueError, TypeError):
            skipped += 1
            continue
        if vals[2] == 0:
            skipped += 1
            continue
        name  = str(row[col_name]).strip()
        state = str(row[col_state]).strip().upper()[:2]
        county[f] = {
            "name": name, "state": state,
            "0": vals[0], "1": vals[1], "2": vals[2], "3": vals[3], "4": vals[4]
        }

    print(f"  Valid County FIPS: {len(county):,}  (skipped: {skipped:,})")
    return county

# ── Step 3: ZIP → County crosswalk (Census Bureau, no auth) ──────────────────

def load_crosswalk():
    dest = INPUTS_DIR / "tab20_zcta520_county20_natl.txt"
    download(SOURCES["xwk"], dest, "ZIP→County crosswalk")

    print(f"\nParsing ZIP→County crosswalk ...")
    df = pd.read_csv(dest, sep="|", dtype=str)
    print(f"  Rows: {len(df):,}  Columns: {list(df.columns)}")

    # Census columns: GEOID_ZCTA5_20, GEOID_COUNTY_20, AREALAND_PART
    col_zip    = find_col(df, ["GEOID_ZCTA5_20", "ZCTA5CE20", "GEOID_ZCTA5"], "ZCTA/ZIP")
    col_county = find_col(df, ["GEOID_COUNTY_20", "COUNTYFP20", "GEOID_COUNTY"], "County FIPS")
    col_area   = find_col(df, ["AREALAND_PART", "AREALAND", "arealand_part"], "land area overlap")

    df["_zip"]    = df[col_zip].apply(lambda x: str(x).strip().zfill(5))
    df["_county"] = df[col_county].apply(fips5)
    df["_area"]   = pd.to_numeric(df[col_area], errors="coerce").fillna(0)

    df = df.dropna(subset=["_zip", "_county"])

    # For each ZIP, take the county with the largest land area overlap
    idx = df.groupby("_zip")["_area"].idxmax()
    best = df.loc[idx][["_zip", "_county"]].copy()

    xwk = dict(zip(best["_zip"], best["_county"]))
    print(f"  ZIP→County mappings: {len(xwk):,}")
    return xwk

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    print(f"\n{'='*60}")
    print(f"  RentScope FMR Processor — FY{FY}")
    print(f"{'='*60}")
    print(f"\nDownloading source files (cached after first run)...")

    safmr  = load_safmr()
    county = load_county_fmr()
    xwk    = load_crosswalk()

    # Coverage summary
    safmr_covered  = sum(1 for z in xwk if z in safmr)
    county_covered = sum(1 for z in xwk if z not in safmr and xwk.get(z) in county)
    no_coverage    = sum(1 for z in xwk if z not in safmr and xwk.get(z) not in county)

    print(f"\nCoverage:")
    print(f"  ZIP with SAFMR (ZIP-level):   {len(safmr):>6,}")
    print(f"  ZIP with county fallback:     {county_covered:>6,}")
    print(f"  ZIP with no FMR data:         {no_coverage:>6,}")

    output = {
        "meta": {
            "fy":           FY,
            "generated":    pd.Timestamp.now().strftime("%Y-%m-%d"),
            "safmr_zips":   len(safmr),
            "county_count": len(county),
            "xwk_count":    len(xwk),
            "source":       f"HUD FMR FY{FY} (revised) + Census ZCTA 2020",
        },
        "safmr":         safmr,
        "county":        county,
        "zip_to_county": xwk,
    }

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, separators=(",", ":"), ensure_ascii=False)

    size_mb = os.path.getsize(OUTPUT_FILE) / 1024 / 1024
    print(f"\nOutput: {OUTPUT_FILE}")
    print(f"  File size:   {size_mb:.2f} MB")
    print(f"  SAFMR ZIPs:  {len(safmr):,}")
    print(f"  County FIPS: {len(county):,}")
    print(f"  ZIP→County:  {len(xwk):,}")

    # Spot checks
    print("\nSpot check:")
    for zip_code, label in [("10001", "NYC 10001"), ("78701", "Austin TX"), ("90210", "Beverly Hills")]:
        if zip_code in safmr:
            print(f"  {label}: SAFMR 2BR = ${safmr[zip_code]['2']:,}")
        elif xwk.get(zip_code) in county:
            f = xwk[zip_code]
            print(f"  {label}: county fallback ({county[f]['name']}) 2BR = ${county[f]['2']:,}")
        else:
            print(f"  {label}: no coverage")

    print("\nDone.")

if __name__ == "__main__":
    main()
