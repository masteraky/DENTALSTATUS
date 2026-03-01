require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const { parse } = require('csv-parse/sync');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Google Sheets config ────────────────────────────────────────────────────
const SHEET_ID  = process.env.SHEET_ID || '1AUlu4G2UIsPza4tt7gs9rEFxfUx2-pZASwwRibgXleA';
const CSV_URL   = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── In-memory cache ─────────────────────────────────────────────────────────
let dataCache = { rows: null, timestamp: 0 };

// ─── Reason normalisation (closed-clinic "where is staff" field) ─────────────
function normalizeReason(raw) {
  const s = (raw || '').trim();
  if (!s) return 'לא צוין';

  // ── "at home" family ──────────────────────────────────────────────────────
  // matches: "בית", "בבית", "כולם בבית", "כל הצוות בבית", "כולנו בבית", etc.
  if (/^בית$|^בבית$/.test(s)) return 'בבית';
  if (/^(כולם|כולנו|כל הצוות|כל הצות|הצוות)\s+(בבית|בית)$/.test(s)) return 'בבית';
  if (/^(בבית|בית)\s*[-–,]/.test(s)) return 'בבית'; // "בבית - הערה"
  if (/\bבבית\b/.test(s) && !/כוננות/.test(s)) return 'בבית';

  // ── "home standby" family ────────────────────────────────────────────────
  // matches: "כוננות בית", "כוננות בית להקפצה", "כוננות מהבית", etc.
  if (/כוננות.*(בית|מהבית)|בית.*כוננות/.test(s)) return 'כוננות בית';

  return s;
}

// ─── Status normalisation ────────────────────────────────────────────────────
function normalizeStatus(raw) {
  if (!raw) return 'unknown';
  const s = raw.trim();
  if (s.includes('כרגיל'))                                   return 'open';
  if (s.includes('עזרה ראשונה') || s.includes('חירום'))     return 'emergency';
  if (s.includes('סגור'))                                    return 'closed';
  return 'unknown';
}

// ─── Date helpers ────────────────────────────────────────────────────────────
function parseSheetDate(str) {
  if (!str) return null;
  const s = str.trim();
  // M/D/YYYY, M/D/YY, MM/DD/YYYY, MM/DD/YY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let year = +m[3];
    if (year < 100) year += 2000; // "25" → 2025, never 1925
    const d = new Date(year, +m[1] - 1, +m[2]);
    // Sanity-check: reject clearly-wrong dates (before 2020 or far future)
    if (d.getFullYear() < 2020 || d.getFullYear() > 2099) return null;
    return d;
  }
  const d = new Date(s);
  if (isNaN(d) || d.getFullYear() < 2020) return null;
  return d;
}

