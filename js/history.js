/**
 * history.js - מגמת התקנות לאורך זמן
 * קורא את data/history.json (נבנה ע"י scripts/fetch_data.py בכל הרצה
 * אוטומטית) ומציג טרנד כללי + גרף sparkline פשוט ב-SVG (ללא ספריית צד ג').
 */
const HistoryTrend = (() => {

  async function load() {
    try {
      const res = await fetch('data/history.json', { cache: 'no-cache' });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  function sparklineSVG(values, width = 240, height = 44) {
    if (!values.length) return '';
    const min = Math.min(...values), max = Math.max(...values);
    const range = (max - min) || 1;
    const step = width / Math.max(values.length - 1, 1);
    const points = values.map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * (height - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">
        <polyline points="${points}" fill="none" stroke="#38bdf8" stroke-width="2"/>
      </svg>`;
  }

  function renderInto(containerEl, history, cityFilter) {
    if (!history || history.length === 0) {
      containerEl.innerHTML = '<div class="hist-empty">עדיין אין מספיק היסטוריה - היא תיבנה אוטומטית עם כל עדכון יומי.</div>';
      return;
    }

    const totals = history.map(h => h.active_count || 0);
    const first = history[0];
    const last = history[history.length - 1];
    const delta = (last.active_count || 0) - (first.active_count || 0);
    const deltaSign = delta > 0 ? '+' : '';
    const deltaColor = delta > 0 ? '#34d399' : (delta < 0 ? '#f87171' : '#9ca3af');

    let cityLine = '';
    if (cityFilter && first.by_city && last.by_city) {
      const firstC = first.by_city[cityFilter] || 0;
      const lastC = last.by_city[cityFilter] || 0;
      const cDelta = lastC - firstC;
      const sign = cDelta > 0 ? '+' : '';
      cityLine = `<div class="hist-city-line">ב<b>${cityFilter}</b>: ${lastC} אנטנות (<span style="color:${cDelta >= 0 ? '#34d399' : '#f87171'}">${sign}${cDelta}</span> מאז ${new Date(first.date).toLocaleDateString('he-IL')})</div>`;
    }

    const firstDate = new Date(first.date).toLocaleDateString('he-IL');

    containerEl.innerHTML = `
      <div class="hist-total">סה"כ כיום: <b>${(last.active_count || 0).toLocaleString('he-IL')}</b> אנטנות</div>
      <div class="hist-delta" style="color:${deltaColor}">${deltaSign}${delta} מאז ${firstDate}</div>
      <div class="hist-chart">${sparklineSVG(totals)}</div>
      ${cityLine}
    `;
  }

  return { load, renderInto };
})();
