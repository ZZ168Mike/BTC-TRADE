// ===== GitHub Actions Headless Runner =====
// Runs paper trading + evolution, persists state to JSON files
// Called by .github/workflows/trading-bot.yml every 5 minutes
// Scans last 100 candles including current in-progress bar for immediate execution

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'paper_state.json');
const STRATEGY_FILE = path.join(__dirname, 'btc_strategy_evolve.json');
const STRATEGY_CODE = path.join(__dirname, 'btc_strategy.js');
const HISTORY_FILE = path.join(__dirname, 'btc_15m_history.json');

// ── Load strategy engine ──
const strategyCode = fs.readFileSync(STRATEGY_CODE, 'utf8');
vm.runInThisContext(strategyCode, { filename: 'btc_strategy.js' });

// ── Helpers ──
function log(msg) { console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatTime(ts) {
  return new Date(ts).toISOString().slice(11, 19);
}

// ── Fetch latest 15m candles from Binance ──
async function fetchRecent15m(limit) {
  limit = limit || 50;
  const url = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=' + limit;
  const resp = await fetch(url);
  const raw = await resp.json();
  if (!Array.isArray(raw)) throw new Error('Binance API error');
  return raw.map(r => ({
    time: parseInt(r[0]),
    open: parseFloat(r[1]),
    high: parseFloat(r[2]),
    low: parseFloat(r[3]),
    close: parseFloat(r[4]),
    volume: parseFloat(r[5])
  }));
}

// ── Load state ──
function loadState() {
  const defaults = {
    balance: 1000, initialCapital: 1000,
    position: null, _cooldownTime: 0,
    orders: [], closedTrades: [], equityHistory: [],
    totalTrades: 0, winningTrades: 0, losingTrades: 0,
    orderIdSeq: 0,
    // Evolution state
    strategyHistory: [],
    lastMarketRegime: 'neutral',
    lastVolatility: 0,
    recentTrades: [],
    recentTradeFeedback: [],
    // Metadata
    lastRun: null,
    runCount: 0
  };
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return Object.assign({}, defaults, saved);
    }
  } catch(e) { log('Could not load state, using defaults: ' + e.message); }
  return defaults;
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  state.runCount = (state.runCount || 0) + 1;
  // Trim old entries
  if (state.orders.length > 200) state.orders = state.orders.slice(-200);
  if (state.closedTrades.length > 200) state.closedTrades = state.closedTrades.slice(-200);
  if (state.equityHistory.length > 500) state.equityHistory = state.equityHistory.slice(-500);
  if (state.recentTrades.length > 50) state.recentTrades = state.recentTrades.slice(-50);
  if (state.recentTradeFeedback && state.recentTradeFeedback.length > 100) state.recentTradeFeedback = state.recentTradeFeedback.slice(-100);
  if (state.strategyHistory.length > 20) state.strategyHistory = state.strategyHistory.slice(-20);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Build strategy from evolved JSON ──
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
  } catch(e) { log('Could not load strategy: ' + e.message); }
  return createStrategy();
}

// ── Calculate ATR ──
function calculateATR(candles, period) {
  period = period || 14;
  const tr = [], atr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { tr.push(candles[i].high - candles[i].low); continue; }
    tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close)));
  }
  for (let j = 0; j < tr.length; j++) {
    if (j < period - 1) { atr.push(NaN); continue; }
    if (j === period - 1) { let s = 0; for (let k = 0; k < period; k++) s += tr[j-k]; atr.push(s/period); }
    else { atr.push((atr[j-1]*(period-1)+tr[j])/period); }
  }
  return atr;
}

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
  const atr = calculateATR(last50, 14);
  const lastATR = atr[atr.length - 1];
  const volatility = !isNaN(lastATR) ? lastATR / candles[candles.length - 1].close : 0;
  let regime = 'neutral';
  if (slope > 0.003) regime = 'bull';
  else if (slope < -0.003) regime = 'bear';
  else regime = 'ranging';
  return { r: regime, v: volatility };
}

