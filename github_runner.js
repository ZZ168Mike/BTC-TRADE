// ===== GitHub Actions Headless Runner =====
// Runs paper trading + evolution, persists state to JSON files
// Called by .github/workflows/trading-bot.yml every 15 minutes

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
    position: null,
    orders: [], closedTrades: [], equityHistory: [],
    totalTrades: 0, winningTrades: 0, losingTrades: 0,
    orderIdSeq: 0,
    // Evolution state
    strategyHistory: [],
    lastMarketRegime: 'neutral',
    lastVolatility: 0,
    recentTrades: [],
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
    recentCandles = await fetchRecent15m(100);
    log('Fetched ' + recentCandles.length + ' candles. Latest: ' + formatTime(recentCandles[recentCandles.length-1].time) + ' close=$' + recentCandles[recentCandles.length-1].close.toFixed(1));
  } catch(e) {
    log('Fetch error: ' + e.message);
    return;
  }

  // Update equity history with latest price
  const lastCandle = recentCandles[recentCandles.length - 1];
  const latestPrice = lastCandle.close;
  const equity = state.balance + (state.position ? state.position.qty * latestPrice : 0);
  const lastEquityEntry = state.equityHistory.length > 0 ? state.equityHistory[state.equityHistory.length - 1] : null;
  if (!lastEquityEntry || lastEquityEntry.time < lastCandle.time) {
    state.equityHistory.push({ time: lastCandle.time, equity: Math.round(equity * 100) / 100 });
    if (state.equityHistory.length > 500) state.equityHistory.shift();
  } else {
    // Update latest entry
    lastEquityEntry.equity = Math.round(equity * 100) / 100;
  }

  // Paper trading: check for new completed candles
  // We process all completed candles that haven't been processed yet
  // The last candle in recentCandles may be incomplete (current 15m bar)
  const candlesToProcess = recentCandles.slice(0, -1); // Exclude current incomplete candle
  let newTrades = 0;

  for (let i = Math.max(30, candlesToProcess.length - 20); i < candlesToProcess.length; i++) {
    const candle = candlesToProcess[i];
    // Skip if already processed (check if we have equity history for this time)
    const alreadyProcessed = state.equityHistory.some(e => e.time === candle.time && !state.position);
    if (alreadyProcessed && !state.position) continue;

    try {
      if (state.position) {
        // Check exit
        const ctx = strategy._buildContext(candlesToProcess);
        let exitReason = null;
        // Build exit rules check
        const exitRules = state.position._exitRules || strategy.exitRules;
        for (let r = 0; r < exitRules.length; r++) {
          const rule = exitRules[r];
          if (!rule.enabled || rule.weight <= 0) continue;
          if (RuleEvaluators && RuleEvaluators[rule.type]) {
            exitReason = RuleEvaluators[rule.type](candlesToProcess, i, state.position, ctx);
            if (exitReason) break;
          }
        }
        // Also check maxBars
        if (!exitReason && strategy.params.maxBars && state.position._entryIdx !== undefined) {
          const held = i - state.position._entryIdx;
          if (held >= strategy.params.maxBars) exitReason = 'Max bars (' + strategy.params.maxBars + ')';
        }

        if (exitReason) {
          const pnl = (candle.close - state.position.entryPrice) * state.position.qty;
          state.balance += state.position.qty * candle.close;
          const pnlPct = ((candle.close - state.position.entryPrice) / state.position.entryPrice * 100).toFixed(2);
          state.orders.push({
            id: ++state.orderIdSeq, time: formatTime(candle.time), side: 'Sell',
            price: '$' + candle.close.toFixed(1), qty: state.position.qty.toFixed(6) + ' BTC',
            status: 'filled', type: 'market', reason: exitReason
          });
          state.closedTrades.push({
            entryTime: formatTime(state.position.entryTime), exitTime: formatTime(candle.time),
            side: 'Long', entryPrice: state.position.entryPrice, exitPrice: candle.close,
            qty: state.position.qty, pnl: Math.round(pnl * 100) / 100, pnlPct: pnlPct,
            reason: exitReason, barsHeld: i - (state.position._entryIdx || 0)
          });
          if (pnl > 0) state.winningTrades++; else state.losingTrades++;
          state.recentTrades.push({ pnl: Math.round(pnl * 100) / 100, pnlPct: pnlPct, reason: exitReason, time: Date.now() });
          if (state.recentTrades.length > 50) state.recentTrades.shift();
          state.position = null;
          newTrades++;
          log('SELL @' + candle.close.toFixed(0) + ' P&L:$' + pnl.toFixed(2) + ' ' + exitReason);
        }
      } else {
        // Check entry signal
        const signal = strategy.generateSignal(candlesToProcess, i);
        if (signal && signal.type === 'BUY') {
          const amount = state.balance * strategy.params.positionSize;
          const qty = amount / candle.close;
          if (qty * candle.close >= 10) {
            state.position = {
              side: 'BUY', qty: qty, entryPrice: candle.close,
              entryTime: candle.time, _entryIdx: i, _trailHi: candle.high,
              _exitRules: JSON.parse(JSON.stringify(strategy.exitRules))
            };
            state.balance -= amount;
            state.orders.push({
              id: ++state.orderIdSeq, time: formatTime(candle.time), side: 'Buy',
              price: '$' + candle.close.toFixed(1), qty: qty.toFixed(6) + ' BTC',
              status: 'filled', type: 'market', reason: signal.reason
            });
            state.totalTrades++;
            newTrades++;
            log('BUY @' + candle.close.toFixed(0) + ' x' + qty.toFixed(5) + ' ' + signal.reason);
          }
        }
      }
    } catch(e) {
      log('Trade tick error at candle ' + i + ': ' + e.message);
    }
  }

  if (newTrades > 0) log('New trades this run: ' + newTrades);

  // ── Evolution check ──
  const regime = detectMarketRegime(recentCandles);
  const regimeChanged = regime.r !== state.lastMarketRegime;
  state.lastMarketRegime = regime.r;
  state.lastVolatility = regime.v;

  // Run evolution if: regime changed, or every ~2 hours (8 runs)
  const shouldEvolve = regimeChanged || (state.runCount % 8 === 0);
  if (shouldEvolve && recentCandles.length >= 50) {
    log('Running evolution (' + regime.r + ' vol:' + (regime.v * 100).toFixed(2) + '%)...');
    try {
      // Load history for larger backtest
      let allCandles = recentCandles;
      try {
        if (fs.existsSync(HISTORY_FILE)) {
          const hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
          // Merge: use history + append recent candles
          const existingTimes = new Set(hist.map(c => c.time));
          for (const c of recentCandles) {
            if (!existingTimes.has(c.time)) hist.push(c);
          }
          hist.sort((a, b) => a.time - b.time);
          allCandles = hist;
        }
      } catch(e) { /* use recent only */ }

      const popSize = allCandles.length > 50000 ? 4 : 10;
      const gens = allCandles.length > 50000 ? 10 : 20;
      const iterResult = strategy.iterate(allCandles, { populationSize: popSize, generations: gens });
      if (iterResult && iterResult.bestStrategy) {
        const best = iterResult.bestStrategy;
        const currentBT = strategy.backtest(allCandles);
        const bestResult = iterResult.bestResult || best.backtest(allCandles);
        log('Current: +' + currentBT.totalReturn + '% | Evolved: +' + bestResult.totalReturn + '%');

        if (bestResult.totalReturn > currentBT.totalReturn) {
          // Save evolved strategy
          best.name = 'Evo-' + new Date().toISOString().slice(0, 10);
          best.version = (parseFloat(strategy.version || '2.0') + 0.1).toFixed(1);
          const output = {
            name: best.name,
            version: best.version,
            description: 'Auto-evolved on ' + new Date().toISOString().slice(0, 10) + ' | ' + allCandles.length.toLocaleString() + ' candles',
            generation: (strategy.generation || 0) + 1,
            parentInfo: strategy.name + ' v' + strategy.version,
            params: best.params,
            entryRules: best.entryRules,
            exitRules: best.exitRules,
            filterRules: best.filterRules,
            backtest: { totalReturn: bestResult.totalReturn, winRate: bestResult.winRate, closedTrades: bestResult.closedTrades },
            evolvedAt: new Date().toISOString()
          };
          fs.writeFileSync(STRATEGY_FILE, JSON.stringify(output, null, 2));
          log('Deployed: ' + best.name + ' v' + best.version + ' (+' + (bestResult.totalReturn - currentBT.totalReturn).toFixed(2) + '%)');
          // Record in history
          state.strategyHistory.push({
            name: best.name, version: best.version,
            deployedAt: Date.now(),
            backtestReturn: bestResult.totalReturn
          });
        } else {
          log('Current strategy is optimal');
        }
      }
    } catch(e) { log('Evolution error: ' + e.message); }
  }

  // Save state
  saveState(state);
  const finalEquity = state.balance + (state.position ? state.position.qty * latestPrice : 0);
  log('Run complete. Equity: $' + finalEquity.toFixed(2) + ' | ' + state.closedTrades.length + ' trades | P&L: $' + (finalEquity - state.initialCapital).toFixed(2));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
