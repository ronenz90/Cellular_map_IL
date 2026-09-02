#!/usr/bin/env python3
"""
fetch_data.py
מושך את נתוני האנטנות הסלולריות העדכניים מ-data.gov.il (CKAN API) של
המשרד להגנת הסביבה, וממיר אותם ל-GeoJSON לשימוש באפליקציה.

מקורות (CKAN dataset names):
  - antennaactive   -> אנטנות סלולריות פעילות
  - antenna_hakama  -> אנטנות סלולריות בהקמה

הרצה:
  python3 scripts/fetch_data.py
פלט:
  data/antennas-active.geojson
  data/antennas-planned.geojson
  data/meta.json

הסקריפט הזה מיועד לרוץ אוטומטית דרך GitHub Actions
(ראו .github/workflows/update-data.yml) בתדירות קבועה.
"""

import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

BASE_API = "https://data.gov.il/api/3/action"
OUT_DIR = Path(__file__).resolve().parent.parent / "data"

DATASETS = {
    "active": "antennaactive",
    "planned": "antenna_hakama",
}

# שמות עמודות אפשריים למיקום (lon/lat) בקובץ המקור - הממשלה לא תמיד עקבית
LON_KEYS = ["lon", "Lon", "LON", "X_WGS84", "longitude"]
LAT_KEYS = ["lat", "Lat", "LAT", "Y_WGS84", "latitude"]

# שמות עמודות אפשריים לקואורדינטות ITM (רשת ישראל החדשה, EPSG:2039) - במטרים.
# הרבה מהמאגרים הממשלתיים כוללים *רק* את אלה, ללא lon/lat ישירים!
X_ITM_KEYS = ["X", "x", "X_ITM", "ITM_X", "east", "Easting"]
Y_ITM_KEYS = ["Y", "y", "Y_ITM", "ITM_Y", "north", "Northing"]


# ---------------------------------------------------------------------------
# המרת ITM (Israel Transverse Mercator, EPSG:2039) -> WGS84 lon/lat.
# פרמטרים רשמיים של הרשת (מקור: מרכז המיפוי הישראלי). נבדק ב-round-trip
# עד דיוק של מילימטרים בודדים, ראו הערת פיתוח.
# ---------------------------------------------------------------------------
_ITM_A = 6378137.0
_ITM_F = 1 / 298.257222101
_ITM_E2 = 2 * _ITM_F - _ITM_F ** 2
_ITM_LAT0 = math.radians(31.73439361111111)
_ITM_LON0 = math.radians(35.20451694444445)
_ITM_K0 = 1.0000067
_ITM_FE = 219529.584
_ITM_FN = 626907.390


def _meridional_arc(lat):
    e2 = _ITM_E2
    return _ITM_A * (
        (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * lat
        - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * math.sin(2 * lat)
        + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * math.sin(4 * lat)
        - (35 * e2 ** 3 / 3072) * math.sin(6 * lat)
    )


def itm_to_wgs84(x, y):
    """ממיר קואורדינטת ITM (מטרים) לזוג (lon, lat) במעלות WGS84."""
    x = x - _ITM_FE
    y = y - _ITM_FN
    e2 = _ITM_E2
    M0 = _meridional_arc(_ITM_LAT0)
    M = y / _ITM_K0 + M0
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    mu = M / (_ITM_A * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu)
            + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    ep2 = e2 / (1 - e2)
    C1 = ep2 * math.cos(phi1) ** 2
    T1 = math.tan(phi1) ** 2
    N1 = _ITM_A / math.sqrt(1 - e2 * math.sin(phi1) ** 2)
    R1 = _ITM_A * (1 - e2) / (1 - e2 * math.sin(phi1) ** 2) ** 1.5
    D = x / (N1 * _ITM_K0)
    lat = phi1 - (N1 * math.tan(phi1) / R1) * (
        D ** 2 / 2
        - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4 / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6 / 720
    )
    lon = _ITM_LON0 + (
        D - (1 + 2 * T1 + C1) * D ** 3 / 6
        + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5 / 120
    ) / math.cos(phi1)
    return math.degrees(lon), math.degrees(lat)


def http_get_json(url, retries=3, timeout=30):
    last_err = None
    for attempt in range(retries):
        try:
            req = Request(url, headers={"User-Agent": "antenna-map-fetcher/1.0"})
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (URLError, HTTPError) as e:
            last_err = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"נכשל בגישה ל-{url}: {last_err}")


