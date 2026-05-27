// ===== LIVE Runner — 本地实时扫描 =====
// 每30秒获取Binance最新K线，检测信号立即执行
// node live_runner.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const http = require('http');

const STATE_FILE = path.join(__dirname, 'paper_state.json');
const STRATEGY_FILE = path.join(__dirname, 'btc_strategy_evolve.json');
const STRATEGY_CODE = path.join(__dirname, 'btc_strategy.js');
const HISTORY_FILE = path.join(__dirname, 'btc_15m_history.json');

// Load strategy engine
const strategyCode = fs.readFileSync(STRATEGY_CODE, 'utf8');
vm.runInThisContext(strategyCode, { filename: 'btc_strategy.js' });

let gStrategy = null;
let gState = null;
let gCandles = null;
let gCtx = null;
let gRegime = { r: 'neutral', v: 0 };
let gRunCount = 0;
let gLastProcessedTime = 0;

function now() { return new Date().toISOString().slice(11, 23); }
function log(msg) { console.log('[' + now() + '] ' + msg); }

// ── Fetch ──
async function fetchRecent15m(limit) {
  const url = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=' + (limit || 150);
  const resp = await fetch(url);
  const raw = await resp.json();
  if (!Array.isArray(raw)) throw new Error('Binance API error: ' + JSON.stringify(raw));
  return raw.map(r => ({
    time: parseInt(r[0]), open: parseFloat(r[1]), high: parseFloat(r[2]),
    low: parseFloat(r[3]), close: parseFloat(r[4]), volume: parseFloat(r[5])
  }));
}

