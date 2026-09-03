#!/usr/bin/env python3
"""
precompute_coverage.py
מחשב מראש, ברקע ולאט, "ענני כיסוי" מבוססי תבליט (SRTM) + תכסית
(OpenStreetMap landuse) לכל האנטנות במאגר - כדי שהכפתור "חשב כיסוי
מדויק" בממשק יהיה כמעט מיידי במקום לחכות ל-API בזמן לחיצה.

עובד עם offset נשמר (data/coverage-precompute-state.json): כל הרצה
ממשיכה מאיפה שהריצה הקודמת עצרה (זמן/מכסה), כך שריצה לילית חוזרת
(GitHub Action מתוזמן) "זוחלת" בהדרגה על פני כל האנטנות ומשלימה את
כולן תוך כמה לילות, ואז חוזרת להתחלה לרענון.

פלט: קובץ נפרד לכל אנטנה תחת data/coverage/<key>.json - כך שהממשק
טוען רק את מה שצריך (fetch אחד קטן לאנטנה שנלחצה), ולא קובץ ענק אחד.

הרצה: python3 scripts/precompute_coverage.py
משתני סביבה אופציונליים:
  MAX_RUNTIME_SECONDS - תקציב זמן ריצה בשניות (ברירת מחדל: 5 שעות)
"""

import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
COVERAGE_DIR = DATA_DIR / "coverage"
STATE_PATH = DATA_DIR / "coverage-precompute-state.json"
LANDCOVER_PATH = DATA_DIR / "landcover-israel.json"

# --- פרמטרים (תואמים בדיוק ל-js/terrain-coverage.js, כדי שהתוצאות יהיו זהות) ---
RAYS = 16
SAMPLES_PER_RAY = 10
MAX_DIST = 6000  # מטרים - טווח סריקה קבוע וגס, ראו הערה ב-README על המשמעות
R_EARTH = 6371000
ANTENNA_HEIGHT = 30
RECEIVER_HEIGHT = 1.5
K_FACTOR = 4 / 3

LANDCOVER_CELL_DEG = 0.05  # ~5 ק"מ, גודל תא לאינדקס המרחבי של התכסית

ELEVATION_BATCH_DELAY = 1.1  # שניות בין batches ל-opentopodata

# --- Overpass: משמש רק כ-fallback חד-פעמי אם data/landcover-israel.json
# עוד לא קיים (למשל לפני ההרצה הראשונה של update-landcover.yml). בפועל
# התגלה לא אמין בנפח הנדרש (429/504 חוזרים על אלפי אנטנות) - הפתרון
# העיקרי עכשיו הוא קובץ תכסית מקומי שמעובד מראש (ראו fetch_landcover.py).
CLUTTER_QUERY_DELAY = 2.5
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

MAX_RUNTIME_SECONDS = int(os.environ.get("MAX_RUNTIME_SECONDS", 5 * 3600))
SAFETY_MARGIN_SECONDS = 180  # משאירים 3 דקות מרווח ביטחון לפני סוף התקציב
SAVE_EVERY = 20  # שומרים state כל כמה אנטנות (למקרה של קריסה/timeout)

_started_at = time.time()


def time_left():
    return MAX_RUNTIME_SECONDS - (time.time() - _started_at)


def to_rad(d):
    return d * math.pi / 180


def to_deg(r):
    return r * 180 / math.pi


def destination_point(lat, lon, bearing_deg, distance_m):
    δ = distance_m / R_EARTH
    θ = to_rad(bearing_deg)
    φ1, λ1 = to_rad(lat), to_rad(lon)
    φ2 = math.asin(math.sin(φ1) * math.cos(δ) + math.cos(φ1) * math.sin(δ) * math.cos(θ))
    λ2 = λ1 + math.atan2(math.sin(θ) * math.sin(δ) * math.cos(φ1), math.cos(δ) - math.sin(φ1) * math.sin(φ2))
    return to_deg(φ2), to_deg(λ2)


def http_get_json(url, retries=3, timeout=20):
    last_err = None
    for _ in range(retries):
        try:
            req = Request(url, headers={"User-Agent": "antenna-map-precompute/1.0"})
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (URLError, HTTPError) as e:
            last_err = e
            time.sleep(2)
    print(f"    שגיאה בגישה ל-{url[:80]}...: {last_err}", file=sys.stderr)
    return None


