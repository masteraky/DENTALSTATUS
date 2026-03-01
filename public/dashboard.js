/* ══════════════════════════════════════════════
   DENTAL STATUS DASHBOARD – frontend logic
   ══════════════════════════════════════════════ */

// ─── Constants ────────────────────────────────────────────────────────────────
const STATUS_HE = {
  open:          'פתוחה',
  closed:        'סגורה',
  emergency:     'חירום 24/7',
  emergency_day: 'חירום שעות יום',
  unknown:       'לא ידוע'
};

const STATUS_COLORS = {
  open:          '#16a34a',
  closed:        '#dc2626',
  emergency:     '#d97706',
  emergency_day: '#f59e0b',
  unknown:       '#94a3b8'
};

const STATUS_BG = {
  open:          '#dcfce7',
  closed:        '#fee2e2',
  emergency:     '#fef3c7',
  emergency_day: '#fffbeb',
  unknown:       '#f1f5f9'
};

// ─── State ────────────────────────────────────────────────────────────────────
let pieChart   = null;
let barChart   = null;
let trendChart = null;
let filterMode = 'single';
let allReported  = [];
let allMissing   = [];
let currentData  = null;   // full API response, used by drill-down

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const overlay       = $('overlay');
const singlePicker  = $('singlePicker');
const rangePicker   = $('rangePicker');
const singleDate    = $('singleDate');
const startDate     = $('startDate');
const endDate       = $('endDate');
const applyBtn      = $('applyBtn');
const refreshBtn    = $('refreshBtn');
const dateHint      = $('dateHint');
const lastUpdated   = $('lastUpdated');
const trendSection  = $('trendSection');
const avgSection    = $('avgSection');
const searchRep     = $('searchReported');
const searchMiss    = $('searchMissing');
const filterCmd     = $('filterCommand');

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Mode toggle
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterMode = btn.dataset.mode;
      singlePicker.classList.toggle('hidden', filterMode === 'range');
      rangePicker.classList.toggle('hidden',  filterMode === 'single');
    });
  });

  applyBtn.addEventListener('click', loadData);
  refreshBtn.addEventListener('click', refreshData);

  searchRep.addEventListener('input',  renderLists);
  searchMiss.addEventListener('input',  renderLists);
  filterCmd.addEventListener('change',  renderLists);

  // Drill-down modal close
  $('drillClose').addEventListener('click', closeDrill);
  $('drillBackdrop').addEventListener('click', closeDrill);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrill(); });

  bootstrap();
});

// ─── Bootstrap: discover available dates, then load last date ─────────────────
async function bootstrap() {
  showLoading(true);
  try {
    // Fetch unfiltered data only to discover available date range
    const resp = await fetch('/api/data');
    const data = await resp.json();
    if (!data.success) throw new Error(data.error);

    const dates = data.dates || [];
    if (!dates.length) {
      showLoading(false);
      return; // no data at all
    }

    const first = dates[0];
    const last  = dates[dates.length - 1];

    // Pick the best default date:
    // 1. Today, if it has >1 report
    // 2. Otherwise, the most recent PAST date (≤ today) with >1 report
    // 3. Fallback: last date in the list
    // This prevents future pre-submitted dates from becoming the default.
    const today = new Date().toISOString().slice(0, 10);
    const perDate = data.perDate || {};
    const significant = Object.keys(perDate)
      .filter(d => perDate[d].total > 1)
      .sort();

    let defaultDate;
    if (significant.includes(today)) {
      defaultDate = today;
    } else {
      const pastSignificant = significant.filter(d => d <= today);
      defaultDate = pastSignificant.length
        ? pastSignificant[pastSignificant.length - 1]
        : (significant.length ? significant[significant.length - 1] : last);
    }

    singleDate.value = defaultDate;
    startDate.value  = first;
    endDate.value    = last;
    dateHint.textContent =
      `נתונים זמינים: ${fmtDate(first)} עד ${fmtDate(last)} (${dates.length} ימים)`;
  } catch (err) {
    console.error(err);
    alert('שגיאה בטעינת נתונים: ' + err.message);
    showLoading(false);
    return;
  }
  showLoading(false);
  // Load filtered data for the last available date
  await loadData();
}

