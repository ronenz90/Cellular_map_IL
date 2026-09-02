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
  // אם המשרד להגנת הסביבה משנה את שמות העמודות, מספיק לעדכן כאן.
  const FIELD_MAP = {
    operator: ['מפעיל', 'חברה', 'שם החברה', 'operator', 'company'],
    generation: ['דור', 'דור_רשת', 'טכנולוגיה', 'generation', 'tech'],
    city: ['רשות מקומית', 'ישוב', 'עיר', 'city', 'locality'],
    street: ['רחוב', 'street'],
    houseNumber: ['מספר', 'מספר_בית', 'house_number'],
    id: ['מזהה', 'מספר_מוקד', 'id', 'objectid'],
    status: ['סטטוס', 'status'],
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
    if (out.generation) {
      const g = String(out.generation).toUpperCase();
      if (g.includes('5')) out.generation = '5G';
      else if (g.includes('4') || g.includes('LTE')) out.generation = '4G';
      else if (g.includes('3')) out.generation = '3G';
      else if (g.includes('2')) out.generation = '2G';
    } else {
      out.generation = 'לא ידוע';
    }
    if (!out.operator) out.operator = 'לא ידוע';
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
  // גבולות גס של ישראל לצורך הטיית תוצאות החיפוש
  const ISRAEL_VIEWBOX = '34.0,29.3,35.9,33.4'; // minLon,minLat,maxLon,maxLat

  async function searchAddress(query) {
    if (!query || query.trim().length < 2) return [];
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&countrycodes=il&viewbox=${ISRAEL_VIEWBOX}&bounded=1&accept-language=he&q=${encodeURIComponent(query)}`;
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) return [];
      const results = await res.json();
      return results.map(r => ({
        label: r.display_name,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        boundingbox: r.boundingbox,
      }));
    } catch (e) {
      console.warn('שגיאת חיפוש כתובת', e);
      return [];
    }
  }

  return { loadAntennas, loadMeta, searchAddress, normalizeProps };
})();