def get_datastore_resource_id(package_name):
    """מוצא את ה-resource_id הראשון עם datastore פעיל בתוך package נתון."""
    data = http_get_json(f"{BASE_API}/package_show?id={package_name}")
    if not data.get("success"):
        raise RuntimeError(f"package_show נכשל עבור {package_name}")
    resources = data["result"]["resources"]
    for r in resources:
        if r.get("datastore_active"):
            return r["id"]
    # fallback: קח את המשאב הראשון (אולי CSV/GeoJSON ישיר)
    if resources:
        return resources[0].get("id"), resources[0].get("url")
    raise RuntimeError(f"לא נמצא משאב עבור {package_name}")


def fetch_all_records(resource_id, page_size=1000):
    """שולף את כל הרשומות מ-datastore_search עם pagination."""
    records = []
    offset = 0
    while True:
        url = f"{BASE_API}/datastore_search?resource_id={resource_id}&limit={page_size}&offset={offset}"
        data = http_get_json(url)
        if not data.get("success"):
            break
        batch = data["result"]["records"]
        records.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return records


def find_key(row, candidates):
    for c in candidates:
        if c in row and row[c] not in (None, ""):
            return row[c]
    return None


def records_to_geojson(records):
    features = []
    skipped = 0
    used_itm_fallback = 0

    if records:
        sample_keys = list(records[0].keys())
        print(f"  שדות זמינים ברשומה לדוגמה: {sample_keys}", file=sys.stderr)

    for row in records:
        lon = find_key(row, LON_KEYS)
        lat = find_key(row, LAT_KEYS)
        lon_f = lat_f = None

        if lon is not None and lat is not None:
            try:
                lon_f, lat_f = float(lon), float(lat)
            except (TypeError, ValueError):
                lon_f = lat_f = None

        # פולבאק: אין lon/lat ישירים - ננסה להמיר מקואורדינטות ITM (X/Y)
        if lon_f is None or lat_f is None:
            x_val = find_key(row, X_ITM_KEYS)
            y_val = find_key(row, Y_ITM_KEYS)
            if x_val is not None and y_val is not None:
                try:
                    lon_f, lat_f = itm_to_wgs84(float(x_val), float(y_val))
                    used_itm_fallback += 1
                except (TypeError, ValueError):
                    lon_f = lat_f = None

        if lon_f is None or lat_f is None:
            skipped += 1
            continue

        # ולידציה גסה שהקואורדינטה בתחום ישראל
        if not (33.5 < lon_f < 36.0 and 29.0 < lat_f < 33.5):
            skipped += 1
            continue

        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon_f, 6), round(lat_f, 6)]},
            "properties": row,
        })

    print(f"  -> {len(features)} רשומות תקינות ({used_itm_fallback} מהן הומרו מ-ITM), {skipped} דולגו (חסר מיקום תקין)", file=sys.stderr)
    return {"type": "FeatureCollection", "features": features}