// ─── Load data for selected filter ────────────────────────────────────────────
async function loadData() {
  let url = '/api/data?';

  if (filterMode === 'single') {
    if (!singleDate.value) { alert('בחר תאריך'); return; }
    url += `date=${singleDate.value}`;
  } else {
    if (!startDate.value || !endDate.value) { alert('בחר תקופה'); return; }
    url += `startDate=${startDate.value}&endDate=${endDate.value}`;
  }

  showLoading(true);
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.success) throw new Error(data.error);
    currentData = data;
    renderDashboard(data);
    updateTimestamp();
  } catch (err) {
    console.error(err);
    alert('שגיאה: ' + err.message);
  } finally {
    showLoading(false);
  }
}

async function refreshData() {
  showLoading(true);
  try {
    await fetch('/api/refresh');
    await loadData();
  } finally {
    showLoading(false);
  }
}

// ─── Master render ─────────────────────────────────────────────────────────────
function renderDashboard(data) {
  const {
    statusCounts, commandStats, perDate,
    reported, notReported, closedBreakdown,
    totalReported, totalNotReported, totalClinics,
    isRange, dateCount, avgReported
  } = data;

  // KPIs
  $('kpiOpen').textContent         = statusCounts.open          || 0;
  $('kpiEmergency').textContent    = statusCounts.emergency     || 0;
  $('kpiEmergencyDay').textContent = statusCounts.emergency_day || 0;
  $('kpiClosed').textContent       = statusCounts.closed        || 0;
  $('kpiReported').textContent  = totalReported;
  $('kpiMissing').textContent   = totalNotReported;

  const rateCard = $('kpiRate').closest('.kpi-card');
  if (isRange) {
    // In range mode: show average daily reports instead of a misleading %
    const days = (data.dateCount && data.dateCount > 0) ? data.dateCount : 1;
    const avgDay = Math.round(totalReported / days);
    $('kpiRate').textContent = avgDay;
    $('kpiRate').closest('.kpi-body').querySelector('.kpi-lbl').textContent = 'ממוצע דיווחים/יום';
    rateCard.style.opacity = '1';
  } else {
    const rate = totalClinics > 0
      ? Math.round((totalReported / totalClinics) * 100)
      : 0;
    $('kpiRate').textContent = `${rate}%`;
    $('kpiRate').closest('.kpi-body').querySelector('.kpi-lbl').textContent = 'אחוז דיווח';
    rateCard.style.opacity = '1';
  }

  // Populate command filter
  const commands = [...new Set([...reported, ...notReported].map(r => r.command).filter(Boolean))].sort();
  filterCmd.innerHTML = '<option value="">כל הפיקודים</option>' +
    commands.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  // Charts
  renderPie(statusCounts);
  renderBar(commandStats);

  // Closed team breakdown
  renderClosedBreakdown(closedBreakdown, statusCounts.closed || 0);

  // Trend (range only)
  if (isRange && perDate && Object.keys(perDate).length > 1) {
    trendSection.classList.remove('hidden');
    renderTrend(perDate);
  } else {
    trendSection.classList.add('hidden');
  }

  // Store for filter
  allReported = reported;
  allMissing  = notReported;
  renderLists();

  // Averages (range only)
  if (isRange) {
    avgSection.classList.remove('hidden');
    renderAverages(data);
  } else {
    avgSection.classList.add('hidden');
  }
}

// ─── Pie chart ─────────────────────────────────────────────────────────────────
function renderPie(statusCounts) {
  const labels = [], values = [], colors = [];
  for (const [key, lbl] of Object.entries(STATUS_HE)) {
    const v = statusCounts[key] || 0;
    if (v > 0) {
      labels.push(lbl);
      values.push(v);
      colors.push(STATUS_COLORS[key]);
    }
  }

  const ctx = $('pieChart').getContext('2d');
  if (pieChart) pieChart.destroy();

  // Map label index back to status key for drill-down
  const labelToStatus = {};
  labels.forEach((lbl, i) => {
    const key = Object.keys(STATUS_HE).find(k => STATUS_HE[k] === lbl);
    if (key) labelToStatus[i] = key;
  });

  pieChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderWidth: 3,
        borderColor: '#fff',
        hoverBorderWidth: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cursor: 'pointer',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            font: { family: 'Heebo', size: 13, weight: '700' },
            padding: 18,
            usePointStyle: true,
            pointStyleWidth: 12
          }
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct   = total ? Math.round((ctx.parsed / total) * 100) : 0;
              return `  ${ctx.label}: ${ctx.parsed} (${pct}%) — לחץ לפירוט`;
            }
          }
        }
      },
      onClick(event, elements) {
        if (!elements.length) return;
        const idx    = elements[0].index;
        const status = labelToStatus[idx];
        if (!status || !currentData) return;
        const clinics = (currentData.reported || []).filter(r => r.status === status);
        openDrill(
          STATUS_HE[status],
          STATUS_COLORS[status],
          statusEmoji(status),
          clinics,
          clinics.length
        );
      },
      cutout: '58%'
    }
  });
}

