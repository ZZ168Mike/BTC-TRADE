// ===== BTC 15m Historical Data Downloader =====
// Downloads 15m candles from Binance API, saves to btc_15m_history.json
// Binance has years of historical data, 1000 candles per request
// Usage: node download_history.js [startDate] [endDate]
//   startDate: YYYY-MM-DD (default: 2 years ago)
//   endDate:   YYYY-MM-DD (default: today)
// Resume: reads existing file, skips already-downloaded data

const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'btc_15m_history.json');
const BINANCE_URL = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1000';
const DELAY_MS = 200;

// Parse command line args
const args = process.argv.slice(2);
const endDate = args[1] ? new Date(args[1] + 'T23:59:59Z') : new Date();
const startDate = args[0] ? new Date(args[0] + 'T00:00:00Z') : new Date(endDate.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);

console.log('BTC 15m Historical Data Downloader (Binance)');
console.log('  Start:', startDate.toISOString().slice(0, 10));
console.log('  End:  ', endDate.toISOString().slice(0, 10));
console.log('  Output:', OUTPUT_FILE);
console.log('');

// Load existing data
let candles = [];
let existingTimes = new Set();
if (fs.existsSync(OUTPUT_FILE)) {
  try {
    candles = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    candles.forEach(c => existingTimes.add(c.time));
    console.log('Loaded existing: ' + candles.length.toLocaleString() + ' candles');
    if (candles.length > 0) {
      console.log('  Range: ' + new Date(candles[0].time).toISOString().slice(0, 16) +
                  ' ~ ' + new Date(candles[candles.length - 1].time).toISOString().slice(0, 16));
    }
  } catch(e) { console.log('Could not parse existing file, starting fresh'); candles = []; }
}

function save() {
  candles.sort((a, b) => a.time - b.time);
  let seen = new Set();
  candles = candles.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
  existingTimes = seen;
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(candles));
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function formatDuration(ms) {
  if (ms < 60000) return Math.round(ms/1000) + 's';
  if (ms < 3600000) return Math.round(ms/60000) + 'm' + Math.round(ms%60000/1000) + 's';
  const h = Math.floor(ms/3600000), m = Math.round((ms%3600000)/60000);
  return h + 'h' + m + 'm';
}

function fmtDate(ts) { return new Date(ts).toISOString().slice(0, 16); }

async function download() {
  const totalMinutes = Math.round((endDate - startDate) / 60000);
  const targetCandles = Math.round(totalMinutes / 15);
  console.log('Target: ~' + targetCandles.toLocaleString() + ' candles (' + formatDuration(endDate - startDate) + ' of 15m bars)');
  console.log('');

  let currentEnd = endDate.getTime();
  let batchCount = 0;
  let errorCount = 0;
  let startTime = Date.now();
  let newCandles = 0;
  let reachedStart = false;

  while (!reachedStart && errorCount < 10) {
    // Binance returns oldest-first. Use endTime to paginate backwards.
    let url = BINANCE_URL + '&endTime=' + currentEnd;

    try {
      let resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      let json = await resp.json();
      if (!Array.isArray(json)) throw new Error('Unexpected response');
      if (json.length === 0) break;

      let added = 0;
      let batchEarliest = Infinity;

      json.forEach(row => {
        let ts = parseInt(row[0]);
        if (ts < batchEarliest) batchEarliest = ts;
        if (ts < startDate.getTime()) { reachedStart = true; return; }
        if (existingTimes.has(ts)) return;
        candles.push({
          time: ts,
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: parseFloat(row[4]),
          volume: parseFloat(row[5])
        });
        existingTimes.add(ts);
        added++;
        newCandles++;
      });

      batchCount++;

      // Move endTime to just before the earliest candle in this batch
      if (batchEarliest < Infinity) {
        currentEnd = batchEarliest - 1;
      }
      if (reachedStart || json.length < 1000) break;

      // Progress
      let total = candles.length;
      let pct = Math.min(100, Math.round(total / targetCandles * 100));
      let elapsed = Date.now() - startTime;
      let rate = newCandles / (elapsed / 1000);
      let remaining = Math.max(0, targetCandles - total);
      let eta = rate > 0 ? formatDuration(remaining / rate * 1000) : '?';

      let bar = '';
      for (let i = 0; i < 30; i++) bar += i < Math.round(pct/100*30) ? String.fromCharCode(0x2588) : String.fromCharCode(0x2591);
      process.stdout.write('\r[' + bar + '] ' + pct + '% | ' +
        total.toLocaleString() + ' of ' + targetCandles.toLocaleString() + ' | +' + added + ' new | ' +
        'batch #' + batchCount + ' | ' + fmtDate(batchEarliest) + ' | ETA ' + eta + '    ');

      errorCount = 0;

      if (batchCount % 5 === 0) save();

      await sleep(DELAY_MS);
    } catch(e) {
      errorCount++;
      console.log('\n  Error #' + errorCount + ': ' + e.message);
      await sleep(3000);
    }
  }

  save();

  console.log('\n');
  console.log('Download complete!');
  console.log('  Total candles: ' + candles.length.toLocaleString());
  console.log('  New this run:  ' + newCandles.toLocaleString());
  if (candles.length > 0) {
    console.log('  Time range:    ' + fmtDate(candles[0].time) + ' ~ ' + fmtDate(candles[candles.length - 1].time));
  }
  console.log('  File size:     ' + (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2) + ' MB');
  console.log('  Saved to:      ' + OUTPUT_FILE);
}

download().catch(e => { console.error('Fatal error:', e.message); process.exit(1); });
