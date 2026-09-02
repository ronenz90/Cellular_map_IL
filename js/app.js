/**
 * app.js - לוגיקת המפה והממשק הראשי
 */

const ISRAEL_CENTER = [31.5, 34.9];
const ISRAEL_BOUNDS = L.latLngBounds([29.3, 34.0], [33.4, 35.9]);

// צבעים לפי דור רשת
const GEN_COLORS = { '2G': '#94a3b8', '3G': '#fbbf24', '4G': '#34d399', '5G': '#a855f7', 'אחר': '#475569', 'לא ידוע': '#64748b' };

// רדיוס כיסוי משוער בסיסי (מטרים) לפני התאמת צפיפות - הערכה גסה בלבד,
// ללא נתוני הספק/גובה תורן אמיתיים
const BASE_COVERAGE_RADIUS = { '2G': 1500, '3G': 900, '4G': 700, '5G': 350, 'אחר': 300, 'לא ידוע': 500 };

// --- אינדקס צפיפות מרחבי (grid) להתאמת רדיוס כיסוי לפי עירוני/כפרי ---
// היגיון: הרבה אנטנות קרובות = סביר שאזור עירוני צפוף -> רדיוס קטן יותר.
// מעט אנטנות בסביבה = כנראה אזור כפרי/פתוח -> רדיוס גדול יותר.
// זו עדיין הערכה גסה בלבד (ראו הבהרה בממשק), לא תחזית RF.
const DENSITY_CELL_DEG = 0.01; // ~1 ק"מ

function buildDensityIndex(antennas) {
  const grid = new Map();
  for (const a of antennas) {
    const key = `${Math.floor(a.lat / DENSITY_CELL_DEG)},${Math.floor(a.lon / DENSITY_CELL_DEG)}`;
    if (!grid.has(key)) grid.set(key, 0);
    grid.set(key, grid.get(key) + 1);
  }
  return grid;
}

function densityFactor(grid, lat, lon) {
  const cx = Math.floor(lat / DENSITY_CELL_DEG), cy = Math.floor(lon / DENSITY_CELL_DEG);
  let count = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      count += grid.get(`${cx + dx},${cy + dy}`) || 0;
    }
  }
  // count גבוה (עירוני צפוף) -> factor נמוך (רדיוס קטן)
  // count נמוך (כפרי/פתוח) -> factor גבוה (רדיוס גדול)
  if (count >= 15) return 0.6;
  if (count >= 8) return 0.8;
  if (count >= 4) return 1.0;
  if (count >= 2) return 1.3;
  return 1.8;
}

let densityIndex = null;
let medianPowerByGen = {}; // מחושב מהנתונים בפועל לאחר הטעינה - ראו computeMedianPower

function computeMedianPower(antennas) {
  const byGen = {};
  for (const a of antennas) {
    const v = a.props.maxPowerDensity;
    if (typeof v !== 'number' || isNaN(v) || v <= 0) continue;
    const gen = a.props.generation;
    (byGen[gen] = byGen[gen] || []).push(v);
  }
  const medians = {};
  for (const [gen, vals] of Object.entries(byGen)) {
    vals.sort((a, b) => a - b);
    medians[gen] = vals[Math.floor(vals.length / 2)];
  }
  return medians;
}

/**
 * מתאים את הרדיוס הבסיסי (לפי דור רשת + צפיפות) בהתבסס על הספק השידור
 * התיאורטי האמיתי של האנטנה הספציפית הזו (מתוך היתר הקרינה), יחסית
 * לחציון ההספק של אנטנות אחרות מאותו דור רשת בכל הארץ. פיזיקלית: אובדן
 * מרחב חופשי (Free-Space Path Loss) גורם לכך שההספק המתקבל יורד ביחס
 * ל-1/מרחק², כך שעבור סף קליטה קבוע, המרחק המקסימלי גדל ביחס ל-sqrt(הספק).
 * זו עדיין הערכה (חסרים גובה/אזימוט/דגם), אבל מבוססת נתון אמיתי ולא ניחוש.
 */