// ─── Stacked bar chart ─────────────────────────────────────────────────────────
function renderBar(commandStats) {
  const commands = Object.keys(commandStats);
  const ctx = $('barChart').getContext('2d');
  if (barChart) barChart.destroy();

  barChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: commands,
      datasets: [
        {
          label: 'פתוחה',
          data: commands.map(c => commandStats[c].open || 0),
          backgroundColor: STATUS_COLORS.open,
          borderRadius: 0
        },
        {
          label: STATUS_HE.emergency,
          data: commands.map(c => commandStats[c].emergency || 0),
          backgroundColor: STATUS_COLORS.emergency,
          borderRadius: 0
        },
        {
          label: STATUS_HE.emergency_day,
          data: commands.map(c => commandStats[c].emergency_day || 0),
          backgroundColor: STATUS_COLORS.emergency_day,
          borderRadius: 0
        },
        {
          label: 'סגורה',
          data: commands.map(c => commandStats[c].closed || 0),
          backgroundColor: STATUS_COLORS.closed,
          borderRadius: { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 }
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            font: { family: 'Heebo', size: 13, weight: '700' },
            padding: 18,
            usePointStyle: true,
            pointStyleWidth: 12
          }
        },
        tooltip: {
          callbacks: {
            title: items => `פיקוד: ${items[0].label}`,
            label: ctx  => `  ${ctx.dataset.label}: ${ctx.parsed.y} — לחץ לפירוט`
          }
        }
      },
      onClick(event, elements) {
        if (!elements.length || !currentData) return;
        const el         = elements[0];
        const command    = commands[el.index];
        // datasetIndex: 0=open, 1=emergency, 2=emergency_day, 3=closed
        const statusKeys = ['open', 'emergency', 'emergency_day', 'closed'];
        const status     = statusKeys[el.datasetIndex];
        if (!status || !command) return;
        const clinics = (currentData.reported || []).filter(
          r => r.command === command && r.status === status
        );
        openDrill(
          `${command} — ${STATUS_HE[status]}`,
          STATUS_COLORS[status],
          statusEmoji(status),
          clinics,
          clinics.length
        );
      },
      scales: {
        x: {
          stacked: true,
          ticks: { font: { family: 'Heebo', size: 13 } },
          grid: { display: false }
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { font: { family: 'Heebo', size: 12 }, stepSize: 1 }
        }
      }
    }
  });
}

// ─── Trend chart (date-range mode) ────────────────────────────────────────────
function renderTrend(perDate) {
  const sortedDates = Object.keys(perDate).sort();
  const ctx = $('trendChart').getContext('2d');
  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sortedDates.map(fmtDate),
      datasets: [
        {
          label: 'פתוחה',
          data: sortedDates.map(d => perDate[d].open || 0),
          backgroundColor: STATUS_COLORS.open
        },
        {
          label: STATUS_HE.emergency,
          data: sortedDates.map(d => perDate[d].emergency || 0),
          backgroundColor: STATUS_COLORS.emergency
        },
        {
          label: STATUS_HE.emergency_day,
          data: sortedDates.map(d => perDate[d].emergency_day || 0),
          backgroundColor: STATUS_COLORS.emergency_day
        },
        {
          label: 'סגורה',
          data: sortedDates.map(d => perDate[d].closed || 0),
          backgroundColor: STATUS_COLORS.closed
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { family: 'Heebo', size: 12 }, padding: 14, usePointStyle: true }
        }
      },
      scales: {
        x: {
          stacked: true,
          ticks: { font: { family: 'Heebo', size: 11 }, maxRotation: 45 },
          grid: { display: false }
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { font: { family: 'Heebo', size: 11 }, stepSize: 1 }
        }
      }
    }
  });
}

