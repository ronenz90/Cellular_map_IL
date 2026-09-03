/**
 * operator-tender.js - "מכרז ספקים": בהינתן נקודה על המפה, מדרג את כל
 * המפעילים לפי איכות קליטה משוערת, לפי חתך דורות רשת.
 *
 * גרסה מודעת-תבליט/תכסית: במקום "מרחק ייחוס" גנרי לכל דור רשת, כל
 * אנטנה מקבלת "מרחק גבול" אמיתי בכיוון המדויק של הנקודה - מבוסס על
 * ענן הכיסוי שלה (תבליט+תכסית+הספק, בדיוק כמו כפתור "כיסוי מדויק"):
 *   1. אם יש קובץ precomputed לאנטנה (data/coverage/<key>.json) - נטען
 *      ומשמש מיידית (אינטרפולציה בין שתי הקרניים הקרובות לכיוון המדויק)
 *   2. אם אין - מחושבת "קרן" חד-כיוונית חיה (תבליט מ-opentopodata +
 *      תכסית מהקובץ המקומי) - הרבה יותר קל מ"ענן" מלא כי זה כיוון אחד
 *      בלבד, וכל האנטנות החסרות מקובצות ל-batch אחד של קריאת גובה
 *   3. רק אם גם זה נכשל (שגיאת רשת) - נופלים ל"רדיוס בסיס" גנרי
 *
 * מכיוון שכל מפעיל מקבל את הציון הגבוה ביותר מבין *כל* האנטנות שלו
 * בטווח - זה בפועל "מחבר" כמה אנטנות קרובות של אותו מפעיל/רשת: אם
 * אנטנה קרובה חסומה ע"י גבעה אבל אנטנה שנייה קצת יותר רחוקה רואה את
 * הנקודה בבירור, המפעיל עדיין ידורג לפי האנטנה השנייה, הטובה יותר.
 *
 * ⚠️ עדיין הערכה יחסית להשוואה בין מפעילים, לא מדידת עוצמת שדה אמיתית.
 */