function powerAdjustedRadius(a, baseRadius) {
  const v = a.props.maxPowerDensity;
  const median = medianPowerByGen[a.props.generation];
  if (typeof v !== 'number' || isNaN(v) || v <= 0 || !median || median <= 0) return baseRadius;
  const factor = Math.sqrt(v / median);
  const clamped = Math.min(Math.max(factor, 0.5), 2.0); // מגבילים קיצוניות של חריגים
  return Math.round(baseRadius * clamped);
}

function coverageRadiusFor(a) {
  const base = BASE_COVERAGE_RADIUS[a.props.generation] || 500;
  const densityAdjusted = densityIndex ? Math.round(base * densityFactor(densityIndex, a.lat, a.lon)) : base;
  return powerAdjustedRadius(a, densityAdjusted);
}

// צבעי ברירת מחדל למפעילים (יעודכן דינמית אם מזוהים מפעילים נוספים בנתונים)
const OPERATOR_COLORS = {
  'סלקום': '#f97316', 'פלאפון': '#3b82f6', 'פרטנר': '#3b82f6',
  'הוט מובייל': '#eab308', 'גולן טלקום': '#ec4899', 'פלאפון-פרטנר': '#3b82f6',
  'PHI': '#22c55e', "פי.אייץ'.איי": '#22c55e', 'לא ידוע': '#9ca3af',
};

let map, clusterGroup, plainLayerGroup, coverageLayer, plannedLayer, reportsLayer;
let allAntennas = [];
let reportMode = false;
let state = {
  generations: new Set(['2G', '3G', '4G', '5G', 'אחר', 'לא ידוע']),
  operators: new Set(),
  showCoverage: true,
  useCluster: true,
  showPlanned: false,
  showReports: true,
};

function initMap() {
  map = L.map('map', { zoomControl: false, minZoom: 6, maxZoom: 19 })
    .setView(ISRAEL_CENTER, 8);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
  });
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri', maxZoom: 19,
  });

  streets.addTo(map);
  // "מפה כהה" אינה שכבת אריחים נפרדת (ספקים חיצוניים לזה דרשו לאחרונה
  // מפתח API ונשברו) - במקום זאת מפעילים פילטר CSS שהופך את אריחי
  // מפת הרחובות הרגילה לכהה. אמין לגמרי כי אין תלות בספק שלישי נוסף.
  window._basemaps = { streets, satellite };

  document.querySelectorAll('input[name="basemap"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const val = e.target.value;
      const mapEl = document.getElementById('map');
      if (val === 'dark') {
        Object.values(window._basemaps).forEach(l => map.removeLayer(l));
        streets.addTo(map);
        mapEl.classList.add('dark-tiles');
      } else {
        mapEl.classList.remove('dark-tiles');
        Object.values(window._basemaps).forEach(l => map.removeLayer(l));
        window._basemaps[val].addTo(map);
      }
    });
  });

  clusterGroup = L.markerClusterGroup({ maxClusterRadius: 55, disableClusteringAtZoom: 17 });
  plainLayerGroup = L.layerGroup();
  coverageLayer = L.layerGroup();
  plannedLayer = L.layerGroup();
  reportsLayer = L.layerGroup();

  map.addLayer(clusterGroup);
  map.addLayer(coverageLayer);
  map.addLayer(reportsLayer);

  map.fitBounds(ISRAEL_BOUNDS);

  // לחיצה על המפה במצב "דיווח" -> פתיחת טופס דיווח נקודת קליטה חלשה
  map.on('click', (e) => {
    if (!reportMode) return;
    openReportForm(e.latlng);
  });
}

/* ================= דיווחי קליטה חלשה ================= */

