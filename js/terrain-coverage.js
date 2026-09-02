/**
 * terrain-coverage.js - "כיסוי מדויק יותר" מבוסס תבליט (SRTM 30m), קו-ראייה,
 * ותכסית (landuse/landcover אמיתי מ-OpenStreetMap דרך Overpass API)
 *
 * חשוב להבין את המגבלות: המאגר הממשלתי החינמי לא כולל גובה תורן אמיתי,
 * אזימוט/כיוון אנטנה או דגם. הוא כן כולל (חלקית) הספק שידור תיאורטי
 * מרבי (µW/סמ"ר) מתוך היתר הקרינה - זה כבר משמש להתאמת הרדיוס הבסיסי
 * (ראו app.js: powerAdjustedRadius). המודל הזה מוסיף שתי שכבות נתונים
 * אמיתיות נוספות על גבי זה:
 *   1. תבליט (טופוגרפיה) - קו-ראייה אמיתי מול תבליט השטח (SRTM)
 *   2. תכסית (יער/מים/בינוי) - פוליגוני landuse/natural אמיתיים מ-OSM
 *      דרך Overpass API, שגם הם מקצרים/מאריכים את הכיסוי בהתאם
 * זו עדיין הערכה הנדסית, לא מדידת שדה אלקטרומגנטי אמיתית (חסר: גובה
 * תורן מדויק, אזימוט, דגם אנטנה, החזרות רב-נתיביות).
 *
 * מקורות נתונים חיצוניים (שני API-ים חינמיים, ללא מפתח):
 *   - opentopodata.org (dataset=srtm30m) - גובה תבליט
 *   - overpass-api.de - תכסית (landuse/natural) מ-OpenStreetMap
 * שני אלה נקראים **על פי דרישה בלבד** (לחיצה על כפתור לאנטנה ספציפית),
 * לעולם לא רצים אוטומטית על כל האנטנות בבת אחת.
 */