// ─── Clinic lists ──────────────────────────────────────────────────────────────
function renderLists() {
  const qRep  = searchRep.value.trim().toLowerCase();
  const qMiss = searchMiss.value.trim().toLowerCase();
  const cmd   = filterCmd.value;

  // Reported
  let rep = allReported;
  if (qRep) rep = rep.filter(r => r.clinic.toLowerCase().includes(qRep));
  if (cmd)  rep = rep.filter(r => r.command === cmd);
  rep = [...rep].sort((a, b) => a.clinic.localeCompare(b.clinic, 'he'));

  $('reportedCount').textContent = rep.length;
  const repList = $('reportedList');
  repList.innerHTML = rep.length
    ? rep.map(r => `
        <div class="clinic-row clinic-row--ok">
          <div class="clinic-info">
            <span class="clinic-name">${esc(r.clinic)}</span>
            <span class="clinic-cmd">${esc(r.command || '')}</span>
          </div>
          <span class="badge badge-${r.status}">${STATUS_HE[r.status] || esc(r.statusRaw)}</span>
        </div>`).join('')
    : '<div class="empty-state">אין תוצאות</div>';

  // Missing
  let miss = allMissing;
  if (qMiss) miss = miss.filter(r => r.clinic.toLowerCase().includes(qMiss));
  miss = [...miss].sort((a, b) => a.clinic.localeCompare(b.clinic, 'he'));

  $('missingCount').textContent = miss.length;
  const missArr = $('missingList');
  missArr.innerHTML = miss.length
    ? miss.map(r => `
        <div class="clinic-row clinic-row--err">
          <div class="clinic-info">
            <span class="clinic-name">${esc(r.clinic)}</span>
            <span class="clinic-cmd">${esc(r.command || '')}</span>
          </div>
        </div>`).join('')
    : '<div class="empty-state">✅ כל המרפאות דיווחו!</div>';
}