function toYMD(date) {
  if (!date) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── Fetch & parse sheet ─────────────────────────────────────────────────────
async function fetchSheet() {
  const resp = await axios.get(CSV_URL, {
    responseType: 'text',
    timeout: 30000,
    maxRedirects: 10,
    headers: { 'Accept-Charset': 'utf-8' }
  });

  const records = parse(resp.data, {
    columns:          true,
    skip_empty_lines: true,
    trim:             true,
    bom:              true,
    relax_column_count: true
  });

  const rows = [];
  for (const rec of records) {
    const keys = Object.keys(rec);
    // Flexible column access – try named header first, fall back to position
    const get = (name, idx) => (rec[name] || rec[keys[idx]] || '').trim();

    const timestampRaw  = get('Timestamp',                                              0);
    const reportDateRaw = get('לאיזה תאריך ממלאים?',                                   1);
    const command       = get('פיקוד',                                                  2);
    const clinic        = get('מרפאה',                                                  3);
    const statusRaw     = get('מצב המרפאה נכון להיום',                                 4);
    const notes         = get('היית והמרפאה סגורה, מה עשה הרופא.ה והצוות?',           5);

    if (!clinic || !reportDateRaw) continue;

    const reportDate = parseSheetDate(reportDateRaw);
    if (!reportDate) continue;

    const ts = new Date(timestampRaw);

    rows.push({
      timestamp:      isNaN(ts) ? new Date(0) : ts,
      reportDate,
      reportDateStr:  toYMD(reportDate),
      command:        command || 'לא צוין',
      clinic,
      status:         normalizeStatus(statusRaw),
      statusRaw,
      notes
    });
  }
  return rows;
}

async function getCached() {
  if (dataCache.rows && Date.now() - dataCache.timestamp < CACHE_TTL) {
    return dataCache.rows;
  }
  const rows = await fetchSheet();
  dataCache  = { rows, timestamp: Date.now() };
  return rows;
}

// ─── Data processing ─────────────────────────────────────────────────────────

/** Keep only the most-recent row per (clinic, date) */
function dedup(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.clinic}||${r.reportDateStr}`;
    const ex  = map.get(key);
    if (!ex || r.timestamp > ex.timestamp) map.set(key, r);
  }
  return [...map.values()];
}

/** Filter all rows to a date window */
function filterRows(all, start, end) {
  return all.filter(r => {
    if (!r.reportDate) return false;
    if (start && r.reportDate < start) return false;
    if (end   && r.reportDate > end)   return false;
    return true;
  });
}

/** Build the complete stats object returned by the API */
function buildStats(filteredRows, allRows) {
  // Canonical clinic→command mapping (from ALL data)
  const clinicMap = {};
  for (const r of allRows) {
    if (!clinicMap[r.clinic]) clinicMap[r.clinic] = r.command;
  }
  const allClinics = Object.keys(clinicMap);

  const deduped = dedup(filteredRows);

  // --- status totals ---
  const statusCounts = { open: 0, closed: 0, emergency: 0, unknown: 0 };

  // --- per-command breakdown ---
  const commandStats = {};

  // --- per-date breakdown (for range view) ---
  const perDate = {};

  for (const r of deduped) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;

    if (!commandStats[r.command]) {
      commandStats[r.command] = { open: 0, closed: 0, emergency: 0, unknown: 0, total: 0 };
    }
    commandStats[r.command][r.status]++;
    commandStats[r.command].total++;

    if (!perDate[r.reportDateStr]) {
      perDate[r.reportDateStr] = { open: 0, closed: 0, emergency: 0, total: 0 };
    }
    perDate[r.reportDateStr][r.status]++;
    perDate[r.reportDateStr].total++;
  }

  // --- reported / not-reported ---
  const reportedSet = new Set(deduped.map(r => r.clinic));

  const reported = deduped.map(r => ({
    clinic:    r.clinic,
    command:   r.command,
    status:    r.status,
    statusRaw: r.statusRaw,
    notes:     r.notes,
    date:      r.reportDateStr,
    timestamp: r.timestamp.toISOString()
  }));

  const notReported = allClinics
    .filter(c => !reportedSet.has(c))
    .map(c => ({ clinic: c, command: clinicMap[c] }));

  // --- available dates ---
  const dates = [...new Set(allRows.map(r => r.reportDateStr))].filter(Boolean).sort();

  // --- averages for range ---
  const dateKeys     = Object.keys(perDate).sort();
  const avgReported  = dateKeys.length
    ? Math.round(deduped.length / dateKeys.length)
    : deduped.length;

  // --- closed clinic team locations breakdown ---
  // Groups closed clinics by the free-text "what did staff do?" notes field
  const closedBreakdownMap = {};
  for (const r of deduped) {
    if (r.status !== 'closed') continue;
    const reason = normalizeReason(r.notes);
    if (!closedBreakdownMap[reason]) closedBreakdownMap[reason] = [];
    closedBreakdownMap[reason].push({ clinic: r.clinic, command: r.command });
  }
  // Sort by count descending
  const closedBreakdown = Object.entries(closedBreakdownMap)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([reason, clinics]) => ({ reason, clinics, count: clinics.length }));

  return {
    statusCounts,
    commandStats,
    perDate,
    reported,
    notReported,
    closedBreakdown,
    totalReported:    reported.length,
    totalNotReported: notReported.length,
    totalClinics:     allClinics.length,
    dates,
    dateCount:        dateKeys.length,
    avgReported
  };
}

// ─── Express routes ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    const all = await getCached();
    const { date, startDate, endDate } = req.query;

    let start = null, end = null;

    if (date) {
      start = new Date(date);
      end   = new Date(date); end.setHours(23, 59, 59, 999);
    } else if (startDate || endDate) {
      if (startDate) start = new Date(startDate);
      if (endDate)   { end = new Date(endDate); end.setHours(23, 59, 59, 999); }
    }

    const filtered = (start || end) ? filterRows(all, start, end) : all;
    const stats    = buildStats(filtered, all);

    res.json({ success: true, isRange: !!(startDate || endDate), ...stats });
  } catch (err) {
    console.error('[/api/data]', err.message);
    res.status(500).json({ success: false, error: 'שגיאה בטעינת נתונים מ-Google Sheets' });
  }
});

app.get('/api/refresh', async (req, res) => {
  dataCache = { rows: null, timestamp: 0 };
  try {
    const rows = await getCached();
    res.json({ success: true, rowCount: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🦷  Dental Status Dashboard → http://localhost:${PORT}`);
});
