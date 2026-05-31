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
let gCooldownTime = 0; // 平仓后冷却期，防止立即反向开仓

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

// ── Trend detection (长周期趋势判断，影响仓位大小) ──
function detectTrend() {
  if (!gCandles || gCandles.length < 90) return { direction: 'neutral', strength: 0, longBias: 1.0, shortBias: 1.0 };
  const len = gCandles.length;
  // Use last 80 candles for trend (~20 hours of 15m data)
  const lookback = Math.min(80, len);
  const recent = gCandles.slice(len - lookback);

  // Calculate MA20 and MA50 on close prices
  const closes = recent.map(c => c.close);
  let ma20 = 0, ma50 = 0;
  for (let i = recent.length - 20; i < recent.length; i++) ma20 += closes[i];
  ma20 /= 20;
  if (recent.length >= 50) {
    for (let i = recent.length - 50; i < recent.length; i++) ma50 += closes[i];
    ma50 /= 50;
  }

  // Alligator alignment check
  const mp = recent.map(c => (c.high + c.low) / 2);
  function sma(arr, p) {
    const r = [];
    for (let i = 0; i < arr.length; i++) {
      if (i < p) { r.push(NaN); continue; }
      if (i === p) { let s = 0; for (let j = 0; j < p; j++) s += arr[i - j]; r.push(s / p); }
      else r.push((r[i - 1] * (p - 1) + arr[i]) / p);
    }
    return r;
  }
  const jaw = sma(mp, 13), teeth = sma(mp, 8), lips = sma(mp, 5);
  const last = recent.length - 1;
  const jawVal = jaw[last], teethVal = teeth[last], lipsVal = lips[last];

  // AO check
  const aoFast = sma(mp, 5), aoSlow = sma(mp, 34);
  const aoVal = (!isNaN(aoFast[last]) && !isNaN(aoSlow[last])) ? aoFast[last] - aoSlow[last] : 0;
  const aoPrev = (!isNaN(aoFast[last - 3]) && !isNaN(aoSlow[last - 3])) ? aoFast[last - 3] - aoSlow[last - 3] : 0;

  // Score trend direction
  let bullScore = 0, bearScore = 0;

  // MA alignment
  if (ma20 > ma50 && ma50 > 0) bullScore += 2;
  else if (ma20 < ma50 && ma50 > 0) bearScore += 2;

  // Alligator alignment
  if (!isNaN(lipsVal) && !isNaN(teethVal) && !isNaN(jawVal)) {
    if (lipsVal > teethVal && teethVal > jawVal) bullScore += 3;
    else if (lipsVal < teethVal && teethVal < jawVal) bearScore += 3;
    // Price relative to alligator
    const price = closes[last];
    if (price > lipsVal) bullScore += 1;
    else if (price < lipsVal) bearScore += 1;
  }

  // AO direction
  if (!isNaN(aoVal)) {
    if (aoVal > 0) bullScore += 1;
    else if (aoVal < 0) bearScore += 1;
    if (aoVal > aoPrev) bullScore += 1;
    else if (aoVal < aoPrev) bearScore += 1;
  }

  // Determine bias
  let direction, longBias, shortBias;
  if (bullScore > bearScore + 2) {
    direction = 'bull';
    const str = Math.min(1, (bullScore - bearScore) / 6);
    longBias = 1.0 + str * 0.5;   // max 1.5x for LONG in bullish
    shortBias = 1.0 - str * 0.3;  // min 0.7x for SHORT in bullish
  } else if (bearScore > bullScore + 2) {
    direction = 'bear';
    const str = Math.min(1, (bearScore - bullScore) / 6);
    longBias = 1.0 - str * 0.3;   // min 0.7x for LONG in bearish
    shortBias = 1.0 + str * 0.5;  // max 1.5x for SHORT in bearish
  } else {
    direction = 'neutral';
    longBias = 1.0; shortBias = 1.0;
  }

  return {
    direction,
    strength: Math.abs(bullScore - bearScore) / 8,
    longBias: +longBias.toFixed(2),
    shortBias: +shortBias.toFixed(2),
    details: 'bull=' + bullScore + ' bear=' + bearScore + ' MA20=' + ma20.toFixed(0) + '/MA50=' + ma50.toFixed(0) + ' AO=' + aoVal.toFixed(0)
  };
}

