#!/usr/bin/env python3
"""
fetch_landcover.py
מוריד פעם אחת (או לעיתים רחוקות - שטח כמעט ולא משתנה) extract מלא של
OpenStreetMap לישראל מ-Geofabrik (שרת קבצים סטטי, בלי rate limiting -
בניגוד ל-Overpass API שהתגלה לא אמין בפועל בנפח הנדרש לעיבוד אלפי
אנטנות), ומסנן ממנו רק פוליגוני תכסית (יער/מים/בינוי) לקובץ קומפקטי
אחד: data/landcover-israel.json.

לאחר מכן, scripts/precompute_coverage.py (ו-js/terrain-coverage.js
בצד הלקוח) עושים בדיקת תכסית **מקומית לגמרי** מול הקובץ הזה, בלי שום
קריאת API נוספת בזמן ריצה. זה פותר את בעיית ה-429/504 החוזרים מ-
Overpass שהתגלתה בפועל בהרצה הלילית.

הרצה (דורש pip install osmium):
  python3 scripts/fetch_landcover.py
פלט:
  data/landcover-israel.json
"""

import json
import sys
from pathlib import Path
from urllib.request import urlretrieve

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
PBF_URL = "https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf"
PBF_PATH = ROOT / "_tmp_israel.osm.pbf"
OUT_PATH = DATA_DIR / "landcover-israel.json"

# תיבה גסה סביב ישראל (כולל יו"ש/עזה, כי ה-extract כולל את כל האזור) -
# משמשת רק לסינון "זבל" גלובלי, לא לחיתוך מדויק
BBOX = (29.3, 34.0, 33.4, 35.9)  # min_lat, min_lon, max_lat, max_lon

# תגיות OSM רלוונטיות -> קטגוריית תכסית (תואם בדיוק את הקטגוריות
# שב-js/terrain-coverage.js ו-scripts/precompute_coverage.py)
RELEVANT_TAGS = {
    ("natural", "wood"): "forest",
    ("landuse", "forest"): "forest",
    ("natural", "water"): "water",
    ("landuse", "reservoir"): "water",
    ("landuse", "residential"): "urban",
    ("landuse", "commercial"): "urban",
    ("landuse", "industrial"): "urban",
}

# דילול פוליגונים ארוכים (יער/עיר גדולים יכולים להיות עם אלפי נקודות) -
# שומר על גודל קובץ סביר להורדה גם בצד הלקוח
MAX_POINTS_PER_WAY = 60


def simplify(points):
    if len(points) <= MAX_POINTS_PER_WAY:
        return points
    step = len(points) / MAX_POINTS_PER_WAY
    return [points[int(i * step)] for i in range(MAX_POINTS_PER_WAY)]


def in_bbox(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


def main():
    try:
        import osmium
    except ImportError:
        print(
            "❌ pyosmium לא מותקן. הריצו קודם: pip install osmium",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"מוריד {PBF_URL} (כ-114MB, פעולה חד-פעמית/נדירה) ...", file=sys.stderr)
    urlretrieve(PBF_URL, PBF_PATH)
    print(f"✓ הורדה הושלמה: {PBF_PATH.stat().st_size / 1e6:.1f}MB", file=sys.stderr)

    features = []
    skipped_relations = 0

    class LandcoverHandler(osmium.SimpleHandler):
        def way(self, w):
            tags = dict(w.tags)
            category = None
            for (k, v), cat in RELEVANT_TAGS.items():
                if tags.get(k) == v:
                    category = cat
                    break
            if not category:
                return
            try:
                coords = [(n.lat, n.lon) for n in w.nodes if n.location.valid()]
            except Exception:
                return
            if len(coords) < 3:
                return
            if not any(in_bbox(lat, lon) for lat, lon in coords):
                return
            features.append({
                "category": category,
                "points": simplify([[round(lat, 5), round(lon, 5)] for lat, lon in coords]),
            })

        def relation(self, r):
            # פוליגונים גדולים (יערות/גופי מים גדולים) מיוצגים לפעמים
            # כ-relation מולטי-פוליגון ולא כ-way בודד. לא מטפלים בזה כאן
            # (מורכב יותר) - זו מגבלה ידועה, ראו README.
            nonlocal skipped_relations
            tags = dict(r.tags)
            for (k, v) in RELEVANT_TAGS:
                if tags.get(k) == v:
                    skipped_relations += 1
                    break

    print("מעבד PBF ומסנן תכסית (עשוי לקחת כמה דקות)...", file=sys.stderr)
    LandcoverHandler().apply_file(str(PBF_PATH), locations=True)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(features, ensure_ascii=False), encoding="utf-8")
    size_mb = OUT_PATH.stat().st_size / 1e6
    print(f"✓ נשמר {OUT_PATH}: {len(features)} פוליגונים, {size_mb:.1f}MB", file=sys.stderr)
    if skipped_relations:
        print(f"  (הערה: {skipped_relations} relations רלוונטיים לא נכללו - ראו README)", file=sys.stderr)

    PBF_PATH.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