def fetch_elevations_batch(points):
    """points: רשימת (lat, lon). מחזיר רשימת גבהים באותו סדר."""
    elevations = [0] * len(points)
    chunk = 100
    for i in range(0, len(points), chunk):
        part = points[i:i + chunk]
        locstr = "|".join(f"{lat},{lon}" for lat, lon in part)
        data = http_get_json(f"https://api.opentopodata.org/v1/srtm30m?locations={locstr}")
        if data and data.get("results"):
            for j, r in enumerate(data["results"]):
                elevations[i + j] = r.get("elevation") or 0
        time.sleep(ELEVATION_BATCH_DELAY)
    return elevations


def fetch_clutter_polygons(lat, lon, radius_m):
    query = f"""[out:json][timeout:25];(
      way["natural"="wood"](around:{radius_m},{lat},{lon});
      way["landuse"="forest"](around:{radius_m},{lat},{lon});
      way["natural"="water"](around:{radius_m},{lat},{lon});
      way["landuse"="reservoir"](around:{radius_m},{lat},{lon});
      way["landuse"="residential"](around:{radius_m},{lat},{lon});
      way["landuse"="commercial"](around:{radius_m},{lat},{lon});
      way["landuse"="industrial"](around:{radius_m},{lat},{lon});
    );out geom;"""

    def parse(data):
        polys = []
        for el in data.get("elements", []):
            geom = el.get("geometry")
            if not geom or len(geom) < 3:
                continue
            tags = el.get("tags", {})
            if tags.get("natural") == "wood" or tags.get("landuse") == "forest":
                cat = "forest"
            elif tags.get("natural") == "water" or tags.get("landuse") == "reservoir":
                cat = "water"
            elif tags.get("landuse") in ("residential", "commercial", "industrial"):
                cat = "urban"
            else:
                cat = "open"
            polys.append({"category": cat, "points": [[g["lat"], g["lon"]] for g in geom]})
        return polys

    # מנסים כל שרת, עם עד 2 ניסיונות לכל שרת (backoff ארוך יותר על 429)
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(2):
            try:
                req = Request(
                    endpoint,
                    data=("data=" + query).encode("utf-8"),
                    headers={"User-Agent": "antenna-map-precompute/1.0"},
                )
                with urlopen(req, timeout=35) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                time.sleep(CLUTTER_QUERY_DELAY)
                return parse(data)
            except HTTPError as e:
                wait = 10 if e.code == 429 else 5
                print(f"    Overpass ({endpoint.split('/')[2]}) HTTP {e.code}, ממתין {wait}s", file=sys.stderr)
                time.sleep(wait)
            except Exception as e:
                print(f"    Overpass ({endpoint.split('/')[2]}) שגיאה: {e}", file=sys.stderr)
                time.sleep(3)

    print("    כל שרתי Overpass נכשלו הפעם - ממשיכים בלי תכסית לאנטנה הזו (רק תבליט)", file=sys.stderr)
    time.sleep(CLUTTER_QUERY_DELAY)
    return []


def point_in_polygon(lat, lon, polygon):
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        yi, xi = polygon[i]
        yj, xj = polygon[j]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def clutter_at(lat, lon, polygons):
    for p in polygons:
        if point_in_polygon(lat, lon, p["points"]):
            return p["category"]
    return "open"


# --- שכבת "תכסית מקומית" (data/landcover-israel.json, נבנה ע"י
# scripts/fetch_landcover.py) - זו הדרך המועדפת עכשיו, במקום קריאות
# Overpass חיות שהתגלו לא אמינות בנפח הנדרש. ---

