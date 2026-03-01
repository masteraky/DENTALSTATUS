/* ══════════════════════════════════════════════
   DENTAL STATUS DASHBOARD – frontend logic
   ══════════════════════════════════════════════ */

// ─── Constants ────────────────────────────────────────────────────────────────
const STATUS_HE = {
  open:      'פתוחה',
  closed:    'סגורה',
  emergency: 'חירום בלבד',
  unknown:   'לא ידוע'
};

const STATUS_COLORS = {
  open:      '#16a34a',
  closed:    '#dc2626',
  emergency: '#d97706',
  unknown:   '#94a3b8'
};

const STATUS_BG = {
  open:      '#dcfce7',
  closed:    '#fee2e2',
  emergency: '#fef3c7',
  unknown:   '#f1f5f9'
};

// ─── State ────────────────────────────────────────────────────────────────────
let pieChart   = null;
let barChart   = null;
let trendChart = null;
let filterMode = 'single';
let allReported  = [];
let allMissing   = [];

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

  bootstrap();
});

// ─── Bootstrap: load available dates then render ───────────────────────────────
async function bootstrap() {
  showLoading(true);
  try {
    const resp = await fetch('/api/data');
    const data = await resp.json();
    if (!data.success) throw new Error(data.error);

    const dates = data.dates || [];
    if (dates.length) {
      const last  = dates[dates.length - 1];
      const first = dates[0];
      singleDate.value = last;
      startDate.value  = first;
      endDate.value    = last;
      dateHint.textContent =
        `נתונים זמינים: ${fmtDate(first)} עד ${fmtDate(last)} (${dates.length} ימים)`;
    }

    // Auto-load the last date
    renderDashboard(data);
    updateTimestamp();
  } catch (err) {
    console.error(err);
    alert('שגיאה בטעינת נתונים: ' + err.message);
  } finally {
    showLoading(false);
  }
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
    reported, notReported,
    totalReported, totalNotReported, totalClinics,
    isRange, dateCount, avgReported
  } = data;

  // KPIs
  $('kpiOpen').textContent      = statusCounts.open      || 0;
  $('kpiEmergency').textContent = statusCounts.emergency || 0;
  $('kpiClosed').textContent    = statusCounts.closed    || 0;
  $('kpiReported').textContent  = totalReported;
  $('kpiMissing').textContent   = totalNotReported;

  const rate = totalClinics > 0
    ? Math.round((totalReported / totalClinics) * 100)
    : 0;
  $('kpiRate').textContent = `${rate}%`;

  // Populate command filter
  const commands = [...new Set([...reported, ...notReported].map(r => r.command).filter(Boolean))].sort();
  filterCmd.innerHTML = '<option value="">כל הפיקודים</option>' +
    commands.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  // Charts
  renderPie(statusCounts);
  renderBar(commandStats);

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
              return `  ${ctx.label}: ${ctx.parsed} (${pct}%)`;
            }
          }
        }
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
          label: 'חירום בלבד',
          data: commands.map(c => commandStats[c].emergency || 0),
          backgroundColor: STATUS_COLORS.emergency,
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
            label: ctx  => `  ${ctx.dataset.label}: ${ctx.parsed.y}`
          }
        }
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
          label: 'חירום בלבד',
          data: sortedDates.map(d => perDate[d].emergency || 0),
          backgroundColor: STATUS_COLORS.emergency
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

// ─── Range averages ────────────────────────────────────────────────────────────
function renderAverages(data) {
  const { statusCounts, totalReported, totalClinics, dateCount, avgReported, perDate } = data;

  const totalStatuses = (statusCounts.open || 0) + (statusCounts.closed || 0) + (statusCounts.emergency || 0);
  const pctOpen  = totalStatuses ? Math.round(((statusCounts.open      || 0) / totalStatuses) * 100) : 0;
  const pctClose = totalStatuses ? Math.round(((statusCounts.closed    || 0) / totalStatuses) * 100) : 0;
  const pctEmerg = totalStatuses ? Math.round(((statusCounts.emergency || 0) / totalStatuses) * 100) : 0;

  // Per-day averages
  const dateKeys = Object.keys(perDate || {});
  const totalDays = dateKeys.length || 1;
  const avgOpen   = Math.round((statusCounts.open      || 0) / totalDays);
  const avgClosed = Math.round((statusCounts.closed    || 0) / totalDays);
  const avgEmerg  = Math.round((statusCounts.emergency || 0) / totalDays);

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
      <span class="avg-item-lbl">אחוז חירום (ממוצע)</span>
      <span class="avg-item-val" style="color:var(--c-emerg)">${pctEmerg}%</span>
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
      <span class="avg-item-lbl">ממוצע חירום ליום</span>
      <span class="avg-item-val" style="color:var(--c-emerg)">${avgEmerg}</span>
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