// ── Open position (support pyramid adding) ──
function openPosition(signal, candle, idx) {
  const s = gStrategy;
  const isShort = signal.type === 'SELL';
  const lev = s.params.leverage || 200;
  // 5% of balance, capped at $100
  const margin = Math.min(gState.balance * (s.params.positionSize || 0.05), s.params.maxMargin || 100);
  const qty = (margin * lev) / candle.close;
  if (qty * candle.close < 10) { log('  Order too small, skip'); return; }
  // Check if entry type strength is enough for chaos entry
  const minScore = signal.strength * 1.0; // at least strength 1

  const existingPos = gState.position;
  if (existingPos && existingPos.side === (isShort ? 'SHORT' : 'LONG')) {
    // 金字塔加仓：同向信号，增加一层仓位
    const maxLayers = s.params.maxPositions || 3;
    const currentLayers = existingPos._layers || 1;
    if (currentLayers >= maxLayers) { log('  已达最大仓位层数(' + maxLayers + ')，不加仓'); return; }
    // Weighted average entry price
    const totalQty = existingPos.qty + qty;
    existingPos.entryPrice = (existingPos.entryPrice * existingPos.qty + candle.close * qty) / totalQty;
    existingPos.qty = totalQty;
    existingPos.margin += margin;
    existingPos._layers = currentLayers + 1;
    existingPos._entryIdx = idx; // update to latest entry
    gState.balance -= margin;
    gState.orders.push({
      id: ++gState.orderIdSeq,
      time: new Date(candle.time).toISOString().slice(11, 19),
      side: isShort ? 'Sell (short+#' + existingPos._layers + ')' : 'Buy (long+#' + existingPos._layers + ')',
      price: '$' + candle.close.toFixed(1), qty: qty.toFixed(6) + ' BTC',
      margin: '$' + margin.toFixed(2), leverage: lev + 'x',
      status: 'filled', type: 'market', reason: '加仓: ' + signal.reason
    });
    gState.totalTrades++;
    log('>>> 📈 加仓 #' + existingPos._layers + ' ' + (isShort ? '🔴 SHORT' : '🟢 LONG') + ' @' + candle.close.toFixed(0) + ' x' + qty.toFixed(5) + ' margin=$' + margin.toFixed(0));
    log('    总仓位:' + totalQty.toFixed(5) + ' BTC 均价:' + existingPos.entryPrice.toFixed(0) + ' 总保证金:$' + existingPos.margin.toFixed(0) + ' 层数:' + existingPos._layers);
    saveState();
  } else {
    // 新建仓位
    gState.position = {
      side: isShort ? 'SHORT' : 'LONG',
      qty: qty, entryPrice: candle.close,
      entryTime: candle.time, _entryIdx: idx, _layers: 1,
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
    log('    ' + signal.reason + ' [s' + signal.strength + '] 保证金上限:$' + (s.params.maxMargin||100));
    saveState();
  }
}

// ── Close position ──
function closePosition(exitReason, candle, optionalPrice) {
  const pos = gState.position;
  const exitPrice = optionalPrice || candle.close;
  const margin = pos.margin || (gState.initialCapital * gStrategy.params.positionSize);
  const lev = pos.leverage || 1;

  let pnl;
  if (pos.side === 'SHORT') {
    pnl = (pos.entryPrice - exitPrice) * pos.qty;
  } else {
    pnl = (exitPrice - pos.entryPrice) * pos.qty;
  }
  if (pnl < -margin) pnl = -margin;
  gState.balance += margin + pnl;
  const pnlPctNum = margin > 0 ? (pnl / margin * 100) : 0;
  const barsHeld = (gCandles.length - 1) - (pos._entryIdx || 0);
  const layers = pos._layers || 1;

  const exitSide = pos.side === 'SHORT' ? 'Buy (cover)' : 'Sell';
  gState.orders.push({
    id: ++gState.orderIdSeq,
    time: new Date(candle.time).toISOString().slice(11, 19),
    side: exitSide,
    price: '$' + exitPrice.toFixed(1), qty: pos.qty.toFixed(6) + ' BTC',
    status: 'filled', type: 'market', reason: exitReason
  });
  gState.closedTrades.push({
    entryTime: new Date(pos.entryTime).toISOString().slice(11, 19),
    exitTime: new Date(candle.time).toISOString().slice(11, 19),
    side: pos.side === 'SHORT' ? 'Short' : 'Long',
    entryPrice: pos.entryPrice, exitPrice: exitPrice,
    qty: pos.qty, margin: Math.round(margin * 100) / 100,
    pnl: Math.round(pnl * 100) / 100,
    pnlPct: pnlPctNum.toFixed(1) + '%', leverage: lev + 'x',
    reason: exitReason, barsHeld: barsHeld, layers: layers
  });
  if (pnl > 0) gState.winningTrades++; else gState.losingTrades++;
  gState.recentTrades.push({ pnl: Math.round(pnl * 100) / 100, pnlPct: pnlPctNum.toFixed(1) + '%', reason: exitReason, time: Date.now() });
  if (gState.recentTrades.length > 50) gState.recentTrades.shift();

  if (!gState.recentTradeFeedback) gState.recentTradeFeedback = [];
  gState.recentTradeFeedback.push({
    entryType: pos._entryRuleType || 'unknown',
    entryIdx: pos._entryIdx, side: pos.side, layers: layers,
    pnl: Math.round(pnl * 100) / 100,
    pnlPct: parseFloat(pnlPctNum.toFixed(1)),
    reason: exitReason,
    entryRegime: pos._entryRegime || 'unknown',
    entryVolatility: pos._entryVolatility || 0,
    entryAO: pos._entryAO || 0,
    entryTime: pos.entryTime, exitTime: candle.time, barsHeld: barsHeld
  });
  if (gState.recentTradeFeedback.length > 100) gState.recentTradeFeedback = gState.recentTradeFeedback.slice(-100);

  log('<<< ' + (pnl > 0 ? '💰 PROFIT' : '💸 LOSS') + ' @' + exitPrice.toFixed(0) + ' P&L:$' + pnl.toFixed(2) + ' (' + pnlPctNum.toFixed(1) + '%) ' + exitReason + (layers>1?' ['+layers+'层]':''));
  gState.position = null;
  gCooldownTime = candle.time; // 冷却期：等下一根K线再开仓
  saveState();
}

// ── Check exit conditions (纯混沌操作法离场) ──
function checkExit(candle) {
  const pos = gState.position;

  // Use strategy's exit rules (chaos-based: teeth/lips cross, AO reverse, fractal reverse, alligator flip)
  const lastIdx = gCandles.length - 1;
  const exitReason = gStrategy._checkExit(gCandles, lastIdx, pos, gCtx);
  if (exitReason) return exitReason;

  return null;
}

// ── Check if should add to position (AC三步加仓法) ──
function checkAddPosition(signal, candle, idx) {
  const pos = gState.position;
  if (!pos) return false;
  const s = gStrategy;
  const maxLayers = s.params.maxLayers || 3;
  if ((pos._layers || 1) >= maxLayers) return false;

  // Use strategy's AC-based add signal check
  if (s.checkACAdd && gCtx) {
    return s.checkACAdd(gCandles, idx, pos, gCtx);
  }
  return false;
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

    // ── Holding position: check exit + add position ──
    if (gState.position) {
      const exitReason = checkExit(lastCandle);
      if (exitReason) {
        closePosition(exitReason, lastCandle);
      } else {
        // Check for pyramid add-position signal
        const sig = gStrategy.generateSignal(fresh, lastIdx, gCtx);
        if (sig && checkAddPosition(sig, lastCandle, lastIdx)) {
          openPosition(sig, lastCandle, lastIdx);
        }
      }
    }
    // ── No position: check entry (with cooldown after close) ──
    else {
      // 平仓后冷却：不立即反向开仓，等待下一根K线的信号
      if (gCooldownTime > 0 && lastCandle.time <= gCooldownTime) {
        // Still in cooldown — skip entry on this candle
      } else {
        const signal = gStrategy.generateSignal(fresh, lastIdx, gCtx);
        if (signal && (signal.type === 'BUY' || signal.type === 'SELL')) {
          gCooldownTime = 0; // clear cooldown
          openPosition(signal, lastCandle, lastIdx);
        }
      }
    }
  } catch(e) {
    log('Scan error: ' + e.message);
  }
  // Trigger AI evolution check after each scan
  aiEvolve().catch(() => {});
}