def load_landcover_bundle():
    if not LANDCOVER_PATH.exists():
        return None
    try:
        return json.loads(LANDCOVER_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def build_landcover_index(bundle):
    """אינדקס grid מרחבי: לכל תא, רשימת הפוליגונים שחופפים אליו (לפי
    bounding box). מאפשר לשלוף רק פוליגונים רלוונטיים לכל אנטנה במקום
    לבדוק את כל אלפי הפוליגונים בארץ עבור כל נקודה."""
    grid = {}
    for poly in bundle:
        lats = [p[0] for p in poly["points"]]
        lons = [p[1] for p in poly["points"]]
        min_cy, max_cy = int(min(lats) / LANDCOVER_CELL_DEG), int(max(lats) / LANDCOVER_CELL_DEG)
        min_cx, max_cx = int(min(lons) / LANDCOVER_CELL_DEG), int(max(lons) / LANDCOVER_CELL_DEG)
        for cy in range(min_cy, max_cy + 1):
            for cx in range(min_cx, max_cx + 1):
                grid.setdefault((cy, cx), []).append(poly)
    return grid


def clutter_polygons_from_index(lat, lon, index):
    cy, cx = int(lat / LANDCOVER_CELL_DEG), int(lon / LANDCOVER_CELL_DEG)
    seen_ids = set()
    result = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for poly in index.get((cy + dy, cx + dx), []):
                pid = id(poly)
                if pid in seen_ids:
                    continue
                seen_ids.add(pid)
                result.append(poly)
    return result


def process_antenna(lat, lon, landcover_index):
    """מחשב עבור אנטנה אחת: לכל אחת מ-RAYS כיוונים, מרחק חסימת קו-ראייה
    (מבוסס תבליט) וקטגוריית תכסית. פורמט התוצאה תואם בדיוק את מה ש-
    js/terrain-coverage.js מצפה לו (ראו usePrecomputed בקובץ ה-JS).

    landcover_index=None -> אין קובץ תכסית מקומי עדיין (למשל לפני
    ההרצה הראשונה של update-landcover.yml) -> נופלים חזרה ל-Overpass
    חי כ-fallback (איטי יותר, פחות אמין - ראו הערה למעלה)."""
    ray_points = []
    ray_start_idx = []
    for r in range(RAYS):
        bearing = (360 / RAYS) * r
        ray_start_idx.append(len(ray_points))
        for s in range(1, SAMPLES_PER_RAY + 1):
            dist = (MAX_DIST / SAMPLES_PER_RAY) * s
            plat, plon = destination_point(lat, lon, bearing, dist)
            ray_points.append((plat, plon, dist))

    all_points = [(lat, lon)] + [(p[0], p[1]) for p in ray_points]

    if landcover_index is not None:
        # מקומי לגמרי - מיידי, בלי שום קריאת רשת
        elevations = fetch_elevations_batch(all_points)
        clutter_polys = clutter_polygons_from_index(lat, lon, landcover_index)
    else:
        # fallback: אין עדיין קובץ תכסית מקומי - קריאה חיה ל-Overpass
        # (במקביל לתבליט, כדי לא להכפיל את זמן ההמתנה)
        with ThreadPoolExecutor(max_workers=2) as ex:
            fut_elev = ex.submit(fetch_elevations_batch, all_points)
            fut_clutter = ex.submit(fetch_clutter_polygons, lat, lon, MAX_DIST)
            elevations = fut_elev.result()
            clutter_polys = fut_clutter.result()

    antenna_ground = elevations[0] or 0
    antenna_total_h = antenna_ground + ANTENNA_HEIGHT

    rays_out = []
    for r in range(RAYS):
        start = ray_start_idx[r]
        edge_dist = MAX_DIST
        blocked = False
        for s in range(SAMPLES_PER_RAY):
            gi = start + s + 1  # +1 כי אינדקס 0 הוא נקודת האנטנה עצמה
            dist = ray_points[start + s][2]
            ground = elevations[gi] or 0
            los_h = antenna_total_h + (RECEIVER_HEIGHT - antenna_total_h) * (dist / MAX_DIST)
            curve_drop = (dist * (MAX_DIST - dist)) / (2 * K_FACTOR * R_EARTH)
            eff_los = los_h - curve_drop
            if ground + RECEIVER_HEIGHT > eff_los:
                edge_dist = dist
                blocked = True
                break

        bearing = (360 / RAYS) * r
        mid_lat, mid_lon = destination_point(lat, lon, bearing, edge_dist / 2)
        category = clutter_at(mid_lat, mid_lon, clutter_polys)
        rays_out.append({
            "bearing": bearing,
            "losDistance": round(edge_dist),
            "clutterCategory": category,
            "blocked": blocked,
        })

    return {
        "rays": rays_out,
        "groundElevation": round(antenna_ground),
        "usedClutter": len(clutter_polys) > 0,
        "maxDist": MAX_DIST,
        "computedAt": datetime.now(timezone.utc).isoformat(),
    }


def antenna_key(props, lat, lon):
    aid = props.get("ID") or props.get("id") or props.get("_id")
    if aid:
        return f"id-{aid}"
    return f"ll-{round(lat, 5)}_{round(lon, 5)}"


def load_state():
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"offset": 0, "cycles_completed": 0, "total_processed_ever": 0}


