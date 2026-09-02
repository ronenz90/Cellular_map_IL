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
    for row in records:
        lon = find_key(row, LON_KEYS)
        lat = find_key(row, LAT_KEYS)
        if lon is None or lat is None:
            skipped += 1
            continue
        try:
            lon_f, lat_f = float(lon), float(lat)
        except (TypeError, ValueError):
            skipped += 1
            continue
        # ולידציה גסה שהקואורדינטה בתחום ישראל
        if not (33.5 < lon_f < 36.0 and 29.0 < lat_f < 33.5):
            skipped += 1
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon_f, lat_f]},
            "properties": row,
        })
    print(f"  -> {len(features)} רשומות תקינות, {skipped} דולגו (חסר מיקום)", file=sys.stderr)
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
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / out_filename
    out_path.write_text(json.dumps(geojson, ensure_ascii=False), encoding="utf-8")
    print(f"  נשמר: {out_path} ({len(geojson['features'])} מוקדים)", file=sys.stderr)
    return len(geojson["features"])


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
