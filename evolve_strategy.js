// ===== Offline Strategy Evolution =====
// Runs deep iteration on downloaded historical 15m data
// Saves the evolved strategy for use by the HTML page
// Usage: node evolve_strategy.js [generations] [populationSize]

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'btc_15m_history.json');
const OUTPUT_FILE = path.join(__dirname, 'btc_strategy_evolve.json');
const STRATEGY_FILE = path.join(__dirname, 'btc_strategy.js');

const args = process.argv.slice(2);
const generations = parseInt(args[0]) || 30;
const popSize = parseInt(args[1]) || 20;

console.log('BTC Strategy Offline Evolution');
console.log('  Generations:', generations);
console.log('  Population:', popSize);
console.log('  Input:     ', HISTORY_FILE);
console.log('  Output:    ', OUTPUT_FILE);
console.log('');

// ── Load strategy engine into global scope ──
console.log('Loading strategy engine...');
const strategyCode = fs.readFileSync(STRATEGY_FILE, 'utf8');
vm.runInThisContext(strategyCode, { filename: 'btc_strategy.js' });
console.log('  Functions loaded: createStrategy=' + (typeof createStrategy === 'function'));
console.log('');

// ── Load historical candles ──
if (!fs.existsSync(HISTORY_FILE)) {
  console.error('ERROR: History file not found: ' + HISTORY_FILE);
  console.error('Run: node download_history.js first');
  process.exit(1);
}
console.log('Loading candles...');
const candles = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
console.log('  Loaded: ' + candles.length.toLocaleString() + ' candles');

// Sort & dedup (safety)
candles.sort((a, b) => a.time - b.time);
const seen = new Set();
const deduped = candles.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
console.log('  After dedup: ' + deduped.length.toLocaleString());
const first = new Date(deduped[0].time).toISOString().slice(0, 16);
const last = new Date(deduped[deduped.length - 1].time).toISOString().slice(0, 16);
console.log('  Range: ' + first + ' ~ ' + last);
console.log('');

// Auto-scale for very large datasets
let actualPop = popSize, actualGens = generations;
if (deduped.length > 50000) { actualPop = Math.min(popSize, 5); actualGens = Math.min(generations, 15); }
else if (deduped.length > 10000) { actualPop = Math.min(popSize, 10); actualGens = Math.min(generations, 20); }
console.log('Auto-scaled: pop ' + actualPop + ', ' + actualGens + ' gens');
console.log('');

// ── Build current strategy ──
// Check if we have a previously evolved strategy to use as baseline
let currentStrategy;
if (fs.existsSync(OUTPUT_FILE)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    if (prev.name && prev.params) {
      currentStrategy = createStrategy(
        prev.name, prev.version, prev.description,
        prev.params, prev.entryRules, prev.exitRules, prev.filterRules
      );
      currentStrategy.generation = prev.generation || 0;
      console.log('Loaded previous evolved strategy: ' + prev.name + ' v' + prev.version + ' (gen ' + prev.generation + ')');
    }
  } catch(e) { console.log('Could not load previous strategy, using default'); }
}
if (!currentStrategy) {
  currentStrategy = createStrategy(undefined, undefined, undefined, undefined, undefined, undefined, undefined);
  console.log('Using default Chaos v2.0 strategy');
}

// ── Quick baseline backtest ──
console.log('');
console.log('Baseline backtest...');
const t0 = Date.now();
const baseBT = currentStrategy.backtest(deduped);
console.log('  Return: +' + baseBT.totalReturn + '%  Win: ' + baseBT.winRate + '%  Trades: ' + baseBT.closedTrades + '  (' + (Date.now() - t0) + 'ms)');

// Load live trade feedback from paper_state.json (if exists)
let liveFeedback = [];
try {
  const PAPER_STATE = path.join(__dirname, 'paper_state.json');
  if (fs.existsSync(PAPER_STATE)) {
    const paperState = JSON.parse(fs.readFileSync(PAPER_STATE, 'utf8'));
    if (paperState.recentTradeFeedback && paperState.recentTradeFeedback.length > 0) {
      liveFeedback = paperState.recentTradeFeedback.slice(-50);
      console.log('  Live trade feedback: ' + liveFeedback.length + ' trades');
    }
  }
} catch(e) { /* ignore */ }

// ── Deep iteration ──
console.log('');
console.log('Running genetic iteration (pop ' + actualPop + ', ' + actualGens + ' gens)...');
console.log('');

const iterT0 = Date.now();
const iterResult = currentStrategy.iterate(deduped, {
  populationSize: actualPop,
  generations: actualGens,
  liveFeedback: liveFeedback,
  onProgress: function(p) {
    const elapsed = ((Date.now() - iterT0) / 1000).toFixed(0);
    const bar = '█'.repeat(Math.round(p.pct / 5)) + '░'.repeat(20 - Math.round(p.pct / 5));
    process.stdout.write('\r  [' + bar + '] Gen ' + p.generation + '/' + p.totalGenerations +
      ' | Best: +' + p.bestReturn + '% win ' + p.bestWinRate + '% trades ' + p.bestTrades +
      ' | ' + elapsed + 's    ');
  }
});
const iterElapsed = ((Date.now() - iterT0) / 1000).toFixed(1);

console.log('');
console.log('');
console.log('Iteration complete (' + iterElapsed + 's)');

if (!iterResult || !iterResult.bestStrategy) {
  console.error('ERROR: No results produced');
  process.exit(1);
}

const best = iterResult.bestStrategy;
const bestBT = best.backtest(deduped);
console.log('');
console.log('═══════════════════════════════════════════');
console.log('  Baseline: +' + baseBT.totalReturn + '%  Win: ' + baseBT.winRate + '%  Trades: ' + baseBT.closedTrades);
console.log('  Evolved:  +' + bestBT.totalReturn + '%  Win: ' + bestBT.winRate + '%  Trades: ' + bestBT.closedTrades);
console.log('  Improvement: +' + (bestBT.totalReturn - baseBT.totalReturn).toFixed(2) + '%');
console.log('═══════════════════════════════════════════');
console.log('');

// ── Save evolved strategy ──
const gen = ((currentStrategy.generation || 0) + 1);
best.name = 'Evo-' + new Date().toISOString().slice(0, 10);
best.version = (3 + gen * 0.1).toFixed(1);

const output = {
  name: best.name,
  version: best.version,
  description: best.description || 'Evolved from ' + currentStrategy.name + ' on ' + deduped.length.toLocaleString() + ' candles',
  generation: gen,
  parentInfo: currentStrategy.name + ' v' + currentStrategy.version,
  params: best.params,
  entryRules: best.entryRules,
  exitRules: best.exitRules,
  filterRules: best.filterRules,
  backtest: {
    totalReturn: bestBT.totalReturn,
    winRate: bestBT.winRate,
    closedTrades: bestBT.closedTrades,
    totalEntries: bestBT.totalEntries,
    candlesCount: deduped.length
  },
  topStrategies: (iterResult.topStrategies || []).slice(0, 5).map(s => ({
    totalReturn: s.totalReturn,
    winRate: s.winRate,
    closedTrades: s.closedTrades,
    params: s.params
  })),
  evolvedAt: new Date().toISOString(),
  dataRange: first + ' ~ ' + last,
  iterations: { generations: actualGens, populationSize: actualPop, elapsedSeconds: parseFloat(iterElapsed) }
};

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
console.log('Saved to: ' + OUTPUT_FILE);
console.log('  File size: ' + (fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1) + ' KB');
console.log('');
console.log('Usage: Open btc_trading_demo.html → strategy auto-loads evolved version');