// ─── Closed clinic team breakdown ─────────────────────────────────────────────
function renderClosedBreakdown(breakdown, totalClosed) {
  const section = $('closedSection');
  const container = $('closedBreakdown');

  if (!breakdown || breakdown.length === 0 || totalClosed === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  $('closedTotal').textContent = totalClosed;

  container.innerHTML = breakdown.map(({ reason, clinics, count }) => {
    const pct = totalClosed > 0 ? Math.round((count / totalClosed) * 100) : 0;
    // Sort clinics by command then name
    const sorted = [...clinics].sort((a, b) =>
      (a.command || '').localeCompare(b.command || '', 'he') ||
      a.clinic.localeCompare(b.clinic, 'he')
    );
    const clinicTags = sorted.map(c =>
      `<span class="clinic-tag" title="${esc(c.command || '')}">${esc(c.clinic)}</span>`
    ).join('');

    return `
      <div class="closed-reason-block">
        <div class="closed-reason-header">
          <div class="closed-reason-text">
            <span class="closed-reason-icon">📌</span>
            <span class="closed-reason-label">${esc(reason)}</span>
          </div>
          <div class="closed-reason-meta">
            <span class="closed-reason-count">${count} מרפאות</span>
            <span class="closed-reason-pct">${pct}%</span>
          </div>
        </div>
        <div class="closed-reason-bar">
          <div class="closed-reason-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="closed-reason-clinics">${clinicTags}</div>
      </div>`;
  }).join('');
}

// ─── Range averages ────────────────────────────────────────────────────────────
function renderAverages(data) {
  const { statusCounts, totalReported, totalClinics, dateCount, avgReported, perDate } = data;

  const totalStatuses = (statusCounts.open || 0) + (statusCounts.closed || 0) + (statusCounts.emergency || 0) + (statusCounts.emergency_day || 0);
  const pctOpen     = totalStatuses ? Math.round(((statusCounts.open          || 0) / totalStatuses) * 100) : 0;
  const pctClose    = totalStatuses ? Math.round(((statusCounts.closed        || 0) / totalStatuses) * 100) : 0;
  const pctEmerg    = totalStatuses ? Math.round(((statusCounts.emergency     || 0) / totalStatuses) * 100) : 0;
  const pctEmergDay = totalStatuses ? Math.round(((statusCounts.emergency_day || 0) / totalStatuses) * 100) : 0;

  // Per-day averages
  const dateKeys = Object.keys(perDate || {});
  const totalDays  = dateKeys.length || 1;
  const avgOpen     = Math.round((statusCounts.open          || 0) / totalDays);
  const avgClosed   = Math.round((statusCounts.closed        || 0) / totalDays);
  const avgEmerg    = Math.round((statusCounts.emergency     || 0) / totalDays);
  const avgEmergDay = Math.round((statusCounts.emergency_day || 0) / totalDays);

  const reportRate = totalClinics > 0
    ? Math.round((totalReported / (totalClinics * totalDays)) * 100)
    : 0;

  $('avgGrid').innerHTML = `
    <div class="avg-item">
      <span class="avg-item-lbl">ימים בתקופה</span>
      <span class="avg-item-val" style="color:var(--c-primary)">${totalDays}</span>
    </div>
    <div class="avg-item">
      <span class="avg-item-lbl">אחוז פתוחות (ממוצע)</span>
      <span class="avg-item-val" style="color:var(--c-open)">${pctOpen}%</span>
    </div>
    <div class="avg-item">
      <span class="avg-item-lbl">אחוז חירום 24/7 (ממוצע)</span>
      <span class="avg-item-val" style="color:var(--c-emerg)">${pctEmerg}%</span>
    </div>
    <div class="avg-item">
      <span class="avg-item-lbl">אחוז חירום שעות יום (ממוצע)</span>
      <span class="avg-item-val" style="color:var(--c-emerg-day)">${pctEmergDay}%</span>
    </div>
    <div class="avg-item">
      <span class="avg-item-lbl">אחוז סגורות (ממוצע)</span>
      <span class="avg-item-val" style="color:var(--c-closed)">${pctClose}%</span>
    </div>
    <div class="avg-item">
      <span class="avg-item-lbl">ממוצע פתוחות ליום</span>
      <span class="avg-item-val" style="color:var(--c-open)">${avgOpen}</span>
    </div>
    <div class="avg-item">
      <span class="avg-item-lbl">ממוצע חירום 24/7 ליום</span>
      <span class="avg-item-val" style="color:var(--c-emerg)">${avgEmerg}</span>
    </div>
    <div class="avg-item">
      <span class="avg-item-lbl">ממוצע חירום שעות יום ליום</span>
      <span class="avg-item-val" style="color:var(--c-emerg-day)">${avgEmergDay}</span>
    </div>
    <div class="avg-item">
      <span class="avg-item-lbl">ממוצע סגורות ליום</span>
      <span class="avg-item-val" style="color:var(--c-closed)">${avgClosed}</span>
    </div>
    <div class="avg-item">
      <span class="avg-item-lbl">אחוז דיווח כולל</span>
      <span class="avg-item-val" style="color:var(--c-rate)">${reportRate}%</span>
    </div>
  `;
}

// ─── Drill-down modal ──────────────────────────────────────────────────────────
function statusEmoji(status) {
  return { open: '✅', closed: '🔴', emergency: '🟡', emergency_day: '🟠', unknown: '❓' }[status] || '📋';
}

function openDrill(title, color, icon, clinics, total) {
  $('drillTitle').textContent = title;
  $('drillIcon').textContent  = icon;
  $('drillBadge').textContent = `${total} מרפאות`;
  $('drillBadge').style.background = color + '22';
  $('drillBadge').style.color      = color;

  // Group by command, sorted Hebrew
  const byCmd = {};
  for (const c of clinics) {
    const cmd = c.command || 'לא צוין';
    if (!byCmd[cmd]) byCmd[cmd] = [];
    byCmd[cmd].push(c);
  }

  const entries = Object.entries(byCmd).sort((a, b) => a[0].localeCompare(b[0], 'he'));

  $('drillContent').innerHTML = entries.length
    ? entries.map(([cmd, list]) => `
        <div class="drill-group">
          <div class="drill-group-header">
            <span class="drill-chevron">▾</span>
            ${esc(cmd)}
            <span class="drill-group-count">${list.length}</span>
          </div>
          <div class="drill-group-body">
            ${list
              .sort((a, b) => a.clinic.localeCompare(b.clinic, 'he'))
              .map(c => `
                <div class="drill-clinic-row">
                  <span class="drill-clinic-name">${esc(c.clinic)}</span>
                  ${c.status
                    ? `<span class="badge badge-${c.status}">${STATUS_HE[c.status] || ''}</span>`
                    : ''}
                </div>`)
              .join('')}
          </div>
        </div>`)
      .join('')
    : '<div class="empty-state">אין נתונים</div>';

  // Wire up collapse/expand on each group header
  $('drillContent').querySelectorAll('.drill-group-header').forEach(header => {
    header.addEventListener('click', () => {
      header.closest('.drill-group').classList.toggle('collapsed');
    });
  });

  $('drillModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeDrill() {
  $('drillModal').classList.add('hidden');
  document.body.style.overflow = '';
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showLoading(on) {
  overlay.classList.toggle('active', on);
}

function updateTimestamp() {
  const now = new Date();
  lastUpdated.textContent = `עודכן: ${now.toLocaleTimeString('he-IL')}`;
}