function openReportForm(latlng) {
  const html = `
    <div class="report-popup-form">
      <b>דיווח נקודת קליטה חלשה</b>
      <select id="rf-operator">
        <option value="">מפעיל (לא חובה)</option>
        <option>סלקום</option><option>פלאפון</option><option>פרטנר</option>
        <option>הוט מובייל</option><option>גולן טלקום</option>
      </select>
      <textarea id="rf-note" rows="2" placeholder="תיאור קצר (למשל: אין קליטה בתוך הבניין)"></textarea>
      <button id="rf-save">שמור דיווח</button>
    </div>`;
  const popup = L.popup().setLatLng(latlng).setContent(html).openOn(map);
  setTimeout(() => {
    const btn = document.getElementById('rf-save');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const operator = document.getElementById('rf-operator').value;
      const note = document.getElementById('rf-note').value;
      Reports.add({ lat: latlng.lat, lon: latlng.lng, operator, note });
      map.closePopup();
      renderReports();
      setReportMode(false);
    });
  }, 0);
}

function renderReports() {
  reportsLayer.clearLayers();
  if (!state.showReports) { renderReportsList(); return; }
  for (const r of Reports.getAll()) {
    const marker = L.marker([r.lat, r.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="width:16px;height:16px;border-radius:50% 50% 50% 0;background:#f87171;border:2px solid #fff;transform:rotate(-45deg)"></div>`,
        iconSize: [16, 16],
      }),
    });
    marker.bindPopup(`
      <div class="popup-title">דיווח קליטה חלשה</div>
      ${r.operator ? `<div class="popup-row"><b>מפעיל:</b> ${r.operator}</div>` : ''}
      ${r.note ? `<div class="popup-row">${r.note}</div>` : ''}
      <div class="popup-row" style="color:#6b7280">${new Date(r.createdAt).toLocaleDateString('he-IL')}</div>
    `);
    reportsLayer.addLayer(marker);
  }
  renderReportsList();
}

function renderReportsList() {
  const list = document.getElementById('reportsList');
  const reports = Reports.getAll();
  if (!reports.length) { list.innerHTML = '<div class="mini-empty">אין דיווחים עדיין</div>'; return; }
  list.innerHTML = '';
  reports.slice().reverse().forEach(r => {
    const row = document.createElement('div');
    row.className = 'mini-item';
    row.innerHTML = `<span class="mi-label">${r.note || r.operator || 'דיווח'} · ${new Date(r.createdAt).toLocaleDateString('he-IL')}</span><button title="מחק">✕</button>`;
    row.querySelector('button').addEventListener('click', () => {
      Reports.remove(r.id);
      renderReports();
    });
    list.appendChild(row);
  });
}

function setReportMode(on) {
  reportMode = on;
  const btn = document.getElementById('reportModeBtn');
  btn.classList.toggle('active', on);
  btn.textContent = on ? '❌ בטל מצב דיווח (לחץ על המפה)' : '📍 סמן נקודת קליטה חלשה על המפה';
  document.getElementById('map').style.cursor = on ? 'crosshair' : '';
}

/* ================= כתובות שמורות + התראות ================= */

function renderSavedAddresses() {
  const list = document.getElementById('savedAddressesList');
  const addresses = SavedAddresses.getAll();
  if (!addresses.length) { list.innerHTML = '<div class="mini-empty">אין כתובות שמורות</div>'; return; }
  list.innerHTML = '';
  addresses.forEach(addr => {
    const row = document.createElement('div');
    row.className = 'mini-item';
    row.innerHTML = `<span class="mi-label">⭐ ${addr.label}</span><button title="הסר">✕</button>`;
    row.querySelector('.mi-label').style.cursor = 'pointer';
    row.querySelector('.mi-label').addEventListener('click', () => map.setView([addr.lat, addr.lon], 16));
    row.querySelector('button').addEventListener('click', () => {
      SavedAddresses.remove(addr.id);
      renderSavedAddresses();
    });
    list.appendChild(row);
  });
}

function showAlertBanner(html) {
  const banner = document.getElementById('alertBanner');
  banner.innerHTML = `<button class="close-alert">✕</button>${html}`;
  banner.classList.remove('hidden');
  banner.querySelector('.close-alert').addEventListener('click', () => banner.classList.add('hidden'));
}

function checkAddressAlerts() {
  const addresses = SavedAddresses.getAll();
  if (!addresses.length || !allAntennas.length) return;
  let messages = [];
  for (const addr of addresses) {
    const newOnes = SavedAddresses.checkNewAntennas(addr, allAntennas);
    if (newOnes.length) {
      const gens = newOnes.map(a => a.props.generation).join(', ');
      messages.push(`<div class="popup-row">📡 <b>${newOnes.length}</b> אנטנות חדשות ליד <b>${addr.label}</b> (${gens})</div>`);
      SavedAddresses.notify('אנטנה חדשה בקרבתך!', `${newOnes.length} אנטנות חדשות ליד ${addr.label}`);
    }
  }
  if (messages.length) {
    showAlertBanner(`<div class="popup-title">עדכוני אנטנות</div>${messages.join('')}`);
  }
}

function genDot(gen) {
  return `<span class="gen-badge" style="background:${GEN_COLORS[gen] || '#64748b'}">${gen}</span>`;
}

function makeIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5)"></div>`,
    iconSize: [14, 14],
  });
}

function buildPopup(a) {
  const p = a.props;
  const addr = [p.street, p.houseNumber].filter(Boolean).join(' ');
  const powerLine = (typeof p.maxPowerDensity === 'number')
    ? `<div class="popup-row"><b>הספק תיאורטי מרבי:</b> ${p.maxPowerDensity} µW/סמ"ר</div>` : '';
  const healthLine = (typeof p.healthPercent === 'number')
    ? `<div class="popup-row"><b>% מסף בריאות (מדידה):</b> ${p.healthPercent}%</div>` : '';
  return `
    <div class="popup-title">${p.operator || 'מפעיל לא ידוע'}</div>
    <div class="popup-row">${p.allGenerations && p.allGenerations.length > 1 ? p.allGenerations.map(genDot).join(' ') : genDot(p.generation)} ${p.status ? '<span style="color:#9ca3af">(' + p.status + ')</span>' : ''}</div>
    ${addr ? `<div class="popup-row"><b>כתובת:</b> ${addr}</div>` : ''}
    ${p.city ? `<div class="popup-row"><b>יישוב:</b> ${p.city}</div>` : ''}
    ${p.siteType ? `<div class="popup-row"><b>סוג אתר:</b> ${p.siteType}</div>` : ''}
    ${powerLine}
    ${healthLine}
    ${p.id ? `<div class="popup-row"><b>מזהה מוקד:</b> ${p.id}</div>` : ''}
    <div class="popup-row" style="margin-top:6px;color:#6b7280">מיקום: ${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}</div>
    <button class="adv-coverage-btn">🔬 חשב כיסוי מדויק יותר (תבליט+תכסית, בטא)</button>
    <div class="adv-coverage-status"></div>
  `;
}

let advancedCoverageLayer = null;

async function runAdvancedCoverage(a, marker) {
  const popupEl = marker.getPopup()._contentNode;
  const btn = popupEl.querySelector('.adv-coverage-btn');
  const statusEl = popupEl.querySelector('.adv-coverage-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ מחשב תבליט + תכסית (עד כמה שניות)...'; }

  try {
    const baseRadius = coverageRadiusFor(a);
    const { polygon, usedClutter, source, computedAt } = await TerrainCoverage.computeCoverage(a, baseRadius);

    if (advancedCoverageLayer) map.removeLayer(advancedCoverageLayer);
    advancedCoverageLayer = L.polygon(polygon, {
      color: '#f97316', weight: 2, dashArray: '6 4',
      fillColor: '#f97316', fillOpacity: 0.15,
    }).addTo(map);

    const clutterNote = usedClutter ? ' + תכסית (יער/עירוני/מים)' : ' (תכסית לא זמינה כרגע - רק תבליט)';
    const sourceNote = source === 'precomputed'
      ? ` <span style="color:#34d399">(מוכן מראש${computedAt ? ', מ-' + new Date(computedAt).toLocaleDateString('he-IL') : ''})</span>`
      : ' <span style="color:#9ca3af">(חושב עכשיו בזמן אמת)</span>';
    if (statusEl) statusEl.innerHTML = `<div class="popup-row" style="color:#f97316">✓ מוצג "ענן" מבוסס תבליט${clutterNote}${sourceNote} - עדיין הערכה, לא מדידת הספק אמיתית</div>`;
    if (btn) { btn.textContent = '🔬 חשב שוב'; btn.disabled = false; }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.innerHTML = '<div class="popup-row" style="color:#f87171">שגיאה בחישוב (שירות נתוני חוץ לא זמין כרגע)</div>';
    if (btn) { btn.textContent = '🔬 חשב כיסוי מדויק יותר (תבליט+תכסית, בטא)'; btn.disabled = false; }
  }
}

function passesFilter(a) {
  const p = a.props;
  if (!state.generations.has(p.generation)) return false;
  if (state.operators.size > 0 && !state.operators.has(p.operator)) return false;
  return true;
}

function renderAntennas() {
  clusterGroup.clearLayers();
  plainLayerGroup.clearLayers();
  coverageLayer.clearLayers();
  plannedLayer.clearLayers();

  let visibleCount = 0;

  const source = state.useCluster ? clusterGroup : plainLayerGroup;
  if (!state.useCluster && !map.hasLayer(plainLayerGroup)) map.addLayer(plainLayerGroup);
  if (state.useCluster && !map.hasLayer(clusterGroup)) map.addLayer(clusterGroup);
  if (state.useCluster && map.hasLayer(plainLayerGroup)) map.removeLayer(plainLayerGroup);
  if (!state.useCluster && map.hasLayer(clusterGroup)) map.removeLayer(clusterGroup);

  for (const a of allAntennas) {
    if (!passesFilter(a)) continue;
    visibleCount++;
    const color = OPERATOR_COLORS[a.props.operator] || GEN_COLORS[a.props.generation] || '#38bdf8';
    const marker = L.marker([a.lat, a.lon], { icon: makeIcon(color) });
    marker.bindPopup(buildPopup(a));
    marker.on('popupopen', () => {
      const popupEl = marker.getPopup()._contentNode;
      const btn = popupEl.querySelector('.adv-coverage-btn');
      if (btn) btn.addEventListener('click', () => runAdvancedCoverage(a, marker));
    });
    source.addLayer(marker);

    if (state.showCoverage) {
      const radius = coverageRadiusFor(a);
      L.circle([a.lat, a.lon], {
        radius, color, weight: 1, fillColor: color, fillOpacity: 0.08, opacity: 0.35,
      }).addTo(coverageLayer);
    }
  }

  // אנטנות בהקמה (מוצג נפרד, אייקון שונה)
  if (state.showPlanned) {
    for (const a of window._plannedAntennas || []) {
      const marker = L.marker([a.lat, a.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="width:12px;height:12px;border-radius:3px;background:#f59e0b;border:2px solid #fff;transform:rotate(45deg)"></div>`,
          iconSize: [12, 12],
        }),
      });
      marker.bindPopup(buildPopup(a));
      plannedLayer.addLayer(marker);
    }
    plannedLayer.addTo(map);
  } else {
    map.removeLayer(plannedLayer);
  }

  document.getElementById('statsBox').innerHTML =
    `<b>${visibleCount.toLocaleString('he-IL')}</b> אנטנות מוצגות<br>מתוך <b>${allAntennas.length.toLocaleString('he-IL')}</b> סה"כ`;

  const unknownCount = allAntennas.filter(a => a.props.generation === 'לא ידוע').length;
  if (unknownCount > 0) {
    const samples = [...new Set(
      allAntennas
        .filter(a => a.props.generation === 'לא ידוע')
        .map(a => a.props.raw && a.props.raw['טכנולוגיית שידור'])
        .filter(Boolean)
    )].slice(0, 8);
    document.getElementById('statsBox').innerHTML += `
      <div style="margin-top:6px;color:#fbbf24;font-size:11.5px">
        ⚠️ ${unknownCount.toLocaleString('he-IL')} אנטנות בדור רשת לא מזוהה (עדיין מוצגות).
        ${samples.length ? 'ערכים גולמיים שנמצאו: ' + samples.map(s => `"${s}"`).join(', ') : ''}
      </div>`;
    console.info('[antenna-map] ערכי "טכנולוגיית שידור" לא מזוהים:', samples);
  }
}

function buildOperatorFilters() {
  const operators = [...new Set(allAntennas.map(a => a.props.operator))].sort();
  const container = document.getElementById('operatorFilters');
  container.innerHTML = '';
  operators.forEach(op => {
    state.operators.add(op); // ברירת מחדל: הכל מסומן (סט ריק = הכל מוצג, אז נשאיר ריק בפועל)
    const color = OPERATOR_COLORS[op] || '#38bdf8';
    const label = document.createElement('label');
    label.className = 'checkbox-row';
    label.innerHTML = `<input type="checkbox" value="${op}" checked><span class="op-swatch" style="background:${color}"></span>${op}`;
    container.appendChild(label);
  });
  state.operators.clear(); // סט ריק = ללא סינון מפעיל (מציג הכל) - ברירת מחדל

  container.querySelectorAll('input').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = [...container.querySelectorAll('input:checked')].map(i => i.value);
      const total = container.querySelectorAll('input').length;
      state.operators = checked.length === total ? new Set() : new Set(checked);
      renderAntennas();
    });
  });
}

function wireFilters() {
  document.getElementById('genFilters').querySelectorAll('input').forEach(cb => {
    cb.addEventListener('change', () => {
      state.generations = new Set(
        [...document.getElementById('genFilters').querySelectorAll('input:checked')].map(i => i.value)
      );
      renderAntennas();
    });
  });

  document.getElementById('toggleCoverage').addEventListener('change', (e) => {
    state.showCoverage = e.target.checked;
    renderAntennas();
  });
  document.getElementById('toggleCluster').addEventListener('change', (e) => {
    state.useCluster = e.target.checked;
    renderAntennas();
  });
  document.getElementById('toggleHakama').addEventListener('change', (e) => {
    state.showPlanned = e.target.checked;
    renderAntennas();
  });
  document.getElementById('toggleReports').addEventListener('change', (e) => {
    state.showReports = e.target.checked;
    renderReports();
  });
}

function wireReportsAndSaved() {
  document.getElementById('reportModeBtn').addEventListener('click', () => setReportMode(!reportMode));

  document.getElementById('saveCurrentAddressBtn').addEventListener('click', () => {
    const center = map.getCenter();
    const label = prompt('שם לכתובת השמורה (למשל: הבית שלי):', 'המיקום שנבחר');
    if (label === null) return;
    SavedAddresses.add({ label: label || 'מיקום שמור', lat: center.lat, lon: center.lng, radius: 500 });
    SavedAddresses.requestPermission();
    renderSavedAddresses();
    if (allAntennas.length) checkAddressAlerts();
  });
}

function wireOfflineBadge() {
  const badge = document.getElementById('offlineBadge');
  const update = () => badge.classList.toggle('hidden', navigator.onLine);
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

async function loadPrecomputeStatus() {
  const box = document.getElementById('precomputeStatusBox');
  try {
    const res = await fetch('data/coverage-precompute-state.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('no state file yet');
    const state = await res.json();
    const total = state.total_antennas || allAntennas.length;
    const pct = total ? Math.min(100, Math.round((state.offset / total) * 100)) : 0;
    const lastRun = state.last_run ? new Date(state.last_run).toLocaleDateString('he-IL') : 'טרם רץ';
    box.innerHTML = `
      <div>סבב נוכחי: <b>${pct}%</b> מהאנטנות חושבו מראש</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px">ריצה אחרונה: ${lastRun}${state.cycles_completed ? ' · סבבים שהושלמו: ' + state.cycles_completed : ''}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:4px">אנטנות שעוד לא הגיע תורן יחושבו בזמן אמת בלחיצה (איטי יותר)</div>
    `;
  } catch {
    box.innerHTML = '<div class="mini-empty">החישוב הלילי טרם רץ - כל לחיצה על "כיסוי מדויק" תיפול לחישוב חי</div>';
  }
}

function wireSidePanel() {
  const panel = document.getElementById('sidePanel');
  const overlay = document.getElementById('sideOverlay');
  const toggle = document.getElementById('menuToggle');
  const open = () => { panel.classList.add('open'); overlay.classList.add('open'); };
  const close = () => { panel.classList.remove('open'); overlay.classList.remove('open'); };
  toggle.addEventListener('click', () => panel.classList.contains('open') ? close() : open());
  overlay.addEventListener('click', close);
}

function wireSearch() {
  const input = document.getElementById('addressInput');
  const resultsBox = document.getElementById('searchResults');
  const btn = document.getElementById('searchBtn');
  let debounceTimer;

  async function runSearch() {
    const q = input.value.trim();
    if (q.length < 2) { resultsBox.classList.add('hidden'); return; }
    resultsBox.innerHTML = '<div class="search-empty">מחפש...</div>';
    resultsBox.classList.remove('hidden');
    const results = await DataLoader.searchAddress(q);
    if (!results.length) {
      resultsBox.innerHTML = '<div class="search-empty">לא נמצאו תוצאות</div>';
      return;
    }
    resultsBox.innerHTML = '';
    results.forEach(r => {
      const item = document.createElement('div');
      item.className = 'search-item';
      item.textContent = r.label;
      item.title = r.fullLabel || r.label;
      item.addEventListener('click', () => {
        map.setView([r.lat, r.lon], 16);
        resultsBox.classList.add('hidden');
        input.value = r.label;
        document.getElementById('sidePanel').classList.remove('open');
        document.getElementById('sideOverlay').classList.remove('open');
      });
      resultsBox.appendChild(item);
    });
  }

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 400);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounceTimer); runSearch(); } });
  btn.addEventListener('click', runSearch);
  document.addEventListener('click', (e) => {
    if (!document.getElementById('searchBox').contains(e.target)) resultsBox.classList.add('hidden');
  });
}

