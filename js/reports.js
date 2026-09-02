/**
 * reports.js - דיווחי משתמשים על נקודות קליטה חלשה ("נקודות מתות")
 * נשמר מקומית בדפדפן (localStorage) - אין שרת מרכזי, כך שהדיווחים
 * נראים רק במכשיר שבו הם נוצרו. זהו MVP; להרחבה עתידית לשיתוף בין
 * משתמשים יש לחבר backend (למשל Firebase/Supabase).
 */
const Reports = (() => {
  const STORAGE_KEY = 'deadZoneReports_v1';

  function getAll() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function saveAll(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) { console.warn(e); }
  }

  function add(report) {
    const list = getAll();
    const entry = {
      id: 'r' + Date.now() + Math.floor(Math.random() * 1000),
      lat: report.lat,
      lon: report.lon,
      operator: report.operator || 'לא צוין',
      note: report.note || '',
      createdAt: new Date().toISOString(),
    };
    list.push(entry);
    saveAll(list);
    return entry;
  }

  function remove(id) {
    saveAll(getAll().filter(r => r.id !== id));
  }

  return { getAll, add, remove };
})();