const OperatorTender = (() => {

  const SEARCH_RADIUS_M = 5000;
  const LIVE_RAY_SAMPLES = 8; // דגימות תבליט לקרן חד-כיוונית חיה (לעומת 10 בענן המלא - קצת יותר גס, אבל מהיר לביצוע על כמה אנטנות בבת אחת)
  const MIN_MEANINGFUL_DIST = 10; // מטרים - מתחת לזה לא בודקים קו-ראייה (מנוון)

  function distMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function pointInPolygon(lat, lon, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [yi, xi] = polygon[i], [yj, xj] = polygon[j];
      const intersect = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * מחשב "מרחק גבול" חי לקבוצת אנטנות שאין להן קובץ precomputed -
   * קו-ראייה חד-כיווני בלבד (לא ענן 360°), עם batch אחד משותף לכל
   * האנטנות החסרות (חוסך הרבה קריאות רשת נפרדות).
   */
  async function fillLiveBoundaries(missing, pointLat, pointLon) {
    const allPoints = [];
    const meta = [];
    for (const c of missing) {
      if (c.distance < MIN_MEANINGFUL_DIST) continue; // הנקודה כמעט על האנטנה - אין מה לבדוק
      meta.push({ candidate: c, startIdx: allPoints.length });
      allPoints.push([c.antenna.lat, c.antenna.lon]);
      for (let s = 1; s <= LIVE_RAY_SAMPLES; s++) {
        const frac = s / LIVE_RAY_SAMPLES;
        allPoints.push([
          c.antenna.lat + (pointLat - c.antenna.lat) * frac,
          c.antenna.lon + (pointLon - c.antenna.lon) * frac,
        ]);
      }
    }
    if (!meta.length) return;

    let elevations;
    try {
      elevations = await TerrainCoverage.fetchElevations(allPoints);
    } catch (e) {
      console.warn('שגיאה בשליפת תבליט למכרז ספקים - נופלים לרדיוס בסיס', e);
      return;
    }

    const landcoverIndex = await TerrainCoverage.loadLandcoverIndex();

    for (const m of meta) {
      const c = m.candidate;
      const antennaGround = elevations[m.startIdx] || 0;
      const antennaTotalH = antennaGround + TerrainCoverage.ANTENNA_HEIGHT;
      const farGround = elevations[m.startIdx + LIVE_RAY_SAMPLES] || 0; // גובה הקרקע בנקודה עצמה (קצה הקרן)
      const receiverAbsHeight = farGround + TerrainCoverage.RECEIVER_HEIGHT;
      let edgeDist = c.distance;
      let blocked = false;

      for (let s = 1; s <= LIVE_RAY_SAMPLES; s++) {
        const gi = m.startIdx + s;
        const sampleDist = c.distance * (s / LIVE_RAY_SAMPLES);
        const ground = elevations[gi] || 0;
        const losH = antennaTotalH + (receiverAbsHeight - antennaTotalH) * (sampleDist / c.distance);
        const curveDrop = (sampleDist * (c.distance - sampleDist)) / (2 * TerrainCoverage.K_FACTOR * TerrainCoverage.R_EARTH);
        if (ground + TerrainCoverage.RECEIVER_HEIGHT > losH - curveDrop) {
          edgeDist = sampleDist;
          blocked = true;
          break;
        }
      }

      let category = 'open';
      if (landcoverIndex) {
        const frac = (edgeDist / 2) / c.distance;
        const midLat = c.antenna.lat + (pointLat - c.antenna.lat) * frac;
        const midLon = c.antenna.lon + (pointLon - c.antenna.lon) * frac;
        const polys = TerrainCoverage.clutterPolygonsFromIndex(midLat, midLon, landcoverIndex);
        for (const p of polys) {
          if (pointInPolygon(midLat, midLon, p.points)) { category = p.category; break; }
        }
      }

      // חשוב: אם לא נמצאה חסימה, "מרחק הגבול" הוא baseRadius (כמו בקרניים
      // המוכנות מראש), *לא* המרחק לנקודה עצמה - אחרת הציון היה תמיד יוצא
      // 50 בדיוק לכל אנטנה לא-חסומה (כי מרחק==גבול), בלי קשר לקרבה האמיתית.
      // שומרים רק את פרטי הקרן הגולמיים כאן; boundaryDist הסופי (עם
      // baseRadius) מחושב בשלב הציון ב-runTender דרך TerrainCoverage.rayEdgeDistance.
      c.liveRay = { blocked, losDistance: edgeDist, clutterCategory: category };
      c.terrainSource = 'live';
    }
  }

  /**
   * מריץ את ה"מכרז" בנקודה נתונה - מודע תבליט+תכסית.
   * @param {number} lat, lon - הנקודה
   * @param {Array} allAntennas
   * @param {(antenna) => number} getBaseRadius - פונקציה שמחזירה את
   *   הרדיוס הבסיסי (כולל התאמת צפיפות+הספק) לאנטנה - מ-app.js
   *   coverageRadiusFor, כדי לא לשכפל את הלוגיקה הזו כאן
   */
  async function runTender(lat, lon, allAntennas, getBaseRadius) {
    const candidates = [];
    for (const a of allAntennas) {
      const d = distMeters(lat, lon, a.lat, a.lon);
      if (d > SEARCH_RADIUS_M) continue;
      candidates.push({
        antenna: a,
        distance: d,
        bearing: TerrainCoverage.initialBearing(a.lat, a.lon, lat, lon),
      });
    }

    if (!candidates.length) {
      return { point: { lat, lon }, results: [], searchRadius: SEARCH_RADIUS_M, terrainStats: { precomputed: 0, live: 0, fallback: 0 } };
    }

    // שלב 1: מנסים למשוך precomputed לכל המועמדים במקביל
    const precomputedList = await Promise.all(candidates.map(c => TerrainCoverage.fetchPrecomputed(c.antenna)));
    const missing = [];
    candidates.forEach((c, i) => {
      if (precomputedList[i] && precomputedList[i].rays) {
        c.rays = precomputedList[i].rays;
        c.terrainSource = 'precomputed';
      } else {
        missing.push(c);
      }
    });

    // שלב 2: לאלה שאין להם - קרן חד-כיוונית חיה, ב-batch אחד
    if (missing.length) {
      await fillLiveBoundaries(missing, lat, lon);
    }

    // שלב 3: חישוב מרחק-גבול וציון סופי לכל מועמד
    for (const c of candidates) {
      const baseRadius = getBaseRadius(c.antenna);
      if (c.rays) {
        c.boundaryDist = TerrainCoverage.boundaryDistanceAtBearing(c.rays, c.bearing, baseRadius);
      } else if (c.liveRay) {
        c.boundaryDist = TerrainCoverage.rayEdgeDistance(c.liveRay, baseRadius);
      } else {
        c.boundaryDist = baseRadius; // fallback גנרי - אין נתוני תבליט זמינים (למשל שגיאת רשת)
        c.terrainSource = 'fallback';
      }
      c.score = 100 / (1 + Math.pow(c.distance / c.boundaryDist, 2));
    }

    // שלב 4: איגוד לפי מפעיל+דור רשת - "מחבר" כמה אנטנות (הציון הטוב ביותר מנצח)
    const byOperator = new Map();
    for (const c of candidates) {
      const op = c.antenna.props.operator || 'לא ידוע';
      const gen = c.antenna.props.generation;
      if (!byOperator.has(op)) {
        byOperator.set(op, { operator: op, bestScore: -1, bestDistance: null, bestGeneration: null, antennaCount: 0, byGeneration: {} });
      }
      const entry = byOperator.get(op);
      entry.antennaCount++;

      if (!entry.byGeneration[gen] || c.score > entry.byGeneration[gen].score) {
        entry.byGeneration[gen] = { score: c.score, distance: c.distance, antenna: c.antenna, terrainSource: c.terrainSource, boundaryDist: c.boundaryDist };
      }
      if (c.score > entry.bestScore) {
        entry.bestScore = c.score;
        entry.bestDistance = c.distance;
        entry.bestGeneration = gen;
        entry.bestAntenna = c.antenna;
        entry.bestTerrainSource = c.terrainSource;
        entry.bestBoundaryDist = c.boundaryDist;
      }
    }

    const results = [...byOperator.values()].sort((a, b) => b.bestScore - a.bestScore);
    const terrainStats = {
      precomputed: candidates.filter(c => c.terrainSource === 'precomputed').length,
      live: candidates.filter(c => c.terrainSource === 'live').length,
      fallback: candidates.filter(c => c.terrainSource === 'fallback').length,
      total: candidates.length,
    };

    return { point: { lat, lon }, results, searchRadius: SEARCH_RADIUS_M, terrainStats };
  }

  return { runTender, distMeters };
})();