// ═══════════════════════════════════════════════════════
// ── AI-Driven Strategy Evolution (Claude API) ──
// 触发条件: ≥3笔亏损 + 距上次进化≥1小时 + 有API Key
// ═══════════════════════════════════════════════════════
async function aiEvolve() {
  const allFeedback = gState.recentTradeFeedback || [];
  const losses = allFeedback.filter(t => t.pnl < 0).slice(-15);
  if (losses.length < 3) return;

  // Throttle: max once per hour
  if (!gState._lastAIEvolve) gState._lastAIEvolve = 0;
  if (Date.now() - gState._lastAIEvolve < 3600000) return;

  // API key: env var or .api_key file
  const apiKey = process.env.ANTHROPIC_API_KEY
    || (fs.existsSync(path.join(__dirname, '.api_key'))
        ? fs.readFileSync(path.join(__dirname, '.api_key'), 'utf8').trim() : null);
  if (!apiKey) {
    if (!gState._warnedNoAPIKey) {
      log('AI进化: 未找到 ANTHROPIC_API_KEY 环境变量或 .api_key 文件，跳过AI分析');
      log('  设置方法: set ANTHROPIC_API_KEY=sk-ant-...  或创建 .api_key 文件');
      gState._warnedNoAPIKey = true;
    }
    return;
  }
  gState._warnedNoAPIKey = false;

  log('');
  log('══════ AI策略进化分析 ══════');
  gState._lastAIEvolve = Date.now();

  // Gather all trades for context
  const recentTrades = allFeedback.slice(-30);
  const wins = recentTrades.filter(t => t.pnl > 0);
  const lossTrades = recentTrades.filter(t => t.pnl < 0);
  const totalPnl = recentTrades.reduce((s, t) => s + (t.pnl || 0), 0);

  // Build strategy snapshot
  const strategySnapshot = {
    name: gStrategy.name, version: gStrategy.version, generation: gStrategy.generation || 0,
    params: gStrategy.params,
    entryRules: gStrategy.entryRules.map(r => ({ id: r.id, type: r.type, weight: r.weight, enabled: r.enabled, params: r.params })),
    exitRules: gStrategy.exitRules.map(r => ({ id: r.id, type: r.type, weight: r.weight, enabled: r.enabled })),
    filterRules: gStrategy.filterRules.map(r => ({ id: r.id, type: r.type, weight: r.weight, enabled: r.enabled }))
  };

  // Trade detail for AI — BOTH winning and losing
  const lossDetails = losses.slice(-10).map(t => ({
    entryType: t.entryType, side: t.side || 'unknown',
    pnl: '$' + (t.pnl || 0).toFixed(2), pnlPct: (t.pnlPct || 0).toFixed(1) + '%',
    exitReason: t.reason, barsHeld: t.barsHeld || 0,
    marketRegime: t.entryRegime || 'unknown', volatility: ((t.entryVolatility || 0) * 100).toFixed(2) + '%',
    entryAO: (t.entryAO || 0).toFixed(0)
  }));
  const winDetails = wins.slice(-5).map(t => ({
    entryType: t.entryType, side: t.side || 'unknown',
    pnl: '$' + (t.pnl || 0).toFixed(2), pnlPct: (t.pnlPct || 0).toFixed(1) + '%',
    exitReason: t.reason, barsHeld: t.barsHeld || 0,
    marketRegime: t.entryRegime || 'unknown'
  }));

  // Anti-spiral: check last 3 evolution directions
  if (!gState._evoHistory) gState._evoHistory = [];
  const recentEvos = gState._evoHistory.slice(-3);
  const allTighten = recentEvos.length >= 3 && recentEvos.every(e => e.direction === 'tighten');
  const allLoosen = recentEvos.length >= 3 && recentEvos.every(e => e.direction === 'loosen');

  const trend = detectTrend();
  const marketCtx = {
    trend: trend.direction, trendStrength: trend.strength.toFixed(2),
    volatility: (gRegime.v * 100).toFixed(2) + '%', regime: gRegime.r,
    balance: '$' + gState.balance.toFixed(2), initialCapital: '$' + gState.initialCapital,
    totalReturn: ((gState.balance - gState.initialCapital) / gState.initialCapital * 100).toFixed(1) + '%',
    stats: { total: allFeedback.length, wins: wins.length, losses: lossTrades.length, winRate: (wins.length/(wins.length+lossTrades.length)*100).toFixed(1)+'%' }
  };

  const antiSpiralWarning = allTighten
    ? '\n⚠️ 严重警告：过去3代都在收紧（降权重、开过滤）。这是负反馈螺旋！本次必须反向操作：提高权重、关闭不必要的过滤器、放大交易机会。目标是找到能赚钱的信号，不是消灭所有信号。'
    : (allLoosen ? '\n⚠️ 提示：过去3代都在放松，注意不要过度激进。' : '');

  const prompt = `你是比特币交易策略优化专家。威廉姆斯混沌操作法（Alligator+AO+Fractals+AC），200倍杠杆，双向交易，模拟盘。

## 核心目标：增加盈利，不是减少亏损
模拟盘的意义是用亏损换取经验和数据。你的任务是：
1. 分析哪些入场信号在赚钱 → 加强它们
2. 分析哪些出场时机太早/太晚 → 调整它们
3. 找到盈利模式并放大，而不是收缩交易
${antiSpiralWarning}

## 策略配置
\`\`\`json
${JSON.stringify(strategySnapshot, null, 2)}
\`\`\`

## 市场环境
\`\`\`json
${JSON.stringify(marketCtx, null, 2)}
\`\`\`

## 盈利交易（这些是应该强化的模式！）
\`\`\`json
${JSON.stringify(winDetails, null, 2)}
\`\`\`

## 亏损交易（需要改进的）
\`\`\`json
${JSON.stringify(lossDetails, null, 2)}
\`\`\`

## 约束
- leverage=200/positionSize=0.05/maxLayers=3 不可变
- 5个入场全部enabled=true, 4个核心离场全部enabled=true
- 入场权重范围: 0.5~2.0（最低0.5，不能更低！）
- 离场权重范围: 0.3~2.0
- 每代只调整2-4个参数，小步快跑
- 如果盈利交易集中在某类信号，必须提高其权重

返回纯JSON:
{"analysis":"一句话分析","paramChanges":{"param":value},"enableFilters":[],"disableFilters":[],"weightChanges":{"ruleType":0.8}}`;

  try {
    log('  正在调用DeepSeek V4 Pro分析...');
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 2000,
        temperature: 0.3,
        messages: [
          { role: 'system', content: '你是比特币交易策略优化专家。核心目标：增加盈利，不是减少亏损。分析盈利交易找到可复制的模式并强化它。你只返回JSON。入场权重永远>=0.5。' },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log('  API错误: ' + resp.status + ' ' + errText.slice(0, 100));
      return;
    }

    const data = await resp.json();
    const text = data.choices[0].message.content.trim();
    log('  AI响应: ' + text.slice(0, 200) + '...');

    // Parse JSON from response (handle both raw JSON and code-fenced)
    let jsonStr = text;
    const m = text.match(/\{[\s\S]*\}/);
    if (m) jsonStr = m[0];
    const changes = JSON.parse(jsonStr);

    log('');
    log('  🤖 AI分析: ' + (changes.analysis || '(略)'));
    let applied = 0;

    // Apply param changes (locked params ignored)
    const LOCKED_PARAMS = ['leverage', 'positionSize', 'maxLayers', 'jawShift', 'teethShift', 'lipsShift'];
    if (changes.paramChanges) {
      for (const k in changes.paramChanges) {
        if (LOCKED_PARAMS.includes(k)) { log('  跳过锁定参数: ' + k); continue; }
        if (gStrategy.params.hasOwnProperty(k)) {
          const old = gStrategy.params[k];
          let v = changes.paramChanges[k];
          const clamps = { jawPeriod: [7, 21], teethPeriod: [5, 13], lipsPeriod: [3, 8], aoFast: [3, 8], aoSlow: [21, 55], maxBars: [60, 200], maxMargin: [50, 200] };
          if (clamps[k]) v = Math.max(clamps[k][0], Math.min(clamps[k][1], v));
          if (['jawPeriod','teethPeriod','lipsPeriod','aoFast','aoSlow','maxBars','maxMargin'].includes(k)) v = Math.round(v);
          gStrategy.params[k] = typeof old === 'number' ? +v.toFixed(4) : v;
          log('  参数 ' + k + ': ' + old + ' → ' + gStrategy.params[k]);
          applied++;
        }
      }
      // Force locked params
      gStrategy.params.leverage = 200;
      gStrategy.params.positionSize = 0.05;
      gStrategy.params.maxLayers = 3;
      if (gStrategy.params.jawPeriod <= gStrategy.params.teethPeriod) gStrategy.params.jawPeriod = gStrategy.params.teethPeriod + 2;
      if (gStrategy.params.teethPeriod <= gStrategy.params.lipsPeriod) gStrategy.params.teethPeriod = gStrategy.params.lipsPeriod + 2;
    }

    // Apply rule changes — entry/exit rules CANNOT be disabled
    const ruleCategories = [
      { name: 'entryRules', arr: gStrategy.entryRules, locked: true },
      { name: 'exitRules', arr: gStrategy.exitRules, locked: true },
      { name: 'filterRules', arr: gStrategy.filterRules, locked: false }
    ];

    // Only allow filter enable/disable
    if (changes.enableFilters) {
      for (const ft of changes.enableFilters) {
        const rule = gStrategy.filterRules.find(r => r.type === ft);
        if (rule && !rule.enabled) { rule.enabled = true; log('  启用过滤器: ' + ft); applied++; }
      }
    }
    if (changes.disableFilters) {
      for (const ft of changes.disableFilters) {
        const rule = gStrategy.filterRules.find(r => r.type === ft);
        if (rule && rule.enabled) { rule.enabled = false; log('  禁用过滤器: ' + ft); applied++; }
      }
    }
    // Force all entry/exit rules enabled
    for (const r of gStrategy.entryRules) r.enabled = true;
    for (const r of gStrategy.exitRules) r.enabled = true;

    // Weight changes with entry floor at 0.5
    let tightenCount = 0, loosenCount = 0;
    if (changes.weightChanges) {
      for (const k in changes.weightChanges) {
        for (const cat of ruleCategories) {
          const rule = cat.arr.find(r => r.type === k);
          if (rule) {
            const oldW = rule.weight;
            const isEntry = cat.name === 'entryRules';
            const floor = isEntry ? 0.5 : 0.1; // 入场权重最低0.5
            rule.weight = +Math.max(floor, Math.min(2.0, changes.weightChanges[k])).toFixed(2);
            if (rule.weight < oldW) tightenCount++;
            else if (rule.weight > oldW) loosenCount++;
            log('  权重 ' + cat.name + '/' + k + ': ' + oldW + ' → ' + rule.weight + (isEntry?' [min0.5]':''));
            applied++;
          }
        }
      }
    }

    if (applied > 0) {
      gStrategy.generation = (gStrategy.generation || 0) + 1;
      // Track evolution direction for anti-spiral
      if (!gState._evoHistory) gState._evoHistory = [];
      const direction = tightenCount > loosenCount ? 'tighten' : (loosenCount > tightenCount ? 'loosen' : 'neutral');
      gState._evoHistory.push({ gen: gStrategy.generation, direction, tightenCount, loosenCount, time: Date.now() });
      if (gState._evoHistory.length > 10) gState._evoHistory.shift();
      gStrategy.version = (parseFloat(gStrategy.version || '1.0') + 0.1).toFixed(1);
      gStrategy.name = 'Evo-AI-' + new Date().toISOString().slice(0, 10);
      gStrategy.description = 'AI优化: ' + (changes.analysis || '').slice(0, 80);
      // Save evolved strategy to file
      const output = {
        name: gStrategy.name, version: gStrategy.version, description: gStrategy.description,
        generation: gStrategy.generation, parentInfo: 'AI-evolved',
        params: gStrategy.params, entryRules: gStrategy.entryRules,
        exitRules: gStrategy.exitRules, filterRules: gStrategy.filterRules,
        aiAnalysis: changes.analysis || '',
        evolvedAt: new Date().toISOString(), evolutionReason: 'ai-' + losses.length + '-losses'
      };
      fs.writeFileSync(STRATEGY_FILE, JSON.stringify(output, null, 2));
      // Also write JS file for file:// HTML access
      fs.writeFileSync(path.join(__dirname, 'btc_strategy_evolve.js'), 'window.__evolvedStrategy=' + JSON.stringify(output) + ';');
      // Persist in state
      if (!gState.strategyHistory) gState.strategyHistory = [];
      gState.strategyHistory.push({ name: gStrategy.name, version: gStrategy.version, deployedAt: Date.now(), reason: 'AI-' + losses.length + 'losses' });
      saveState();
      log('  ✅ AI进化完成: ' + gStrategy.name + ' v' + gStrategy.version + ' (gen ' + gStrategy.generation + ') ' + applied + '项改动');
      log('  新策略已保存到: ' + STRATEGY_FILE);
    } else {
      log('  ⚠ AI未建议有效改动，保持原策略');
    }
    log('══════════════════════════');
    log('');
  } catch(e) {
    log('  AI进化异常: ' + e.message);
    log('══════════════════════════');
    log('');
  }
}