// ── State ──
function loadState() {
  const defaults = {
    balance: 1000, initialCapital: 1000, position: null,
    orders: [], closedTrades: [], equityHistory: [],
    totalTrades: 0, winningTrades: 0, losingTrades: 0, orderIdSeq: 0,
    strategyHistory: [], lastMarketRegime: 'neutral', lastVolatility: 0,
    recentTrades: [], recentTradeFeedback: [], lastRun: null, runCount: 0
  };
  try {
    if (fs.existsSync(STATE_FILE)) {
      return Object.assign({}, defaults, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    }
  } catch(e) { log('State load error: ' + e.message); }
  return defaults;
}

function saveState() {
  const s = gState;
  s.lastRun = new Date().toISOString();
  s.runCount = (s.runCount || 0) + 1;
  if (s.orders.length > 200) s.orders = s.orders.slice(-200);
  if (s.closedTrades.length > 200) s.closedTrades = s.closedTrades.slice(-200);
  if (s.equityHistory.length > 500) s.equityHistory = s.equityHistory.slice(-500);
  if (s.recentTrades.length > 50) s.recentTrades = s.recentTrades.slice(-50);
  if (s.recentTradeFeedback && s.recentTradeFeedback.length > 100) s.recentTradeFeedback = s.recentTradeFeedback.slice(-100);
  if (s.strategyHistory.length > 20) s.strategyHistory = s.strategyHistory.slice(-20);
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  // Also write JS file for file:// HTML access (bypasses fetch() restrictions)
  fs.writeFileSync(path.join(__dirname, 'paper_state.js'), 'window.__paperState=' + JSON.stringify(s) + ';');
}

// ── Strategy ──
function loadStrategy() {
  try {
    if (fs.existsSync(STRATEGY_FILE)) {
      const json = JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf8'));
      if (json.name && json.params && json.entryRules && json.exitRules) {
        const s = createStrategy(json.name, json.version, json.description, json.params, json.entryRules, json.exitRules, json.filterRules);
        s.generation = json.generation || 0;
        s.parentInfo = json.parentInfo || '';
        return s;
      }
    }
  } catch(e) { log('Strategy load error: ' + e.message); }
  return createStrategy();
}

// ── Market regime ──
function detectMarketRegime(candles) {
  if (!candles || candles.length < 50) return { r: 'neutral', v: 0 };
  const len = candles.length;
  const last50 = candles.slice(Math.max(0, len - 50));
  let ma20 = 0, ma20prev = 0;
  for (let i = last50.length - 20; i < last50.length; i++) ma20 += last50[i].close;
  ma20 /= 20;
  for (let i = last50.length - 21; i < last50.length - 1; i++) ma20prev += last50[i].close;
  ma20prev /= 20;
  const slope = (ma20 - ma20prev) / ma20prev;
  const atr = [];
  for (let i = 0; i < last50.length; i++) {
    if (i === 0) { atr.push(last50[i].high - last50[i].low); continue; }
    atr.push(Math.max(last50[i].high - last50[i].low, Math.abs(last50[i].high - last50[i-1].close), Math.abs(last50[i].low - last50[i-1].close)));
  }
  let atrSum = 0;
  for (let i = Math.max(0, atr.length - 14); i < atr.length; i++) atrSum += atr[i];
  const lastATR = atrSum / Math.min(14, atr.length);
  const volatility = !isNaN(lastATR) ? lastATR / candles[candles.length - 1].close : 0;
  let regime = 'neutral';
  if (slope > 0.003) regime = 'bull';
  else if (slope < -0.003) regime = 'bear';
  else regime = 'ranging';
  return { r: regime, v: volatility };
}

// ── Open position ──
function openPosition(signal, candle, idx) {
  const s = gStrategy;
  const isShort = signal.type === 'SELL';
  const lev = s.params.leverage || 1;
  const margin = gState.balance * s.params.positionSize;
  const qty = (margin * lev) / candle.close;
  if (qty * candle.close < 10) { log('  Order too small, skip'); return; }

  gState.position = {
    side: isShort ? 'SHORT' : 'LONG',
    qty: qty, entryPrice: candle.close,
    entryTime: candle.time, _entryIdx: idx,
    _trailHi: isShort ? undefined : candle.high,
    _trailLo: isShort ? candle.low : undefined,
    margin: margin, leverage: lev,
    _entryRuleType: signal.reason.split(':')[0] || 'unknown',
    _entryRegime: gRegime.r,
    _entryVolatility: gRegime.v,
    _entryAO: gCtx && gCtx.ao ? (gCtx.ao[idx] || 0) : 0
  };
  gState.balance -= margin;
  gState.orders.push({
    id: ++gState.orderIdSeq,
    time: new Date(candle.time).toISOString().slice(11, 19),
    side: isShort ? 'Sell (short)' : 'Buy (long)',
    price: '$' + candle.close.toFixed(1), qty: qty.toFixed(6) + ' BTC',
    margin: '$' + margin.toFixed(2), leverage: lev + 'x',
    status: 'filled', type: 'market', reason: signal.reason
  });
  gState.totalTrades++;
  log('>>> ' + (isShort ? '🔴 SHORT' : '🟢 LONG') + ' @' + candle.close.toFixed(0) + ' x' + qty.toFixed(5) + ' margin=$' + margin.toFixed(0) + ' ' + lev + 'x');
  log('    ' + signal.reason + ' [s' + signal.strength + ']');
  saveState();
}

// ── Close position ──
function closePosition(exitReason, candle) {
  const pos = gState.position;
  const margin = pos.margin || (gState.initialCapital * gStrategy.params.positionSize);
  const lev = pos.leverage || 1;

  let pnl;
  if (pos.side === 'SHORT') {
    pnl = (pos.entryPrice - candle.close) * pos.qty;
  } else {
    pnl = (candle.close - pos.entryPrice) * pos.qty;
  }
  if (pnl < -margin) pnl = -margin;
  gState.balance += margin + pnl;
  const pnlPctNum = margin > 0 ? (pnl / margin * 100) : 0;
  const barsHeld = (gCandles.length - 1) - (pos._entryIdx || 0);

  const exitSide = pos.side === 'SHORT' ? 'Buy (cover)' : 'Sell';
  gState.orders.push({
    id: ++gState.orderIdSeq,
    time: new Date(candle.time).toISOString().slice(11, 19),
    side: exitSide,
    price: '$' + candle.close.toFixed(1), qty: pos.qty.toFixed(6) + ' BTC',
    status: 'filled', type: 'market', reason: exitReason
  });
  gState.closedTrades.push({
    entryTime: new Date(pos.entryTime).toISOString().slice(11, 19),
    exitTime: new Date(candle.time).toISOString().slice(11, 19),
    side: pos.side === 'SHORT' ? 'Short' : 'Long',
    entryPrice: pos.entryPrice, exitPrice: candle.close,
    qty: pos.qty, margin: Math.round(margin * 100) / 100,
    pnl: Math.round(pnl * 100) / 100,
    pnlPct: pnlPctNum.toFixed(1) + '%', leverage: lev + 'x',
    reason: exitReason, barsHeld: barsHeld
  });
  if (pnl > 0) gState.winningTrades++; else gState.losingTrades++;
  gState.recentTrades.push({ pnl: Math.round(pnl * 100) / 100, pnlPct: pnlPctNum.toFixed(1) + '%', reason: exitReason, time: Date.now() });
  if (gState.recentTrades.length > 50) gState.recentTrades.shift();

  if (!gState.recentTradeFeedback) gState.recentTradeFeedback = [];
  gState.recentTradeFeedback.push({
    entryType: pos._entryRuleType || 'unknown',
    entryIdx: pos._entryIdx, side: pos.side,
    pnl: Math.round(pnl * 100) / 100,
    pnlPct: parseFloat(pnlPctNum.toFixed(1)),
    reason: exitReason,
    entryRegime: pos._entryRegime || 'unknown',
    entryVolatility: pos._entryVolatility || 0,
    entryAO: pos._entryAO || 0,
    entryTime: pos.entryTime, exitTime: candle.time, barsHeld: barsHeld
  });
  if (gState.recentTradeFeedback.length > 100) gState.recentTradeFeedback = gState.recentTradeFeedback.slice(-100);

  log('<<< ' + (pnl > 0 ? '💰 PROFIT' : '💸 LOSS') + ' @' + candle.close.toFixed(0) + ' P&L:$' + pnl.toFixed(2) + ' (' + pnlPctNum.toFixed(1) + '%) ' + exitReason);
  gState.position = null;
  saveState();
}

// ── Check exit conditions ──
function checkExit(candle) {
  const pos = gState.position;
  const s = gStrategy;
  const margin = pos.margin || (gState.initialCapital * s.params.positionSize);
  const lev = pos.leverage || 1;

  // Stop loss
  const slPrice = pos.side === 'SHORT'
    ? pos.entryPrice * (1 + s.params.stopLoss)
    : pos.entryPrice * (1 - s.params.stopLoss);
  const worstPrice = pos.side === 'SHORT' ? candle.high : candle.low;
  if (pos.side === 'SHORT' ? worstPrice >= slPrice : worstPrice <= slPrice) {
    return 'Stop Loss (margin:' + (s.params.stopLoss * 100).toFixed(1) + '% ×' + lev + 'x)';
  }

  // Take profit
  const tpPrice = pos.side === 'SHORT'
    ? pos.entryPrice * (1 - s.params.takeProfit)
    : pos.entryPrice * (1 + s.params.takeProfit);
  const bestPrice = pos.side === 'SHORT' ? candle.low : candle.high;
  if (pos.side === 'SHORT' ? bestPrice <= tpPrice : bestPrice >= tpPrice) {
    return 'Take Profit (margin:' + (s.params.takeProfit * 100).toFixed(1) + '% ×' + lev + 'x)';
  }

  // Trailing stop
  if (pos.side === 'SHORT') {
    if (!pos._trailLo || pos._trailLo > candle.low) pos._trailLo = candle.low;
    const trailSl = pos._trailLo * (1 + s.params.trailStop);
    if (candle.high >= trailSl) return 'Trailing Stop SHORT';
  } else {
    if (!pos._trailHi || pos._trailHi < candle.high) pos._trailHi = candle.high;
    const trailSl = pos._trailHi * (1 - s.params.trailStop);
    if (candle.low <= trailSl) return 'Trailing Stop LONG';
  }

  // Signal reversal (strength 3+)
  const lastIdx = gCandles.length - 1;
  const sig = gStrategy.generateSignal(gCandles, lastIdx, gCtx);
  if (sig && sig.strength >= 3 &&
    ((pos.side === 'LONG' && sig.type === 'SELL') || (pos.side === 'SHORT' && sig.type === 'BUY'))) {
    return 'Signal Reversal: ' + sig.reason;
  }

  // Max bars
  if (s.params.maxBars && pos._entryIdx !== undefined) {
    const held = gCandles.length - 1 - pos._entryIdx;
    if (held >= s.params.maxBars) return 'Max bars (' + s.params.maxBars + ')';
  }

  return null;
}

// ── Main scan loop ──
async function scan() {
  try {
    // Fetch latest candles
    const fresh = await fetchRecent15m(150);
    const latestTime = fresh[fresh.length - 1].time;

    // Skip if same candle as last scan (no new bar yet)
    if (latestTime === gLastProcessedTime && gState.position) {
      // Still check exit on existing position with latest price
      if (gState.position) {
        const reasons = checkExit(fresh[fresh.length - 1]);
        if (reasons) closePosition(reasons, fresh[fresh.length - 1]);
      }
      return;
    }

    gLastProcessedTime = latestTime;
    gCandles = fresh;
    gCtx = gStrategy._buildContext(fresh);
    gRegime = detectMarketRegime(fresh);

    const lastIdx = fresh.length - 1;
    const lastCandle = fresh[lastIdx];

    // Update equity snapshot
    const equity = gState.balance + (gState.position
      ? gState.position.margin + ((gState.position.side === 'SHORT'
        ? gState.position.entryPrice - lastCandle.close
        : lastCandle.close - gState.position.entryPrice) * gState.position.qty)
      : 0);
    const lastEq = gState.equityHistory.length > 0 ? gState.equityHistory[gState.equityHistory.length - 1] : null;
    if (!lastEq || lastEq.time < lastCandle.time) {
      gState.equityHistory.push({ time: lastCandle.time, equity: Math.round(equity * 100) / 100 });
      if (gState.equityHistory.length > 500) gState.equityHistory.shift();
    } else {
      lastEq.equity = Math.round(equity * 100) / 100;
    }
    saveState();

    // ── Check exit if holding position ──
    if (gState.position) {
      const exitReason = checkExit(lastCandle);
      if (exitReason) {
        closePosition(exitReason, lastCandle);
      }
    }
    // ── Check entry if no position ──
    else {
      const signal = gStrategy.generateSignal(fresh, lastIdx, gCtx);
      if (signal && (signal.type === 'BUY' || signal.type === 'SELL')) {
        openPosition(signal, lastCandle, lastIdx);
      }
    }
  } catch(e) {
    log('Scan error: ' + e.message);
  }
}

// ── Status display ──
function printStatus() {
  gRunCount++;
  const pos = gState.position;
  let posStr = '无持仓';
  if (pos) {
    const lastPrice = gCandles ? gCandles[gCandles.length - 1].close : pos.entryPrice;
    const pnl = pos.side === 'SHORT'
      ? (pos.entryPrice - lastPrice) * pos.qty
      : (lastPrice - pos.entryPrice) * pos.qty;
    const pnlPct = pos.margin > 0 ? (pnl / pos.margin * 100).toFixed(1) : 0;
    posStr = (pos.side === 'SHORT' ? '🔴 SHORT' : '🟢 LONG') + ' @' + pos.entryPrice.toFixed(0) + ' | 现价:' + lastPrice.toFixed(0) + ' | 浮动:' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + ' (' + (pnl >= 0 ? '+' : '') + pnlPct + '%)';
  }
  const equity = gState.balance + (pos ? (pos.margin + ((pos.side === 'SHORT'
    ? pos.entryPrice - (gCandles ? gCandles[gCandles.length - 1].close : pos.entryPrice)
    : (gCandles ? gCandles[gCandles.length - 1].close : pos.entryPrice) - pos.entryPrice) * pos.qty)) : 0);
  const totalPnl = equity - gState.initialCapital;

  process.stdout.write('\r  [' + now() + '] #' + gRunCount + ' | 权益:$' + equity.toFixed(0) + ' (' + (totalPnl>=0?'+':'') + '$' + totalPnl.toFixed(0) + ') | ' + gState.closedTrades.length + '笔平仓 | ' + posStr + '    ');
}

// ── HTTP Server (serve UI directory) ──
function startHttpServer(port) {
  const MIME = {
    '.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json;charset=utf-8',
    '.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'
  };
  const server = http.createServer((req, res) => {
    try {
      let urlPath = req.url.split('?')[0];
      // Normalize: / or /btc_trading_demo.html → serve the HTML
      if (urlPath === '/' || urlPath === '') urlPath = '/btc_trading_demo.html';
      let filePath = path.join(__dirname, urlPath);
      // Security: prevent directory traversal
      if (filePath.indexOf(__dirname) !== 0) { res.writeHead(403); return res.end('Forbidden'); }
      const ext = path.extname(filePath).toLowerCase();
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch(e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end('Not found: ' + req.url); }
      else { res.writeHead(500); res.end('Server error: ' + e.message); }
    }
  });
  server.listen(port, () => {
    log('');
    log('═══════════════════════════════════════════');
    log('  Web UI: http://localhost:' + port + '/');
    log('  浏览器打开这个地址即可看到实时交易面板');
    log('═══════════════════════════════════════════');
    log('');
  });
  return server;
}

// ── Main ──
async function main() {
  const HTTP_PORT = 8080;
  startHttpServer(HTTP_PORT);

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   BTC 实时交易机器人 — 混沌操作法        ║');
  console.log('║   每30秒扫描Binance 15分钟K线            ║');
  console.log('║   信号出现→立即执行  止损80% 止盈200%    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  gState = loadState();
  gStrategy = loadStrategy();
  log('策略: ' + gStrategy.name + ' v' + gStrategy.version);
  log('过滤器: ' + (gStrategy.filterRules.filter(r => r.enabled).map(r => r.type).join(', ') || '无'));
  log('初始资金: $' + gState.initialCapital + ' | 余额: $' + gState.balance.toFixed(2));
  log('杠杆: ' + gStrategy.params.leverage + 'x | 止损: ' + (gStrategy.params.stopLoss * 100).toFixed(1) + '% | 止盈: ' + (gStrategy.params.takeProfit * 100).toFixed(1) + '%');
  log('持仓比例: ' + (gStrategy.params.positionSize * 100).toFixed(0) + '%');
  log('');
  log('开始实时扫描... (Ctrl+C 停止)');
  log('');

  // Initial fetch
  await scan().catch(() => {});
  printStatus();

  // Scan loop: every 30 seconds
  const LOOP_INTERVAL = 30000;
  setInterval(async () => {
    await scan().catch(() => {});
    printStatus();
  }, LOOP_INTERVAL);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('');
  log('停止扫描。最终状态已保存。');
  saveState();
  process.exit(0);
});
