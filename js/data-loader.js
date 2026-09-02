/**
 * data-loader.js
 * אחראי על:
 *  1. טעינת קובצי הנתונים המעודכנים (data/antennas-active.geojson, data/antennas-planned.geojson)
 *     שמתעדכנים אוטומטית ע"י GitHub Action (ראו scripts/fetch_data.py)
 *  2. נירמול שמות שדות (המקור העברי משתנה מעט בין גרסאות הקובץ הממשלתי)
 *  3. חיפוש כתובות (גיאוקודינג) מוגבל לתחומי ישראל דרך Nominatim (OpenStreetMap)
 */

const DataLoader = (() => {

  // מיפוי גמיש של שמות עמודות אפשריים -> שדה מנורמל.
  // עודכן לפי שמות השדות האמיתיים שהתגלו בהרצה בפועל מול data.gov.il
  // (ראו scripts/fetch_data.py - הלוג מדפיס את השדות בכל הרצה).
  const FIELD_MAP = {
    operator: ['חברה', 'מפעיל', 'שם החברה', 'operator', 'company'],
    generation: ['טכנולוגיית שידור', 'דור', 'דור_רשת', 'טכנולוגיה', 'generation', 'tech'],
    city: ['עיר', 'ישוב', 'רשות מקומית', 'city', 'locality'],
    street: ['כתובת האתר', 'כתובת + תאור', 'רחוב', 'street'],
    houseNumber: ['מספר', 'מספר_בית', 'house_number'],
    id: ['ID', "מס' אתר", 'מספר האתר', 'מזהה', 'מספר_מוקד', 'id', 'objectid'],
    status: ["סוג  היתר", 'סוג היתר', 'סטטוס', 'status'],
    siteType: ['סוג אתר', 'סוג המוקד'],
    // נתוני הספק אמיתיים (חלקיים) מתוך היתר הקרינה - זה מה שמאפשר
    // כיסוי מדויק יותר מהנחה גורפת לפי דור רשת בלבד
    maxPowerDensity: ['עוצמה מרבית תיאורטית בµW לסמר', 'עוצמה מרבית תיאורטית בµW לסמ"ר', 'עוצמה מרבית תיאורטית'],
    healthPercent: ['תוצאה מירבית ב% ביחס לסף הבריאות'],
    permitDate: ['תאריך היתר הפעלה', 'תאריך היתר הקמה'],
    lastTest: ['בדיקה תקופתית אחרונה'],
    jurisdiction: ['תחום שיפוט'],
  };

  function normalizeProps(rawProps) {
    const out = { raw: rawProps };
    for (const [key, aliases] of Object.entries(FIELD_MAP)) {
      for (const alias of aliases) {
        if (rawProps[alias] !== undefined && rawProps[alias] !== null && rawProps[alias] !== '') {
          out[key] = rawProps[alias];
          break;
        }
      }
    }
    // נרמול דור הרשת לערכים אחידים: 2G/3G/4G/5G
    // הפורמט האמיתי שהתגלה בפועל (תודה לאבחון בממשק!): "דור 4",
    // "דור 3 4", "דור 3 4 5" וכו' - אתר יכול לשדר כמה דורות בו-זמנית,
    // מופרדים ברווח, בלי אות "G". בוחרים את הדור הגבוה ביותר שמופיע
    // כ"נציג" האתר (הכי רלוונטי לסינון), ושומרים גם רשימה מלאה.
    if (out.generation) {
      const raw = String(out.generation);
      const g = raw.toUpperCase();
      let matched = null;
      if (/5G|NR\b|N78|N41|N77/.test(g)) matched = '5G';
      else if (/4G|LTE/.test(g)) matched = '4G';
      else if (/3G|UMTS|WCDMA|HSPA/.test(g)) matched = '3G';
      else if (/2G|GSM|EDGE|GPRS/.test(g)) matched = '2G';
      else if (raw.includes('חמיש')) matched = '5G';
      else if (raw.includes('רביע')) matched = '4G';
      else if (raw.includes('שליש')) matched = '3G';
      else if (raw.includes('שני')) matched = '2G';
      else {
        // פורמט "דור X" / "דור X Y Z" - חילוץ כל הספרות 2-5 שמופיעות
        // ובחירת הגבוהה ביותר כדור המייצג
        const digits = raw.match(/[2-5]/g);
        if (digits && digits.length) {
          const uniqueSorted = [...new Set(digits.map(Number))].sort((a, b) => a - b);
          matched = `${uniqueSorted[uniqueSorted.length - 1]}G`;
          out.allGenerations = uniqueSorted.map(d => `${d}G`);
        }
      }
      out.generation = matched || 'לא ידוע';
    } else {
      out.generation = 'לא ידוע';
    }
    if (!out.operator) out.operator = 'לא ידוע';

    // נרמול נתוני הספק למספר (יש מקרים בהם השדה מגיע כמחרוזת עם
    // תווים לא-מספריים, מקף למקום ריק וכו')
    if (out.maxPowerDensity !== undefined) {
      const cleaned = String(out.maxPowerDensity).replace(/[^\d.\-]/g, '');
      const num = parseFloat(cleaned);
      out.maxPowerDensity = isNaN(num) ? undefined : num;
    }
    if (out.healthPercent !== undefined) {
      const cleaned = String(out.healthPercent).replace(/[^\d.\-]/g, '');
      const num = parseFloat(cleaned);
      out.healthPercent = isNaN(num) ? undefined : num;
    }
    return out;
  }

  async function fetchGeoJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`שגיאה בטעינת ${url}: ${res.status}`);
    return res.json();
  }

  /**
   * טוען את שכבות האנטנות (פעילות + בהקמה בנפרד) ומחזיר מבנה מנורמל.
   */
  async function loadAntennas() {
    const [active, planned] = await Promise.allSettled([
      fetchGeoJSON('data/antennas-active.geojson'),
      fetchGeoJSON('data/antennas-planned.geojson'),
    ]);

    const process = (result, statusLabel) => {
      if (result.status !== 'fulfilled') return [];
      const fc = result.value;
      return (fc.features || []).map((f) => {
        const props = normalizeProps(f.properties || {});
        props.status = props.status || statusLabel;
        const [lon, lat] = f.geometry.coordinates;
        return { lat, lon, props };
      });
    };

    const activeFeatures = process(active, 'פעיל');
    const plannedFeatures = process(planned, 'בהקמה');

    return {
      active: activeFeatures,
      planned: plannedFeatures,
      meta: {
        activeCount: activeFeatures.length,
        plannedCount: plannedFeatures.length,
        fetchedAt: new Date().toISOString(),
      },
    };
  }

  async function loadMeta() {
    try {
      const res = await fetch('data/meta.json', { cache: 'no-cache' });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  // --- חיפוש כתובות בישראל דרך Nominatim (OSM) ---
  // גבולות גס של ישראל (כולל יהודה ושומרון) לצורך הטיית תוצאות החיפוש
  const ISRAEL_VIEWBOX = '34.0,29.3,35.9,33.4'; // minLon,minLat,maxLon,maxLat

  function buildCleanLabel(r) {
    const addr = r.address || {};
    const parts = [];
    const road = addr.road || addr.pedestrian || addr.footway;
    const houseNum = addr.house_number;
    if (road) parts.push(houseNum ? `${road} ${houseNum}` : road);
    const place = addr.city || addr.town || addr.village || addr.municipality || addr.county;
    if (place && place !== parts[0]) parts.push(place);
    if (!parts.length) return r.display_name;
    return parts.join(', ');
  }

  async function runNominatim(query, { restrictToIL }) {
    let url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&viewbox=${ISRAEL_VIEWBOX}&bounded=1&accept-language=he&q=${encodeURIComponent(query)}`;
    if (restrictToIL) url += '&countrycodes=il';
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) return [];
      return await res.json();
    } catch (e) {
      console.warn('שגיאת חיפוש כתובת', e);
      return [];
    }
  }

  async function searchAddress(query) {
    if (!query || query.trim().length < 2) return [];

    // ניסיון ראשון: מוגבל לישראל (countrycodes=il). ישובים מעבר לקו הירוק
    // (למשל גבעת זאב, מעלה אדומים) לפעמים לא מתויגים כ-"il" ב-OSM,
    // ולכן אם אין תוצאות טובות מנסים שוב בלי ההגבלה הזו (עדיין בתוך
    // גבולות ה-viewbox של האזור כולו).
    let results = await runNominatim(query, { restrictToIL: true });
    if (results.length === 0) {
      results = await runNominatim(query, { restrictToIL: false });
    }

    // הסרת כפילויות (אותו place_id) ובניית תווית קריאה במקום display_name הארוך
    const seen = new Set();
    const cleaned = [];
    for (const r of results) {
      if (seen.has(r.place_id)) continue;
      seen.add(r.place_id);
      cleaned.push({
        label: buildCleanLabel(r),
        fullLabel: r.display_name,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        boundingbox: r.boundingbox,
      });
    }
    return cleaned;
  }

  return { loadAntennas, loadMeta, searchAddress, normalizeProps };
})();