const TerrainCoverage = (() => {

  const R_EARTH = 6371000;
  const RAYS = 16;              // כיוונים לבדיקה (כל 22.5 מעלות)
  const SAMPLES_PER_RAY = 10;   // נקודות דגימת גובה לאורך כל קרן
  const RECEIVER_HEIGHT = 1.5;  // גובה מקלט טיפוסי (מטרים)
  const ANTENNA_HEIGHT = 30;    // הנחת גובה תורן טיפוסי בישראל (מטרים) - לא ידוע בפועל
  const K_FACTOR = 4 / 3;       // מקדם עקמומיות כדור הארץ הרדיו-סטנדרטי

  // מקדמי הנחתה נוספת לפי סוג תכסית (heuristic - לא מדידת דעיכה בפועל)
  const CLUTTER_FACTOR = {
    forest: 0.72,     // יער/שטח מיוער - הנחתה משמעותית
    urban: 0.80,      // בינוי צפוף (residential/commercial/industrial)
    water: 1.05,      // מים פתוחים - כמעט ללא הנחתה, מעט הרחבה
    open: 1.0,        // שדה פתוח/לא מסווג - ללא שינוי
  };

  const cache = new Map(); // antennaId -> polygon latlngs (session cache)

  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  function destinationPoint(lat, lon, bearingDeg, distanceM) {
    const δ = distanceM / R_EARTH;
    const θ = toRad(bearingDeg);
    const φ1 = toRad(lat), λ1 = toRad(lon);
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    return [toDeg(φ2), toDeg(λ2)];
  }

  /* ============ שכבת "מוכן מראש" - קבצים שנוצרו ע"י scripts/precompute_coverage.py ============
   * רץ כל לילה (GitHub Action) ומחשב בהדרגה (offset-based) תבליט+תכסית
   * לכל האנטנות, שומר כקובץ נפרד לכל אנטנה תחת data/coverage/<key>.json.
   * אם קיים קובץ כזה לאנטנה שנלחצה - נטען מיידית (ללא קריאה ל-API
   * בזמן אמת בכלל!). אם עוד לא חושב (עוד לא הגיע התור שלו במעבר הלילי) -
   * נופלים חזרה לחישוב חי כרגיל.
   */
  const PRECOMPUTE_MAX_DIST = 6000; // חייב להיות זהה ל-MAX_DIST ב-precompute_coverage.py

  function antennaKey(antenna) {
    const id = antenna.props && antenna.props.id;
    if (id) return `id-${id}`;
    return `ll-${antenna.lat.toFixed(5)}_${antenna.lon.toFixed(5)}`;
  }

  async function fetchPrecomputed(antenna) {
    const key = antennaKey(antenna);
    try {
      const res = await fetch(`data/coverage/${key}.json`, { cache: 'no-cache' });
      if (!res.ok) return null; // 404 = עדיין לא חושב מראש, זה תקין וצפוי
      return await res.json();
    } catch {
      return null;
    }
  }

  /** בונה את המצולע הסופי משילוב: rays מוכנים מראש (תבליט+תכסית) + baseRadius החי הנוכחי */
  function buildPolygonFromRays(antenna, rays, baseRadius) {
    const polygon = [];
    for (const ray of rays) {
      let edgeDist = ray.blocked ? ray.losDistance : Math.min(baseRadius, PRECOMPUTE_MAX_DIST);
      edgeDist = edgeDist * (CLUTTER_FACTOR[ray.clutterCategory] || 1.0);
      const [lat, lon] = destinationPoint(antenna.lat, antenna.lon, ray.bearing, edgeDist);
      polygon.push([lat, lon]);
    }
    return polygon;
  }

  async function fetchElevations(points) {
    // opentopodata: עד 100 נקודות לבקשה, GET עם locations=lat,lon|lat,lon...
    const elevations = new Array(points.length).fill(null);
    const chunkSize = 100;
    for (let i = 0; i < points.length; i += chunkSize) {
      const chunk = points.slice(i, i + chunkSize);
      const locStr = chunk.map(p => `${p[0]},${p[1]}`).join('|');
      const url = `https://api.opentopodata.org/v1/srtm30m?locations=${locStr}`;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('opentopodata HTTP ' + res.status);
        const data = await res.json();
        (data.results || []).forEach((r, idx) => {
          elevations[i + idx] = (r.elevation === null || r.elevation === undefined) ? 0 : r.elevation;
        });
      } catch (e) {
        console.warn('שגיאה בשליפת נתוני גובה', e);
        // ממלאים באפס (ים) כדי לא לקרוס - התוצאה תהיה פחות מדויקת לקטע הזה
        for (let j = i; j < Math.min(i + chunkSize, points.length); j++) elevations[j] = 0;
      }
      // כיבוד הגבלת קצב עדינה בין batches
      if (i + chunkSize < points.length) await new Promise(r => setTimeout(r, 300));
    }
    return elevations;
  }

  /* ===================== תכסית (landuse) דרך Overpass ===================== */

  async function fetchClutterPolygons(lat, lon, radiusM) {
    const query = `[out:json][timeout:20];(
      way["natural"="wood"](around:${radiusM},${lat},${lon});
      way["landuse"="forest"](around:${radiusM},${lat},${lon});
      way["natural"="water"](around:${radiusM},${lat},${lon});
      way["landuse"="reservoir"](around:${radiusM},${lat},${lon});
      way["landuse"="residential"](around:${radiusM},${lat},${lon});
      way["landuse"="commercial"](around:${radiusM},${lat},${lon});
      way["landuse"="industrial"](around:${radiusM},${lat},${lon});
    );out geom;`;
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error('Overpass HTTP ' + res.status);
      const data = await res.json();
      return (data.elements || [])
        .filter(el => el.geometry && el.geometry.length > 2)
        .map(el => {
          let category = 'open';
          const tags = el.tags || {};
          if (tags.natural === 'wood' || tags.landuse === 'forest') category = 'forest';
          else if (tags.natural === 'water' || tags.landuse === 'reservoir') category = 'water';
          else if (['residential', 'commercial', 'industrial'].includes(tags.landuse)) category = 'urban';
          return { category, points: el.geometry.map(g => [g.lat, g.lon]) };
        });
    } catch (e) {
      console.warn('שגיאה בשליפת נתוני תכסית (Overpass)', e);
      return []; // כישלון שקט - נמשיך בלי תכסית, עדיין יש תבליט
    }
  }

  // Ray-casting point-in-polygon סטנדרטי
  function pointInPolygon(lat, lon, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [yi, xi] = polygon[i], [yj, xj] = polygon[j];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function clutterAt(lat, lon, polygons) {
    for (const poly of polygons) {
      if (pointInPolygon(lat, lon, poly.points)) return poly.category;
    }
    return 'open';
  }

  /**
   * מחשב "ענן כיסוי" מבוסס תבליט + תכסית לאנטנה בודדת.
   * @param {object} antenna - { lat, lon, props }
   * @param {number} baseRadius - הרדיוס הבסיסי (מטרים, כבר מותאם להספק
   *   שידור אמיתי אם קיים - ראו app.js powerAdjustedRadius), משמש כתקרה עליונה
   * @returns {Promise<{polygon: Array<[lat,lon]>, usedClutter: boolean}>}
   */
  async function computeCoverage(antenna, baseRadius) {
    const cacheKey = `${antenna.props.id || ''}_${antenna.lat}_${antenna.lon}_${baseRadius}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    // שלב 1: יש כבר חישוב מוכן מראש לאנטנה הזו? (מהריצה הלילית) - מיידי, בלי API
    const precomputed = await fetchPrecomputed(antenna);
    if (precomputed && precomputed.rays && precomputed.rays.length) {
      const polygon = buildPolygonFromRays(antenna, precomputed.rays, baseRadius);
      const result = { polygon, usedClutter: precomputed.usedClutter, source: 'precomputed', computedAt: precomputed.computedAt };
      cache.set(cacheKey, result);
      return result;
    }

    // שלב 2: נפילה לחישוב חי (כמו קודם) - עדיין לא הגיע התור של האנטנה
    // הזו במעבר הלילי, או שהוא נכשל
    const maxDist = baseRadius * 2.2; // בודקים קצת מעבר לרדיוס הבסיסי, למקרה שאין חסימה
    const rayPoints = []; // כל נקודות הדגימה של כל הקרניים, ברצף
    const raySampleIndices = []; // לכל קרן: אינדקס ההתחלה שלה במערך rayPoints

    for (let r = 0; r < RAYS; r++) {
      const bearing = (360 / RAYS) * r;
      raySampleIndices.push(rayPoints.length);
      for (let s = 1; s <= SAMPLES_PER_RAY; s++) {
        const dist = (maxDist / SAMPLES_PER_RAY) * s;
        const [lat, lon] = destinationPoint(antenna.lat, antenna.lon, bearing, dist);
        rayPoints.push([lat, lon, dist]);
      }
    }

    // גובה האנטנה עצמה - דוגמים את התבליט בנקודת המוצא + מוסיפים גובה תורן משוער
    const allSamplePoints = [[antenna.lat, antenna.lon], ...rayPoints.map(p => [p[0], p[1]])];

    // תבליט ותכסית נשלפים במקביל (שני מקורות שונים, לא תלויים זה בזה)
    const [elevations, clutterPolygons] = await Promise.all([
      fetchElevations(allSamplePoints),
      fetchClutterPolygons(antenna.lat, antenna.lon, Math.round(maxDist)),
    ]);

    const antennaGroundElev = elevations[0] || 0;
    const antennaTotalHeight = antennaGroundElev + ANTENNA_HEIGHT;

    const polygon = [];
    for (let r = 0; r < RAYS; r++) {
      const startIdx = raySampleIndices[r];
      let edgeDist = maxDist;
      let blocked = false;

      for (let s = 0; s < SAMPLES_PER_RAY; s++) {
        const globalIdx = startIdx + s + 1; // +1 כי אינדקס 0 הוא נקודת האנטנה עצמה
        const [, , dist] = rayPoints[startIdx + s];
        const groundElev = elevations[globalIdx] || 0;

        // קו-ראייה: גובה הקו הישר מהאנטנה למקלט בנקודה הזו
        const losHeight = antennaTotalHeight + (RECEIVER_HEIGHT - antennaTotalHeight) * (dist / maxDist);
        // תיקון עקמומיות כדור הארץ (מקטין את קו הראייה הזמין ככל שמתרחקים)
        const earthCurveDrop = (dist * (maxDist - dist)) / (2 * K_FACTOR * R_EARTH);
        const effectiveLos = losHeight - earthCurveDrop;

        if (groundElev + RECEIVER_HEIGHT > effectiveLos) {
          edgeDist = dist;
          blocked = true;
          break;
        }
      }
      if (!blocked) edgeDist = Math.min(baseRadius, maxDist); // ללא חסימה - נשארים ברדיוס הבסיסי (לא "ממציאים" טווח נוסף)

      // התאמת תכסית: בודקים את קטגוריית הקרקע בנקודת האמצע של הקרן עד
      // כה (proxy סביר לסוג הסביבה הדומיננטי בכיוון הזה) ומכווצים/
      // מרחיבים את הרדיוס בהתאם
      const bearing = (360 / RAYS) * r;
      const [midLat, midLon] = destinationPoint(antenna.lat, antenna.lon, bearing, edgeDist / 2);
      const category = clutterAt(midLat, midLon, clutterPolygons);
      edgeDist = edgeDist * (CLUTTER_FACTOR[category] || 1.0);

      const [lat, lon] = destinationPoint(antenna.lat, antenna.lon, bearing, edgeDist);
      polygon.push([lat, lon]);
    }

    const result = { polygon, usedClutter: clutterPolygons.length > 0, source: 'live' };
    cache.set(cacheKey, result);
    return result;
  }

  return { computeCoverage };
})();