function wireMisc() {
  document.getElementById('fitIsraelBtn').addEventListener('click', () => map.fitBounds(ISRAEL_BOUNDS));
  document.getElementById('locateBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        map.setView([latitude, longitude], 15);
        L.circleMarker([latitude, longitude], { radius: 7, color: '#38bdf8', fillColor: '#38bdf8', fillOpacity: 0.8 }).addTo(map);
      },
      () => alert('לא ניתן היה לקבל את המיקום שלך'),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

async function boot() {
  initMap();
  wireFilters();
  wireSidePanel();
  wireSearch();
  wireMisc();
  wireReportsAndSaved();
  wireOfflineBadge();
  renderSavedAddresses();
  renderReports();

  const loadingBanner = document.getElementById('loadingBanner');
  const errorBanner = document.getElementById('errorBanner');
  loadingBanner.classList.remove('hidden');

  try {
    const data = await DataLoader.loadAntennas();
    allAntennas = data.active;
    window._plannedAntennas = data.planned;
    densityIndex = buildDensityIndex(allAntennas);
    medianPowerByGen = computeMedianPower(allAntennas);

    buildOperatorFilters();
    renderAntennas();
    checkAddressAlerts();

    if (allAntennas.length === 0) {
      errorBanner.textContent = 'נטען קובץ נתונים תקין אך ללא אנטנות בפועל (0 רשומות). כנראה בעיה במבנה הנתונים במקור - ראו לוגים של scripts/fetch_data.py.';
      errorBanner.classList.remove('hidden');
    }

    const meta = await DataLoader.loadMeta();
    const updatedEl = document.getElementById('lastUpdated');
    if (meta && meta.updated_at) {
      const d = new Date(meta.updated_at);
      updatedEl.textContent = `עודכן לאחרונה: ${d.toLocaleDateString('he-IL')} ${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      updatedEl.textContent = '';
    }

    const history = await HistoryTrend.load();
    HistoryTrend.renderInto(document.getElementById('historyBox'), history, null);

    loadPrecomputeStatus();
  } catch (err) {
    console.error(err);
    errorBanner.textContent = 'שגיאה בטעינת נתוני האנטנות. בדוק את חיבור האינטרנט ונסה שוב.';
    errorBanner.classList.remove('hidden');
    document.getElementById('statsBox').textContent = 'טעינת הנתונים נכשלה.';
  } finally {
    loadingBanner.classList.add('hidden');
  }
}

document.addEventListener('DOMContentLoaded', boot);