// ── Main runner ──
async function main() {
  log('GitHub Runner starting...');
  const state = loadState();
  log('State: $' + state.balance.toFixed(2) + ' | ' + state.closedTrades.length + ' trades | run #' + (state.runCount + 1));

  // Load strategy
  let strategy = loadStrategy();
  log('Strategy: ' + strategy.name + ' v' + strategy.version + ' (gen ' + (strategy.generation || 0) + ')');

  // Fetch latest 15m candles
  log('Fetching recent 15m candles...');
  let recentCandles;
  try {
    recentCandles = await fetchRecent15m(150);
    log('Fetched ' + recentCandles.length + ' candles. Latest: ' + formatTime(recentCandles[recentCandles.length-1].time) + ' close=$' + recentCandles[recentCandles.length-1].close.toFixed(1) + ' (in-progress bar)');
  } catch(e) {
    log('Fetch error: ' + e.message);
    return;
  }

  // Update equity history with latest price
  const lastCandle = recentCandles[recentCandles.length - 1];
  const latestPrice = lastCandle.close;
  const equity = state.balance + (state.position
    ? state.position.margin + (latestPrice - state.position.entryPrice) * state.position.qty
    : 0);
  const lastEquityEntry = state.equityHistory.length > 0 ? state.equityHistory[state.equityHistory.length - 1] : null;
  if (!lastEquityEntry || lastEquityEntry.time < lastCandle.time) {
    state.equityHistory.push({ time: lastCandle.time, equity: Math.round(equity * 100) / 100 });
    if (state.equityHistory.length > 500) state.equityHistory.shift();
  } else {
    // Update latest entry
    lastEquityEntry.equity = Math.round(equity * 100) / 100;
  }

  // Paper trading: scan last 100 candles including current in-progress bar
  // Signal on current bar → execute immediately, don't wait for close
  const candlesToProcess = recentCandles; // Include current incomplete candle
  let newTrades = 0;

  // Detect market regime once for trade feedback
  const regime = detectMarketRegime(recentCandles);

  const scanStart = Math.max(30, candlesToProcess.length - 100);
  for (let i = scanStart; i < candlesToProcess.length; i++) {
    const candle = candlesToProcess[i];
    // Skip if already processed (check if we have equity history for this time)
    const alreadyProcessed = state.equityHistory.some(e => e.time === candle.time && !state.position);
    if (alreadyProcessed && !state.position) continue;

    try {
      if (state.position) {
        // ── EXIT CHECK — 纯混沌操作法离场 ──
        const pos = state.position;
        const ctx = strategy._buildContext(candlesToProcess);
        const margin = pos.margin || (state.initialCapital * strategy.params.positionSize);
        const lev = pos.leverage || 1;

        // Use strategy's chaos exit rules
        const exitReason = strategy._checkExit ? strategy._checkExit(candlesToProcess, i, pos, ctx) : null;

        if (exitReason) {
          let pnl;
          if (pos.side === 'SHORT') {
            pnl = (pos.entryPrice - candle.close) * pos.qty;
          } else {
            pnl = (candle.close - pos.entryPrice) * pos.qty;
          }
          const pnlPctNum = margin > 0 ? (pnl / margin * 100) : 0;
          if (pnl < -margin) pnl = -margin;
          state.balance += margin + pnl;
          const closedBarsHeld = i - (pos._entryIdx || 0);
          const exitSide = pos.side === 'SHORT' ? 'Buy (cover)' : 'Sell';
          const tradeLabel = pos.side === 'SHORT' ? 'Short' : 'Long';
          state.orders.push({
            id: ++state.orderIdSeq, time: formatTime(candle.time), side: exitSide,
            price: '$' + candle.close.toFixed(1), qty: pos.qty.toFixed(6) + ' BTC',
            status: 'filled', type: 'market', reason: exitReason
          });
          state.closedTrades.push({
            entryTime: formatTime(pos.entryTime), exitTime: formatTime(candle.time),
            side: tradeLabel, entryPrice: pos.entryPrice, exitPrice: candle.close,
            qty: pos.qty, margin: Math.round(margin * 100) / 100,
            pnl: Math.round(pnl * 100) / 100, pnlPct: pnlPctNum.toFixed(1) + '%', leverage: lev + 'x',
            reason: exitReason, barsHeld: closedBarsHeld
          });
          if (pnl > 0) state.winningTrades++; else state.losingTrades++;
          state.recentTrades.push({ pnl: Math.round(pnl * 100) / 100, pnlPct: pnlPctNum.toFixed(1) + '%', reason: exitReason, time: Date.now() });
          if (state.recentTrades.length > 50) state.recentTrades.shift();

          if (!state.recentTradeFeedback) state.recentTradeFeedback = [];
          state.recentTradeFeedback.push({
            entryType: pos._entryRuleType || 'unknown',
            entryIdx: pos._entryIdx, side: pos.side,
            pnlPct: parseFloat(pnlPctNum.toFixed(1)),
            reason: exitReason,
            entryRegime: pos._entryRegime || 'unknown',
            entryVolatility: pos._entryVolatility || 0,
            entryAO: pos._entryAO || 0,
            entryTime: pos.entryTime,
            exitTime: candle.time,
            barsHeld: closedBarsHeld
          });
          if (state.recentTradeFeedback.length > 100) state.recentTradeFeedback = state.recentTradeFeedback.slice(-100);

          state.position = null;
          state._cooldownTime = candle.time; // 冷却：等下一根K线再开仓
          newTrades++;
          log((pos.side === 'SHORT' ? 'COVER' : 'SELL') + ' @' + candle.close.toFixed(0) + ' P&L:$' + pnl.toFixed(2) + ' ' + exitReason);
        }
      } else {
        // ── ENTRY CHECK (LONG & SHORT) ──
        const ctx = strategy._buildContext ? strategy._buildContext(candlesToProcess) : null;
        if (!ctx) { log('  WARN: no ctx for signal check'); continue; }

        // Signal diagnostics (last candle only)
        if (i === candlesToProcess.length - 1) {
          let diagFired = [], diagBlocked = [], bestScore = 0;
          for (let er = 0; er < strategy.entryRules.length; er++) {
            const rule = strategy.entryRules[er];
            if (!rule.enabled || rule.weight <= 0) { diagBlocked.push(rule.type + '(disabled)'); continue; }
            if (!RuleEvaluators || !RuleEvaluators[rule.type]) { diagBlocked.push(rule.type + '(no-eval)'); continue; }
            const sig = RuleEvaluators[rule.type](candlesToProcess, i, rule, ctx);
            if (!sig) { diagBlocked.push(rule.type + '(no-signal)'); continue; }
            let blockedBy = null;
            for (let f = 0; f < strategy.filterRules.length; f++) {
              const fr = strategy.filterRules[f];
              if (!fr.enabled || fr.weight <= 0) continue;
              if (RuleEvaluators[fr.type] && !RuleEvaluators[fr.type](candlesToProcess, i, sig, ctx)) { blockedBy = fr.type; break; }
            }
            if (blockedBy) { diagBlocked.push(rule.type + '→' + sig.type + '(s' + sig.strength + ' blocked:' + blockedBy + ')'); }
            else {
              const score = sig.strength * rule.weight;
              diagFired.push(rule.type + '→' + sig.type + '(s' + sig.strength + '×w' + rule.weight + '=' + score.toFixed(1) + ')');
              if (score > bestScore) bestScore = score;
            }
          }
          const minScore = strategy.params.minSignalScore || 0;
          if (diagFired.length === 0) {
            log('  SIGNAL: NONE | ' + diagBlocked.join(', '));
          } else {
            log('  SIGNAL: ' + (bestScore >= minScore ? 'TRADE' : 'WEAK') + ' best=' + bestScore.toFixed(1) + '/min=' + minScore.toFixed(1) + ' | ' + diagFired.join(', '));
          }
        }

        // 冷却检查：平仓后不立即在同根K线反向开仓
        if (state._cooldownTime && candle.time <= state._cooldownTime) continue;

        const signal = strategy.generateSignal(candlesToProcess, i, ctx);
        if (signal && (signal.type === 'BUY' || signal.type === 'SELL')) {
          state._cooldownTime = 0; // 开仓则清冷却
          const entryRegime = regime.r, entryVol = regime.v;
          const entryAO = ctx && ctx.ao ? (ctx.ao[i] || 0) : 0;
          const lev = strategy.params.leverage || 1;
          const margin = state.balance * strategy.params.positionSize;
          const qty = (margin * lev) / candle.close;
          if (qty * candle.close >= 10) {
            const isShort = signal.type === 'SELL';
            state.position = {
              side: isShort ? 'SHORT' : 'LONG',
              qty: qty, entryPrice: candle.close,
              entryTime: candle.time, _entryIdx: i,
              _trailHi: isShort ? undefined : candle.high,
              _trailLo: isShort ? candle.low : undefined,
              margin: margin, leverage: lev,
              _entryRuleType: signal.reason ? signal.reason.split(':')[0] || 'unknown' : 'unknown',
              _entryRegime: entryRegime,
              _entryVolatility: entryVol,
              _entryAO: isNaN(entryAO) ? 0 : entryAO
            };
            state.balance -= margin;
            state.orders.push({
              id: ++state.orderIdSeq, time: formatTime(candle.time),
              side: isShort ? 'Sell (short)' : 'Buy (long)',
              price: '$' + candle.close.toFixed(1), qty: qty.toFixed(6) + ' BTC',
              margin: '$' + margin.toFixed(2), leverage: lev + 'x',
              status: 'filled', type: 'market', reason: signal.reason
            });
            state.totalTrades++;
            newTrades++;
            log((isShort ? 'SHORT' : 'LONG') + ' @' + candle.close.toFixed(0) + ' x' + qty.toFixed(5) + ' margin=$' + margin.toFixed(0) + ' ' + lev + 'x ' + signal.reason);
          }
        }
      }
    } catch(e) {
      log('Trade tick error at candle ' + i + ': ' + e.message);
    }
  }

  if (newTrades > 0) log('New trades this run: ' + newTrades);

  // ═══════════════════════════════════════════════════════
  // ── STRATEGY EVOLUTION LOCK ──
  // 策略只有在实盘产生 ≥3 笔亏损交易后才允许迭代进化
  // 在此之前，严格使用混沌原始策略（零过滤器，纯信号驱动）
  // ═══════════════════════════════════════════════════════
  const MIN_LOSSES_FOR_EVOLUTION = 3;
  const currentLossCount = state.closedTrades.filter(t => t.pnl < 0).length;
  const evolutionLocked = currentLossCount < MIN_LOSSES_FOR_EVOLUTION;

  state.lastMarketRegime = regime.r;
  state.lastVolatility = regime.v;

  if (evolutionLocked) {
    // 进化锁定：原策略不动
    if (state.runCount % 6 === 0) {
      log('Evolution LOCKED — need ' + MIN_LOSSES_FOR_EVOLUTION + ' losing trades before evolving. Current: ' + currentLossCount);
    }
  } else {
    // ── P&L-DRIVEN EVOLUTION (≥3 losses) ──
    const recentFeedback = (state.recentTradeFeedback || []).slice(-50);
    const recentLosses = recentFeedback.filter(t => t.pnl < 0);
    const recentWins = recentFeedback.filter(t => t.pnl > 0);

    log('P&L-driven evolution: ' + recentWins.length + ' wins, ' + recentLosses.length + ' losses (unlocked after ' + currentLossCount + ' losses)');

    if (recentLosses.length >= 3) {
      log('  ≥3 recent losses — analyzing & iterating...');
      try {
        let allCandles = recentCandles;
        try {
          if (fs.existsSync(HISTORY_FILE)) {
            const hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            const existingTimes = new Set(hist.map(c => c.time));
            for (const c of recentCandles) {
              if (!existingTimes.has(c.time)) hist.push(c);
            }
            hist.sort((a, b) => a.time - b.time);
            allCandles = hist;
          }
        } catch(e) { /* use recent only */ }

        const diagnosis = strategy._diagnose
          ? strategy._diagnose(allCandles, strategy.backtest(allCandles), recentLosses)
          : null;

        let mutant = strategy._clone ? strategy._clone() : null;
        if (mutant && diagnosis) {
          mutant = mutant._mutate ? mutant._mutate(diagnosis) : mutant;

          const mutantBT = mutant.backtest(allCandles);
          if (mutantBT.closedTrades > 0) {
            mutant.name = 'Evo-' + new Date().toISOString().slice(0, 10);
            mutant.version = (parseFloat(strategy.version || '1.0') + 0.1).toFixed(1);
            mutant.description = 'P&L-evolved after ' + currentLossCount + ' losses';
            const output = {
              name: mutant.name, version: mutant.version, description: mutant.description,
              generation: (strategy.generation || 0) + 1,
              parentInfo: strategy.name + ' v' + strategy.version,
              params: mutant.params, entryRules: mutant.entryRules,
              exitRules: mutant.exitRules, filterRules: mutant.filterRules,
              backtest: { totalReturn: mutantBT.totalReturn, winRate: mutantBT.winRate, closedTrades: mutantBT.closedTrades },
              evolvedAt: new Date().toISOString(),
              evolutionReason: 'real-pnl-' + recentLosses.length + '-losses'
            };
            fs.writeFileSync(STRATEGY_FILE, JSON.stringify(output, null, 2));
            log('  Deployed: ' + mutant.name + ' v' + mutant.version + ' (loss-driven)');
            state.strategyHistory.push({
              name: mutant.name, version: mutant.version,
              deployedAt: Date.now(),
              reason: 'losses-' + recentLosses.length
            });
          } else {
            log('  Mutant 0-trade — keeping current');
          }
        }
      } catch(e) { log('Evolution error: ' + e.message); }
    } else {
      log('  P&L acceptable — keeping strategy');
    }
  }

  // Save state
  saveState(state);
  const finalEquity = state.balance + (state.position
    ? state.position.margin + (latestPrice - state.position.entryPrice) * state.position.qty
    : 0);
  log('Run complete. Equity: $' + finalEquity.toFixed(2) + ' | ' + state.closedTrades.length + ' trades | P&L: $' + (finalEquity - state.initialCapital).toFixed(2));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