def save_state(state):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    active_path = DATA_DIR / "antennas-active.geojson"
    if not active_path.exists():
        print("אין קובץ antennas-active.geojson - עצירה", file=sys.stderr)
        sys.exit(1)

    geo = json.loads(active_path.read_text(encoding="utf-8"))
    antennas = []
    for f in geo.get("features", []):
        lon, lat = f["geometry"]["coordinates"]
        antennas.append({"lat": lat, "lon": lon, "props": f.get("properties", {})})

    n = len(antennas)
    if n == 0:
        print("אין אנטנות לעבד", file=sys.stderr)
        return

    landcover_bundle = load_landcover_bundle()
    if landcover_bundle is not None:
        print(f"✓ נטען קובץ תכסית מקומי: {len(landcover_bundle)} פוליגונים - בדיקת תכסית תהיה מקומית ומיידית", file=sys.stderr)
        landcover_index = build_landcover_index(landcover_bundle)
    else:
        print("⚠️ אין עדיין data/landcover-israel.json (הריצו את update-landcover.yml פעם אחת) - "
              "נופלים זמנית ל-Overpass חי (איטי, עשוי להיכשל בחלק מהאנטנות)", file=sys.stderr)
        landcover_index = None

    COVERAGE_DIR.mkdir(parents=True, exist_ok=True)
    state = load_state()
    offset = state.get("offset", 0) % n
    total_processed_ever = state.get("total_processed_ever", 0)
    processed = 0
    i = offset

    print(f"מתחיל precompute מ-offset {offset} מתוך {n} אנטנות. "
          f"תקציב זמן: {MAX_RUNTIME_SECONDS}s (~{MAX_RUNTIME_SECONDS/3600:.1f} שעות)", file=sys.stderr)

    while time_left() > SAFETY_MARGIN_SECONDS:
        antenna = antennas[i % n]
        key = antenna_key(antenna["props"], antenna["lat"], antenna["lon"])
        out_path = COVERAGE_DIR / f"{key}.json"
        try:
            result = process_antenna(antenna["lat"], antenna["lon"], landcover_index)
            out_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        except Exception as e:
            print(f"  שגיאה באנטנה {key}: {e}", file=sys.stderr)

        processed += 1
        i += 1

        if processed % SAVE_EVERY == 0:
            new_offset = i % n
            # ספירת סבבים מבוססת על סה"כ מצטבר שעובד אי-פעם (חלוקה שלמה
            # ב-n), לא על השוואת offset שהייתה שבורה (מתעדכנת פעם אחת
            # בלבד לכל מעבר סיבוב, לא בכל checkpoint אחרי המעבר)
            cycles = (total_processed_ever + processed) // n
            state.update({
                "offset": new_offset,
                "last_run": datetime.now(timezone.utc).isoformat(),
                "processed_last_run": processed,
                "total_antennas": n,
                "total_processed_ever": total_processed_ever + processed,
                "cycles_completed": cycles,
            })
            save_state(state)
            elapsed_min = (time.time() - _started_at) / 60
            print(f"  התקדמות: {processed} עובדו ({elapsed_min:.1f} דק'), "
                  f"offset נוכחי {new_offset}/{n}", file=sys.stderr)

        if processed >= n:
            print("✓ הושלם מעבר מלא על כל האנטנות במהלך ריצה זו!", file=sys.stderr)
            break

    final_offset = i % n
    cycles = (total_processed_ever + processed) // n
    state.update({
        "offset": final_offset,
        "last_run": datetime.now(timezone.utc).isoformat(),
        "processed_last_run": processed,
        "total_antennas": n,
        "total_processed_ever": total_processed_ever + processed,
        "cycles_completed": cycles,
    })
    save_state(state)
    print(f"סיום ריצה: עובדו {processed} אנטנות ({processed/n*100:.1f}% מסבב אחד). "
          f"offset הבא: {final_offset}/{n}. סבבים שהושלמו (מצטבר): {cycles}", file=sys.stderr)


if __name__ == "__main__":
    main()
