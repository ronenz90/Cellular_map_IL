/**
 * saved-addresses.js - כתובות שמורות והתראות על אנטנות חדשות בקרבתן
 * (בעיקר 5G). נבדק בכל טעינה/רענון של האפליקציה - אין push אמיתי
 * כי מדובר באתר סטטי ללא שרת, אבל זה עדיין נותן ערך אמיתי למשתמש
 * שחוזר לאפליקציה מדי פעם.
 */
const SavedAddresses = (() => {
  const ADDR_KEY = 'savedAddresses_v1';
  const KNOWN_KEY_PREFIX = 'knownAntennas_'; // + address id

  function getAll() {
    try { return JSON.parse(localStorage.getItem(ADDR_KEY) || '[]'); } catch { return []; }
  }
  function saveAll(list) {
    try { localStorage.setItem(ADDR_KEY, JSON.stringify(list)); } catch (e) { console.warn(e); }
  }

  function add({ label, lat, lon, radius = 500 }) {
    const list = getAll();
    const entry = { id: 'a' + Date.now(), label, lat, lon, radius };
    list.push(entry);
    saveAll(list);
    return entry;
  }

  function remove(id) {
    saveAll(getAll().filter(a => a.id !== id));
    localStorage.removeItem(KNOWN_KEY_PREFIX + id);
  }

  function distMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * משווה מול "אנטנות ידועות" שנשמרו בעבר עבור הכתובת, ומחזיר רשימת
   * אנטנות חדשות (טרם נראו) שנמצאות ברדיוס שנקבע.
   */
  function checkNewAntennas(address, allAntennas) {
    const key = KNOWN_KEY_PREFIX + address.id;
    let known = [];
    try { known = JSON.parse(localStorage.getItem(key) || '[]'); } catch { known = []; }
    const knownSet = new Set(known);

    const nearby = allAntennas.filter(a =>
      distMeters(address.lat, address.lon, a.lat, a.lon) <= address.radius
    );

    const nearbyIds = nearby.map(a => String(a.props.id || `${a.lat},${a.lon}`));
    const newOnes = nearby.filter((a, i) => !knownSet.has(nearbyIds[i]));

    // עדכון "הידוע" לפעם הבאה
    try { localStorage.setItem(key, JSON.stringify(nearbyIds)); } catch (e) { console.warn(e); }

    return newOnes;
  }

  function notify(title, body) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: 'icons/icon-192.png' });
    }
  }

  function requestPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  return { getAll, add, remove, checkNewAntennas, notify, requestPermission };
})();