def process_dataset(package_name, out_filename):
    print(f"מושך {package_name} ...", file=sys.stderr)
    resource_id = get_datastore_resource_id(package_name)
    if isinstance(resource_id, tuple):
        # אין datastore פעיל - נדרש טיפול ידני בקובץ (CSV/XLSX ישיר)
        rid, direct_url = resource_id
        print(f"  אזהרה: אין datastore פעיל, נדרש הורדה ישירה מ-{direct_url}", file=sys.stderr)
        return None
    records = fetch_all_records(resource_id)
    geojson = records_to_geojson(records)
    new_count = len(geojson["features"])

    out_path = OUT_DIR / out_filename
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # הגנה: אם כבר קיים קובץ עם נתונים תקינים, ולא נשלפה אף רשומה תקינה
    # הפעם (או שיש נפילה חדה של >70% ברשומות) - כנראה יש בעיה בשליפה
    # (שינוי מבנה עמודות בצד הממשלה וכו') ולא באמת "0 אנטנות". לא דורסים
    # במקרה הזה נתונים תקינים בריקים - שומרים את הישן ומדווחים על כך בברור.
    if out_path.exists():
        try:
            old_geojson = json.loads(out_path.read_text(encoding="utf-8"))
            old_count = len(old_geojson.get("features", []))
        except json.JSONDecodeError:
            old_count = 0
        if old_count > 0 and new_count < old_count * 0.3:
            print(f"  ⚠️ אזהרה: הקובץ הקודם הכיל {old_count} רשומות, השליפה החדשה הניבה רק {new_count}. "
                  f"נראה כמו כשל שליפה (שינוי מבנה נתונים בצד הממשלה?) - לא דורס את הקובץ הקיים. "
                  f"בדוק את הלוגים למעלה (שדות זמינים ברשומה לדוגמה) ועדכן את LON_KEYS/LAT_KEYS/X_ITM_KEYS/Y_ITM_KEYS.",
                  file=sys.stderr)
            return old_count

    out_path.write_text(json.dumps(geojson, ensure_ascii=False), encoding="utf-8")
    print(f"  נשמר: {out_path} ({new_count} מוקדים)", file=sys.stderr)
    return new_count


CITY_KEYS = ["רשות מקומית", "ישוב", "עיר", "city", "locality"]


def count_by_city(geojson_path):
    """סופר אנטנות לפי יישוב מתוך קובץ ה-GeoJSON שנכתב, לצורך היסטוריה."""
    if not geojson_path.exists():
        return {}
    data = json.loads(geojson_path.read_text(encoding="utf-8"))
    counts = {}
    for f in data.get("features", []):
        props = f.get("properties", {})
        city = find_key(props, CITY_KEYS)
        if not city:
            continue
        counts[city] = counts.get(city, 0) + 1
    return counts


def update_history(active_count, planned_count, by_city, max_entries=180):
    """מוסיף רשומת snapshot יומית ל-data/history.json (לצורך גרף מגמה
    בממשק). שומר עד max_entries רשומות אחרונות כדי שהקובץ לא יתנפח."""
    history_path = OUT_DIR / "history.json"
    history = []
    if history_path.exists():
        try:
            history = json.loads(history_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            history = []

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    entry = {
        "date": today,
        "active_count": active_count or 0,
        "planned_count": planned_count or 0,
        "by_city": by_city,
    }

    # אם כבר יש רשומה מהיום - עדכן אותה במקום להוסיף כפולה
    if history and history[-1].get("date") == today:
        history[-1] = entry
    else:
        history.append(entry)

    history = history[-max_entries:]
    history_path.write_text(json.dumps(history, ensure_ascii=False), encoding="utf-8")
    print(f"history.json עודכן ({len(history)} רשומות)", file=sys.stderr)


def main():
    counts = {}
    try:
        counts["active"] = process_dataset(DATASETS["active"], "antennas-active.geojson")
    except Exception as e:
        print(f"שגיאה בשליפת אנטנות פעילות: {e}", file=sys.stderr)
        counts["active"] = None

    try:
        counts["planned"] = process_dataset(DATASETS["planned"], "antennas-planned.geojson")
    except Exception as e:
        print(f"שגיאה בשליפת אנטנות בהקמה: {e}", file=sys.stderr)
        counts["planned"] = None

    meta = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "source": "https://data.gov.il/dataset/antennaactive",
        "counts": counts,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print("meta.json נכתב בהצלחה", file=sys.stderr)

    by_city = count_by_city(OUT_DIR / "antennas-active.geojson")
    update_history(counts.get("active"), counts.get("planned"), by_city)

    # אם שני המאגרים נכשלו - צא עם קוד שגיאה כדי שה-CI ידע לא לדרוס נתונים תקינים
    if counts["active"] is None and counts["planned"] is None:
        sys.exit(1)


if __name__ == "__main__":
    main()