// ── Status display ──
function printStatus() {
  gRunCount++;
  const pos = gState.position;
  const lastPrice = gCandles ? gCandles[gCandles.length - 1].close : (pos ? pos.entryPrice : 0);
  let posPnl = 0, posPnlPct = '0.0';
  if (pos) {
    posPnl = pos.side === 'SHORT'
      ? (pos.entryPrice - lastPrice) * pos.qty
      : (lastPrice - pos.entryPrice) * pos.qty;
    posPnlPct = (pos.margin > 0 ? (posPnl / pos.margin * 100) : 0).toFixed(1);
  }
  const equity = gState.balance + (pos ? (pos.margin + posPnl) : 0);
  const totalPnl = equity - gState.initialCapital;

  // Multi-line status display
  const ts = now();
  const trend = detectTrend();
  const trendLabel = trend.direction === 'bull' ? '🟢 多头' : (trend.direction === 'bear' ? '🔴 空头' : '⚪ 震荡');
  console.log('');
  console.log('═══ ' + ts + ' #' + gRunCount + ' ═══');
  console.log('  账户: 余额$' + gState.balance.toFixed(2) + ' | 权益$' + equity.toFixed(2) + ' | 累计' + (totalPnl>=0?'+':'') + '$' + totalPnl.toFixed(2));
  console.log('  趋势: ' + trendLabel + ' | 多头仓位' + (trend.longBias*100).toFixed(0) + '% | 空头仓位' + (trend.shortBias*100).toFixed(0) + '% | ' + trend.details);
  console.log('  历史: ' + gState.closedTrades.length + '笔平仓 | ' + gState.winningTrades + '赢/' + gState.losingTrades + '亏');
  if (pos) {
    const layers = pos._layers || 1;
    const sideLabel = pos.side === 'SHORT' ? '🔴 做空' : '🟢 做多';
    const pnlSign = posPnl >= 0 ? '+' : '';
    console.log('  ──────────────────────────────');
    console.log('  持仓: ' + sideLabel + ' | 均价$' + pos.entryPrice.toFixed(1) + ' | 现价$' + lastPrice.toFixed(1));
    console.log('  数量: ' + pos.qty.toFixed(6) + ' BTC | 保证金$' + pos.margin.toFixed(0) + ' | 杠杆' + (pos.leverage||200) + 'x' + (layers>1?' | '+layers+'层仓位':''));
    console.log('  浮动盈亏: ' + pnlSign + '$' + posPnl.toFixed(2) + ' (' + pnlSign + posPnlPct + '%)');
    if (gCooldownTime > 0) console.log('  ⚠ 冷却中，等下一根K线开仓信号');
  } else {
    console.log('  持仓: 无' + (gCooldownTime > 0 ? ' (冷却中，等待新信号)' : ' (等待混沌信号)'));
  }
  console.log('');
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

      // /reset endpoint
      if (urlPath === '/reset') {
        gState.balance = gState.initialCapital;
        gState.position = null;
        gState.orders = [];
        gState.closedTrades = [];
        gState.equityHistory = [];
        gState.totalTrades = 0;
        gState.winningTrades = 0;
        gState.losingTrades = 0;
        gState.orderIdSeq = 0;
        gState.recentTrades = [];
        gState.recentTradeFeedback = [];
        gState.runCount = 0;
        // 设置冷却，防止立即被扫描循环重新开仓
        if (gCandles && gCandles.length > 0) {
          gCooldownTime = gCandles[gCandles.length - 1].time;
        }
        saveState();
        // Return full clean state so UI can apply directly without re-fetch
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        return res.end(JSON.stringify({
          ok:true,
          state:{
            balance:gState.balance,initialCapital:gState.initialCapital,
            position:null,orders:[],closedTrades:[],equityHistory:[],
            totalTrades:0,winningTrades:0,losingTrades:0,orderIdSeq:0,
            runCount:0
          }
        }));
      }

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
  console.log('║   BTC 实时交易 — 证券混沌操作法          ║');
  console.log('║   鳄鱼线+分形+AO+AC 四大工具             ║');
  console.log('║   200x 5%仓位 $100上限  每30秒扫描       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  gState = loadState();
  gStrategy = loadStrategy();
  // Sync JS file for file:// HTML access
  if (fs.existsSync(STRATEGY_FILE)) {
    fs.writeFileSync(path.join(__dirname, 'btc_strategy_evolve.js'), 'window.__evolvedStrategy=' + fs.readFileSync(STRATEGY_FILE, 'utf8') + ';');
  }
  log('策略: ' + gStrategy.name + ' v' + gStrategy.version);
  log('过滤器: ' + (gStrategy.filterRules.filter(r => r.enabled).map(r => r.type).join(', ') || '无'));
  log('初始资金: $' + gState.initialCapital + ' | 余额: $' + gState.balance.toFixed(2));
  log('杠杆: ' + gStrategy.params.leverage + 'x | 加仓层数: ≤' + (gStrategy.params.maxPositions||3) + ' | 最长持仓: ' + (gStrategy.params.maxBars||80) + '根K线');
  log('离场: 鳄鱼线牙齿/嘴唇 | AO反转 | 反向分形 | 鳄鱼线翻转');
  log('加仓: 同向分形突破 | AO动量确认');
  log('保证金比例: ' + (gStrategy.params.positionSize * 100).toFixed(0) + '%');
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
