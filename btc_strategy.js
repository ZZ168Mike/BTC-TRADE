// ===== BTC Self-Evolving Trading Strategy =====
// Rule-based architecture with genetic algorithm self-evolution
// Entry/Exit/Filter rules compose, mutate, crossover, and adapt
// Load via Strategy panel "Load" button in btc_trading_demo.html

// ---- Indicator helpers (self-contained) ----
function _smma(data, period) {
  var result = [], len = data.length;
  for (var i = 0; i < len; i++) {
    if (i < period) { result.push(NaN); continue; }
    if (i === period) {
      var sum = 0;
      for (var j = 0; j < period; j++) sum += data[i - j];
      result.push(sum / period);
    } else {
      result.push((result[i - 1] * (period - 1) + data[i]) / period);
    }
  }
  return result;
}
function _sma(data, period) {
  var result = [], len = data.length, sum = 0;
  for (var i = 0; i < len; i++) {
    if (i < period - 1) {
      result.push(NaN);
      sum += data[i];
      continue;
    }
    if (i === period - 1) {
      sum += data[i];
      result.push(sum / period);
    } else {
      sum = sum - data[i - period] + data[i];
      result.push(sum / period);
    }
  }
  return result;
}
function _calcRSI(closes, period) {
  period = period || 14;
  var gains = [], losses = [], rsi = [];
  for (var i = 1; i < closes.length; i++) {
    var d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0); losses.push(d < 0 ? -d : 0);
  }
  var ag = 0, al = 0;
  for (var j = 0; j < period; j++) { ag += gains[j]; al += losses[j]; }
  ag /= period; al /= period;
  for (var k = 0; k < closes.length; k++) {
    if (k < period) { rsi.push(NaN); continue; }
    if (k === period) { rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al)); continue; }
    var idx = k - 1;
    ag = (ag * (period - 1) + gains[idx]) / period;
    al = (al * (period - 1) + losses[idx]) / period;
    rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return rsi;
}

// ---- Rule templates (evaluation functions keyed by type) ----
// Each rule: { id, type, category:'entry'|'exit'|'filter', enabled, weight, params:{...} }

var RuleEvaluators = {
  // === ENTRY rules === return {type:'BUY'|'SELL', strength:1-3, reason} or null
  'fractal_breakout': function(candles, i, rule, ctx) {
    var p = rule.params, price = candles[i].close;
    // Check fractal in last N bars
    var foundTop = false, foundBot = false;
    for (var k = 0; k <= p.lookback; k++) {
      var idx = i - k; if (idx < 5 || idx >= candles.length - 5) continue;
      var h = candles[idx].high, l = candles[idx].low;
      if (h > candles[idx-1].high && h > candles[idx-2].high && h > candles[idx+1].high && h > candles[idx+2].high) foundTop = true;
      if (l < candles[idx-1].low && l < candles[idx-2].low && l < candles[idx+1].low && l < candles[idx+2].low) foundBot = true;
    }
    if (foundTop && price > ctx.jaw[i] && !isNaN(ctx.jaw[i]) && ctx.ao[i] > 0 && ctx.ao[i] > (ctx.ao[i-1]||0)) {
      return { type: 'BUY', strength: 3, reason: 'Fractal breakout above Jaw + AO rising' };
    }
    if (foundBot && price < ctx.jaw[i] && !isNaN(ctx.jaw[i]) && ctx.ao[i] < 0 && ctx.ao[i] < (ctx.ao[i-1]||0)) {
      return { type: 'SELL', strength: 3, reason: 'Fractal breakdown below Jaw + AO falling' };
    }
    return null;
  },
  'alligator_align': function(candles, i, rule, ctx) {
    var price = candles[i].close;
    var jaw = ctx.jaw[i], teeth = ctx.teeth[i], lips = ctx.lips[i];
    if (isNaN(jaw) || isNaN(teeth) || isNaN(lips)) return null;
    // Bullish: lips > teeth > jaw, price above lips
    if (lips > teeth && teeth > jaw && price > lips) {
      return { type: 'BUY', strength: 2, reason: 'Alligator bullish aligned + price above' };
    }
    // Bearish: lips < teeth < jaw, price below lips
    if (lips < teeth && teeth < jaw && price < lips) {
      return { type: 'SELL', strength: 2, reason: 'Alligator bearish aligned + price below' };
    }
    return null;
  },
  'lips_cross': function(candles, i, rule, ctx) {
    var price = candles[i].close, prevClose = candles[i-1].close;
    var lips = ctx.lips[i], prevLips = ctx.lips[i-1];
    if (isNaN(lips) || isNaN(prevLips)) return null;
    if (prevClose <= prevLips && price > lips) {
      return { type: 'BUY', strength: 1, reason: 'Price crossing above Lips' };
    }
    if (prevClose >= prevLips && price < lips) {
      return { type: 'SELL', strength: 1, reason: 'Price crossing below Lips' };
    }
    return null;
  },
  'ao_zero_cross': function(candles, i, rule, ctx) {
    var ao = ctx.ao[i], aoPrev = ctx.ao[i-1] || NaN;
    if (isNaN(ao) || isNaN(aoPrev)) return null;
    if (aoPrev <= 0 && ao > 0) return { type: 'BUY', strength: 2, reason: 'AO crossing above zero' };
    if (aoPrev >= 0 && ao < 0) return { type: 'SELL', strength: 2, reason: 'AO crossing below zero' };
    return null;
  },
  'ma_cross': function(candles, i, rule, ctx) {
    var p = rule.params;
    var closes = candles.map(function(c) { return c.close; });
    var fast = _sma(closes, p.fastPeriod), slow = _sma(closes, p.slowPeriod);
    if (isNaN(fast[i]) || isNaN(slow[i]) || isNaN(fast[i-1]) || isNaN(slow[i-1])) return null;
    if (fast[i-1] <= slow[i-1] && fast[i] > slow[i]) {
      return { type: 'BUY', strength: 2, reason: 'MA'+p.fastPeriod+' crosses above MA'+p.slowPeriod };
    }
    if (fast[i-1] >= slow[i-1] && fast[i] < slow[i]) {
      return { type: 'SELL', strength: 2, reason: 'MA'+p.fastPeriod+' crosses below MA'+p.slowPeriod };
    }
    return null;
  },

  // === EXIT rules === return reason string or null
  'stop_loss': function(candles, i, position, ctx) {
    if (!position || position.side !== 'BUY') return null;
    var pnl = (candles[i].close - position.entryPrice) / position.entryPrice;
    return (pnl <= -ctx.params.stopLoss) ? 'Stop Loss (-' + (ctx.params.stopLoss*100).toFixed(1) + '%)' : null;
  },
  'take_profit': function(candles, i, position, ctx) {
    if (!position || position.side !== 'BUY') return null;
    var pnl = (candles[i].close - position.entryPrice) / position.entryPrice;
    return (pnl >= ctx.params.takeProfit) ? 'Take Profit (+' + (ctx.params.takeProfit*100).toFixed(1) + '%)' : null;
  },
  'trailing_stop': function(candles, i, position, ctx) {
    if (!position || position.side !== 'BUY') return null;
    var p = position;
    var hi = candles[i].high;
    if (!p._trailHi || hi > p._trailHi) p._trailHi = hi;
    var sl = p._trailHi * (1 - ctx.params.trailStop);
    return (candles[i].close <= sl) ? 'Trailing Stop @' + sl.toFixed(0) : null;
  },
  'signal_reverse': function(candles, i, position, ctx) {
    if (!position || position.side !== 'BUY') return null;
    // Check if any STRONG entry rule fires in opposite direction
    for (var r = 0; r < (ctx.entryRules||[]).length; r++) {
      var rule = ctx.entryRules[r];
      if (!rule.enabled || rule.weight <= 0) continue;
      var sig = RuleEvaluators[rule.type](candles, i, rule, ctx);
      if (sig && sig.type === 'SELL' && sig.strength >= 3) return 'Signal Reversal: ' + sig.reason;
    }
    return null;
  },
  'lips_reverse': function(candles, i, position, ctx) {
    if (!position || position.side !== 'BUY') return null;
    var price = candles[i].close;
    var lips = ctx.lips[i];
    if (!isNaN(lips) && price < lips && candles[i-1].close >= (ctx.lips[i-1]||lips)) {
      return 'Lips breakdown';
    }
    return null;
  },
  'time_exit': function(candles, i, position, ctx) {
    if (!position || position.side !== 'BUY') return null;
    var barsHeld = i - position.entryIndex;
    return (barsHeld >= ctx.params.maxBars) ? 'Time Exit (' + barsHeld + ' bars)' : null;
  },

  // === FILTER rules === return true (pass) / false (block)
  'ao_direction': function(candles, i, signal, ctx) {
    if (isNaN(ctx.ao[i])) return false;
    if (signal.type === 'BUY') return ctx.ao[i] > 0;
    return ctx.ao[i] < 0;
  },
  'alligator_sleeping': function(candles, i, signal, ctx) {
    var jaw = ctx.jaw[i], teeth = ctx.teeth[i], lips = ctx.lips[i];
    if (isNaN(jaw) || isNaN(teeth) || isNaN(lips)) return false;
    var spread = Math.abs(Math.max(jaw, teeth, lips) - Math.min(jaw, teeth, lips)) / candles[i].close;
    return spread >= ctx.params.minSpread;
  },
  'trend_align': function(candles, i, signal, ctx) {
    if (!ctx._getMA10) return true;
    var ma10=ctx._getMA10(),ma20=ctx._getMA20();
    if (isNaN(ma10[i])||isNaN(ma20[i])) return true;
    if (signal.type==='BUY') return ma10[i]>ma20[i];
    return ma10[i]<ma20[i];
  },
  'volume_ok': function(candles, i, signal, ctx) {
    var avg20=ctx._getAvgVol20?ctx._getAvgVol20():null;
    if(!avg20||isNaN(avg20[i])) return true;
    return candles[i].volume>=avg20[i]*ctx.params.minVolumeRatio;
  },
  'rsi_ok': function(candles, i, signal, ctx) {
    if(!ctx._getRSI14) return true;
    var rsi=ctx._getRSI14();
    if(isNaN(rsi[i])) return true;
    if(signal.type==='BUY') return rsi[i]<ctx.params.rsiMax;
    return rsi[i]>ctx.params.rsiMin;
  }
};

// Available rule templates for generating new rules during evolution
var RuleTemplates = {
  entry: [
    { type: 'fractal_breakout', params: { lookback: 3 }, weight: 1.0, enabled: true },
    { type: 'alligator_align', params: {}, weight: 0.8, enabled: true },
    { type: 'lips_cross', params: {}, weight: 0.5, enabled: true },
    { type: 'ao_zero_cross', params: {}, weight: 0.7, enabled: false },
    { type: 'ma_cross', params: { fastPeriod: 5, slowPeriod: 10 }, weight: 0.4, enabled: false }
  ],
  exit: [
    { type: 'stop_loss', params: {}, weight: 1.0, enabled: true },
    { type: 'take_profit', params: {}, weight: 1.0, enabled: true },
    { type: 'trailing_stop', params: {}, weight: 0.8, enabled: true },
    { type: 'signal_reverse', params: {}, weight: 0.6, enabled: false },
    { type: 'lips_reverse', params: {}, weight: 0.5, enabled: true },
    { type: 'time_exit', params: {}, weight: 0.3, enabled: false }
  ],
  filter: [
    { type: 'ao_direction', params: {}, weight: 0.8, enabled: true },
    { type: 'alligator_sleeping', params: {}, weight: 1.0, enabled: true },
    { type: 'trend_align', params: {}, weight: 0.5, enabled: false },
    { type: 'volume_ok', params: {}, weight: 0.3, enabled: false },
    { type: 'rsi_ok', params: {}, weight: 0.4, enabled: false }
  ]
};

// ---- Strategy constructor ----
function createStrategy(name, version, desc, params, entryRules, exitRules, filterRules) {
  return {
    name: name || 'EvoStrategy',
    version: version || '1.0.0',
    description: desc || 'Self-evolving rule-based strategy',
    generation: 0,
    parentInfo: 'original',

    params: params || {
      jawPeriod: 13, teethPeriod: 8, lipsPeriod: 5,
      aoFast: 5, aoSlow: 34,
      positionSize: 0.95,
      stopLoss: 0.03, takeProfit: 0.05,
      trailStop: 0.04, maxBars: 50,
      minSpread: 0.0003, minVolumeRatio: 0.5,
      rsiMax: 75, rsiMin: 25
    },

    entryRules: entryRules || [
      { id: 'e1', type: 'fractal_breakout', params: { lookback: 3 }, weight: 1.0, enabled: true },
      { id: 'e2', type: 'alligator_align', params: {}, weight: 0.8, enabled: true },
      { id: 'e3', type: 'lips_cross', params: {}, weight: 0.5, enabled: true },
      { id: 'e4', type: 'ao_zero_cross', params: {}, weight: 0.7, enabled: false },
      { id: 'e5', type: 'ma_cross', params: { fastPeriod: 5, slowPeriod: 10 }, weight: 0.4, enabled: false }
    ],

    exitRules: exitRules || [
      { id: 'x1', type: 'stop_loss', params: {}, weight: 1.0, enabled: true },
      { id: 'x2', type: 'take_profit', params: {}, weight: 1.0, enabled: true },
      { id: 'x3', type: 'trailing_stop', params: {}, weight: 0.8, enabled: true },
      { id: 'x4', type: 'signal_reverse', params: {}, weight: 0.6, enabled: false },
      { id: 'x5', type: 'lips_reverse', params: {}, weight: 0.5, enabled: true },
      { id: 'x6', type: 'time_exit', params: {}, weight: 0.3, enabled: false }
    ],

    filterRules: filterRules || [
      { id: 'f1', type: 'ao_direction', params: {}, weight: 0.8, enabled: true },
      { id: 'f2', type: 'alligator_sleeping', params: {}, weight: 1.0, enabled: true },
      { id: 'f3', type: 'trend_align', params: {}, weight: 0.5, enabled: false },
      { id: 'f4', type: 'volume_ok', params: {}, weight: 0.3, enabled: false },
      { id: 'f5', type: 'rsi_ok', params: {}, weight: 0.4, enabled: false }
    ],

    // ---- Build context for rule evaluation (indicators precomputed, lazily) ----
    _buildContext: function(candles) {
      var mp = candles.map(function(c) { return (c.high + c.low) / 2; });
      var self = this;
      var ctx = {
        jaw: _smma(mp, this.params.jawPeriod),
        teeth: _smma(mp, this.params.teethPeriod),
        lips: _smma(mp, this.params.lipsPeriod),
        ao: (function(self) {
          var f = _sma(mp, self.params.aoFast);
          var s = _sma(mp, self.params.aoSlow);
          return mp.map(function(_, i) { return (isNaN(f[i]) || isNaN(s[i])) ? NaN : f[i] - s[i]; });
        })(this),
        params: this.params,
        entryRules: this.entryRules,
        exitRules: this.exitRules,
        filterRules: this.filterRules,
        // Lazy precomputed indicators — only built if needed
        _getCloses: function() { if(!this._closes)this._closes=candles.map(function(c){return c.close}); return this._closes; },
        _getMA10: function() { if(!this.__ma10)this.__ma10=_sma(this._getCloses(),10); return this.__ma10; },
        _getMA20: function() { if(!this.__ma20)this.__ma20=_sma(this._getCloses(),20); return this.__ma20; },
        _getAvgVol20: function() {
          if(this.__avgVol20)return this.__avgVol20;
          var a=[],s=0;
          for(var vi=0;vi<candles.length;vi++){s+=candles[vi].volume;if(vi>=20)s-=candles[vi-20].volume;a.push(s/Math.min(20,vi+1))}
          this.__avgVol20=a;return a;
        },
        _getRSI14: function() { if(!this.__rsi14)this.__rsi14=_calcRSI(this._getCloses(),14); return this.__rsi14; }
      };
      return ctx;
    },

    // ---- Generate signal at index ----
    generateSignal: function(candles, index, prebuiltCtx) {
      var minIdx = Math.max(this.params.jawPeriod, this.params.aoSlow) + 5;
      if (index < minIdx) return null;
      var ctx = prebuiltCtx || this._buildContext(candles);
      var i = index;

      // Evaluate all entry rules
      var bestSignal = null, bestScore = 0;
      for (var r = 0; r < this.entryRules.length; r++) {
        var rule = this.entryRules[r];
        if (!rule.enabled || rule.weight <= 0) continue;
        var sig = RuleEvaluators[rule.type] ? RuleEvaluators[rule.type](candles, i, rule, ctx) : null;
        if (!sig) continue;

        // Apply filter rules
        var blocked = false, blockReason = '';
        for (var f = 0; f < this.filterRules.length; f++) {
          var fr = this.filterRules[f];
          if (!fr.enabled || fr.weight <= 0) continue;
          if (RuleEvaluators[fr.type] && !RuleEvaluators[fr.type](candles, i, sig, ctx)) {
            blocked = true; blockReason = fr.type; break;
          }
        }
        if (blocked) continue;

        var score = sig.strength * rule.weight;
        if (score > bestScore) { bestSignal = sig; bestScore = score; }
      }
      return bestSignal;
    },

    // ---- Check exit conditions ----
    _checkExit: function(candles, index, position, ctx) {
      for (var r = 0; r < this.exitRules.length; r++) {
        var rule = this.exitRules[r];
        if (!rule.enabled || rule.weight <= 0) continue;
        if (RuleEvaluators[rule.type]) {
          var reason = RuleEvaluators[rule.type](candles, index, position, ctx);
          if (reason) return reason;
        }
      }
      return null;
    },

    // ---- Backtest ----
    backtest: function(candles, initialCapital) {
      initialCapital = initialCapital || 100000;
      var capital = initialCapital, position = null;
      var trades = [], equityCurve = [];
      var ctx = this._buildContext(candles);

      for (var i = 0; i < candles.length; i++) {
        var price = candles[i].close;
        equityCurve.push({ time: candles[i].time, value: capital + (position ? position.qty * price : 0) });

        // Check exit on open position
        if (position && position.side === 'BUY') {
          var exitReason = this._checkExit(candles, i, position, ctx);
          if (exitReason) {
            var pnl = (price - position.entryPrice) * position.qty;
            capital += position.qty * price;
            trades.push({ time: candles[i].time, type: 'SELL', price: price,
              qty: +position.qty.toFixed(6), pnl: +pnl.toFixed(2), reason: exitReason,
              barsHeld: i - position.entryIndex });
            position = null;
            continue;
          }
        }

        var signal = this.generateSignal(candles, i, ctx);
        if (!signal) continue;

        if (signal.type === 'BUY' && !position) {
          var amount = capital * this.params.positionSize;
          var qty = amount / price;
          position = { side: 'BUY', qty: qty, entryPrice: price, entryIndex: i, _trailHi: candles[i].high };
          capital -= amount;
          trades.push({ time: candles[i].time, type: 'BUY', price: price,
            qty: +qty.toFixed(6), pnl: 0, reason: signal.reason + ' [s:' + signal.strength + ']' });
        }
        // Strong opposite signal closes position
        else if (signal.type === 'SELL' && signal.strength >= 3 && position && position.side === 'BUY') {
          var _pnl = (price - position.entryPrice) * position.qty;
          capital += position.qty * price;
          trades.push({ time: candles[i].time, type: 'SELL', price: price,
            qty: +position.qty.toFixed(6), pnl: +_pnl.toFixed(2),
            reason: 'Reversal: ' + signal.reason, barsHeld: i - position.entryIndex });
          position = null;
        }
      }

      // Close at end
      if (position) {
        var lastPx = candles[candles.length - 1].close;
        var endPnl = (lastPx - position.entryPrice) * position.qty;
        capital += position.qty * lastPx;
        trades.push({ time: candles[candles.length - 1].time, type: 'SELL', price: lastPx,
          qty: +position.qty.toFixed(6), pnl: +endPnl.toFixed(2), reason: 'End of backtest',
          barsHeld: candles.length - 1 - position.entryIndex });
      }

      var sellTrades = trades.filter(function(t) { return t.type === 'SELL'; });
      var wins = sellTrades.filter(function(t) { return t.pnl > 0; });
      var losses = sellTrades.filter(function(t) { return t.pnl < 0; });
      var entryTrades = trades.filter(function(t) { return t.type === 'BUY'; });

      return {
        initialCapital: initialCapital,
        finalCapital: +capital.toFixed(2),
        totalReturn: +((capital - initialCapital) / initialCapital * 100).toFixed(2),
        totalEntries: entryTrades.length,
        closedTrades: sellTrades.length,
        winningTrades: wins.length,
        losingTrades: losses.length,
        winRate: sellTrades.length > 0 ? +(wins.length / sellTrades.length * 100).toFixed(1) : 0,
        avgBarsHeld: sellTrades.length > 0 ? +(sellTrades.reduce(function(s,t){return s+(t.barsHeld||0)},0)/sellTrades.length).toFixed(1) : 0,
        trades: trades, equityCurve: equityCurve
      };
    },

    // ---- Self-diagnosis: analyze losing trades to guide evolution ----
    _diagnose: function(candles, btResult) {
      var self = this;
      var ctx = this._buildContext(candles);
      var sellTrades = btResult.trades.filter(function(t) { return t.type === 'SELL'; });
      var losingTrades = sellTrades.filter(function(t) { return t.pnl < 0; });
      var diagnosis = { addFilters: [], removeFilters: [], addEntry: [], adjustParams: {} };

      if (losingTrades.length === 0) {
        diagnosis.addEntry.push('ao_zero_cross');
        diagnosis.addEntry.push('ma_cross');
        return diagnosis;
      }

      // Limit analysis to a sample for performance on large datasets
      var maxAnalyze = Math.min(losingTrades.length, 200);
      if (losingTrades.length > maxAnalyze) {
        // Sort by worst P&L first
        losingTrades.sort(function(a, b) { return a.pnl - b.pnl; });
        losingTrades = losingTrades.slice(0, maxAnalyze);
      }

      // Pre-build candle time→index map
      var candleIdxMap = {};
      for (var ci = 0; ci < candles.length; ci++) {
        candleIdxMap[candles[ci].time] = ci;
      }
      // Pre-build entry trade map: for each SELL, find the preceding BUY
      var buyTrades = btResult.trades.filter(function(t) { return t.type === 'BUY'; });
      var buyByTime = {};
      for (var bi = 0; bi < buyTrades.length; bi++) {
        buyByTime[buyTrades[bi].time] = buyTrades[bi];
      }
      var buyTimes = Object.keys(buyByTime).map(Number).sort(function(a, b) { return a - b; });

      // Analyze each losing trade
      var filterFailCounts = {};
      for (var lt = 0; lt < losingTrades.length; lt++) {
        var trade = losingTrades[lt];
        // Binary search for the preceding buy
        var lo = 0, hi = buyTimes.length - 1, entryTime = -1;
        while (lo <= hi) {
          var mid = Math.floor((lo + hi) / 2);
          if (buyTimes[mid] <= trade.time) { entryTime = buyTimes[mid]; lo = mid + 1; }
          else { hi = mid - 1; }
        }
        if (entryTime < 0) continue;
        var entryTrade = buyByTime[entryTime];
        if (!entryTrade) continue;
        var entryIdx = candleIdxMap[entryTrade.time];
        if (entryIdx === undefined) continue;

        // Check which filters would have blocked this entry
        for (var f = 0; f < this.filterRules.length; f++) {
          var fr = this.filterRules[f];
          if (fr.enabled) continue;
          var filterType = fr.type;
          if (RuleEvaluators[filterType]) {
            var wouldPass = RuleEvaluators[filterType](candles, entryIdx, { type: 'BUY' }, ctx);
            if (!wouldPass) {
              filterFailCounts[filterType] = (filterFailCounts[filterType] || 0) + 1;
            }
          }
        }
      }

      // Filters that would have blocked >30% of losing trades
      var lossThreshold = Math.max(1, losingTrades.length * 0.3);
      for (var ft in filterFailCounts) {
        if (filterFailCounts[ft] >= lossThreshold) {
          diagnosis.addFilters.push(ft);
        }
      }

      // If win rate is good but few trades, add entry rules
      if (btResult.winRate > 50 && btResult.totalEntries < 5) {
        diagnosis.addEntry.push('ao_zero_cross');
        diagnosis.addEntry.push('lips_cross');
      }

      // If win rate is low, add more filters
      if (btResult.winRate < 40 && diagnosis.addFilters.length === 0) {
        var allFilters = ['trend_align', 'volume_ok', 'rsi_ok', 'ao_direction'];
        for (var af = 0; af < allFilters.length; af++) {
          if (diagnosis.addFilters.indexOf(allFilters[af]) < 0) {
            diagnosis.addFilters.push(allFilters[af]);
            break;
          }
        }
      }

      // Parameter adjustment suggestions
      if (btResult.avgBarsHeld < 3) {
        diagnosis.adjustParams.takeProfit = Math.min(0.08, this.params.takeProfit * 1.3);
      }
      if (losingTrades.length > btResult.winningTrades) {
        diagnosis.adjustParams.stopLoss = Math.max(0.01, this.params.stopLoss * 0.8);
      }

      return diagnosis;
    },

    // ---- Clone with deep copy ----
    _clone: function() {
      return createStrategy(
        this.name, this.version, this.description,
        JSON.parse(JSON.stringify(this.params)),
        JSON.parse(JSON.stringify(this.entryRules)),
        JSON.parse(JSON.stringify(this.exitRules)),
        JSON.parse(JSON.stringify(this.filterRules))
      );
    },

    // ---- Mutate: return a mutated copy ----
    _mutate: function(diagnosis) {
      var mutant = this._clone();
      mutant.generation = (this.generation || 0) + 1;
      mutant.parentInfo = this.name + '-gen' + (this.generation||0);
      var ruleIdCounter = 100;

      // --- Parameter mutation (always) ---
      var paramKeys = ['jawPeriod','teethPeriod','lipsPeriod','aoFast','aoSlow','stopLoss','takeProfit','trailStop','minSpread','minVolumeRatio'];
      for (var pk = 0; pk < paramKeys.length; pk++) {
        var key = paramKeys[pk];
        if (Math.random() < 0.35) {
          var val = mutant.params[key];
          var delta = val * (Math.random() - 0.5) * 0.4;
          var newVal = val + delta;
          if (['jawPeriod','teethPeriod','lipsPeriod','aoFast','aoSlow'].indexOf(key) >= 0) {
            newVal = Math.round(newVal);
          }
          if (key === 'jawPeriod') newVal = Math.max(7, Math.min(21, newVal));
          if (key === 'teethPeriod') newVal = Math.max(5, Math.min(13, newVal));
          if (key === 'lipsPeriod') newVal = Math.max(3, Math.min(8, newVal));
          if (key === 'aoFast') newVal = Math.max(3, Math.min(8, newVal));
          if (key === 'aoSlow') newVal = Math.max(21, Math.min(55, newVal));
          if (key === 'stopLoss') newVal = Math.max(0.005, Math.min(0.08, newVal));
          if (key === 'takeProfit') newVal = Math.max(0.01, Math.min(0.15, newVal));
          mutant.params[key] = +newVal.toFixed(4);
        }
      }
      // Keep jaw > teeth > lips
      if (mutant.params.jawPeriod <= mutant.params.teethPeriod) mutant.params.jawPeriod = mutant.params.teethPeriod + 2;
      if (mutant.params.teethPeriod <= mutant.params.lipsPeriod) mutant.params.teethPeriod = mutant.params.lipsPeriod + 2;

      // --- Rule mutations ---
      var allRules = [
        { arr: mutant.entryRules, cat: 'entry' },
        { arr: mutant.exitRules, cat: 'exit' },
        { arr: mutant.filterRules, cat: 'filter' }
      ];

      for (var ar = 0; ar < allRules.length; ar++) {
        var ruleArr = allRules[ar].arr;
        for (var ri = 0; ri < ruleArr.length; ri++) {
          if (Math.random() < 0.25) {
            // Toggle enabled
            ruleArr[ri].enabled = !ruleArr[ri].enabled;
          }
          if (Math.random() < 0.20) {
            // Adjust weight
            ruleArr[ri].weight = +(Math.max(0, Math.min(2, ruleArr[ri].weight + (Math.random()-0.5)*0.5)).toFixed(2));
          }
          if (Math.random() < 0.15 && ruleArr[ri].type === 'fractal_breakout') {
            ruleArr[ri].params.lookback = Math.max(1, Math.min(6, ruleArr[ri].params.lookback + (Math.random()>0.5?1:-1)));
          }
          if (Math.random() < 0.15 && ruleArr[ri].type === 'ma_cross') {
            ruleArr[ri].params.fastPeriod = Math.max(3, Math.min(10, ruleArr[ri].params.fastPeriod + (Math.random()>0.5?2:-2)));
            ruleArr[ri].params.slowPeriod = Math.max(ruleArr[ri].params.fastPeriod+3, Math.min(40, ruleArr[ri].params.slowPeriod + (Math.random()>0.5?5:-5)));
          }
        }

        // Remove a rule (10% chance, if > 2 rules)
        if (ruleArr.length > 2 && Math.random() < 0.10) {
          // Prefer removing disabled or low-weight rules
          ruleArr.sort(function(a, b) { return a.weight - b.weight; });
          ruleArr.shift();
        }
      }

      // --- Add new filters based on diagnosis ---
      if (diagnosis && diagnosis.addFilters) {
        for (var df = 0; df < diagnosis.addFilters.length; df++) {
          var ft = diagnosis.addFilters[df];
          // Check if not already enabled
          var exists = mutant.filterRules.some(function(r) { return r.type === ft && r.enabled; });
          if (!exists) {
            // Enable existing or add new
            var existing = mutant.filterRules.find(function(r) { return r.type === ft; });
            if (existing) { existing.enabled = true; existing.weight = 0.8; }
            else {
              mutant.filterRules.push({ id: 'f' + (++ruleIdCounter), type: ft, params: {}, weight: 0.7, enabled: true });
            }
          }
        }
      }

      // --- Add entry rules based on diagnosis ---
      if (diagnosis && diagnosis.addEntry) {
        for (var de = 0; de < diagnosis.addEntry.length; de++) {
          var et = diagnosis.addEntry[de];
          var ex2 = mutant.entryRules.some(function(r) { return r.type === et && r.enabled; });
          if (!ex2) {
            var ex = mutant.entryRules.find(function(r) { return r.type === et; });
            if (ex) { ex.enabled = true; ex.weight = 0.6; }
            else {
              mutant.entryRules.push({ id: 'e' + (++ruleIdCounter), type: et, params: et==='ma_cross'?{fastPeriod:5,slowPeriod:10}:{}, weight: 0.5, enabled: true });
            }
          }
        }
      }

      // --- Small chance: add random new rule from template ---
      if (Math.random() < 0.15) {
        var cats = ['entry', 'exit', 'filter'];
        var cat = cats[Math.floor(Math.random() * 3)];
        var templates = RuleTemplates[cat];
        var t = templates[Math.floor(Math.random() * templates.length)];
        var targetArr = cat === 'entry' ? mutant.entryRules : (cat === 'exit' ? mutant.exitRules : mutant.filterRules);
        var already = targetArr.some(function(r) { return r.type === t.type; });
        if (!already) {
          targetArr.push({ id: cat[0] + (++ruleIdCounter), type: t.type, params: JSON.parse(JSON.stringify(t.params)), weight: t.weight, enabled: !t.enabled });
        }
      }

      return mutant;
    },

    // ---- Crossover: breed two strategies ----
    _crossover: function(other) {
      var child = this._clone();
      child.generation = Math.max(this.generation, other.generation) + 1;
      child.parentInfo = this.name + ' x ' + other.name;
      child.name = 'EvoStrategy';
      child.version = (parseFloat(this.version) + 0.1).toFixed(1);

      // Mix params
      for (var k in child.params) {
        if (child.params.hasOwnProperty(k) && other.params.hasOwnProperty(k)) {
          child.params[k] = Math.random() < 0.5 ? this.params[k] : other.params[k];
        }
      }

      // Mix rules: randomly select from each parent
      var categories = ['entryRules', 'exitRules', 'filterRules'];
      for (var c = 0; c < categories.length; c++) {
        var cat = categories[c];
        var p1Rules = this[cat], p2Rules = other[cat];
        var allRuleTypes = [];
        var seen = {};
        for (var i = 0; i < p1Rules.length; i++) { if (!seen[p1Rules[i].type]) { allRuleTypes.push(p1Rules[i]); seen[p1Rules[i].type] = true; } }
        for (var j = 0; j < p2Rules.length; j++) { if (!seen[p2Rules[j].type]) { allRuleTypes.push(p2Rules[j]); seen[p2Rules[j].type] = true; } }
        var newRules = [];
        for (var ri = 0; ri < allRuleTypes.length; ri++) {
          var r1 = p1Rules.find(function(r) { return r.type === allRuleTypes[ri].type; });
          var r2 = p2Rules.find(function(r) { return r.type === allRuleTypes[ri].type; });
          var chosen = (Math.random() < 0.5 && r1) ? r1 : (r2 || r1);
          newRules.push(JSON.parse(JSON.stringify(chosen)));
        }
        child[cat] = newRules;
      }

      return child;
    },

    // ---- Iterate: genetic evolution across generations ----
    iterate: function(candles, config) {
      if (!candles || candles.length < 20) return { generations:0, populationSize:0, generationLog:[], bestStrategy:null, bestResult:null, topStrategies:[] };
      config = config || {};
      var popSize = typeof config === 'number' ? 20 : (config.populationSize || 20);
      var generations = typeof config === 'number' ? config : (config.generations || 5);
      var onProgress = config.onProgress || null;
      var self = this;

      // Create initial population from this strategy
      var population = [this._clone()];
      for (var i = 1; i < popSize; i++) {
        population.push(this._mutate(null));
      }

      var bestEver = null, bestEverResult = null;
      var generationLog = [];

      for (var gen = 0; gen < generations; gen++) {
        // Evaluate all individuals
        var scored = [];
        for (var pi = 0; pi < population.length; pi++) {
          var bt = population[pi].backtest(candles);
          scored.push({ strategy: population[pi], result: bt });
        }

        // Sort by totalReturn (could use Sharpe-like: return * winRate/100)
        scored.sort(function(a, b) {
          var scoreA = a.result.totalReturn * (a.result.winRate / 100);
          var scoreB = b.result.totalReturn * (b.result.winRate / 100);
          return scoreB - scoreA;
        });

        if (!bestEver || scored[0].result.totalReturn > bestEverResult.totalReturn) {
          bestEver = scored[0].strategy._clone();
          bestEverResult = scored[0].result;
        }

        generationLog.push({
          generation: gen + 1,
          bestReturn: scored[0].result.totalReturn,
          bestWinRate: scored[0].result.winRate,
          bestTrades: scored[0].result.closedTrades,
          avgReturn: +(scored.reduce(function(s, x) { return s + x.result.totalReturn; }, 0) / scored.length).toFixed(2),
          bestRuleCount: scored[0].strategy.entryRules.filter(function(r){return r.enabled}).length + 'E/' +
                        scored[0].strategy.exitRules.filter(function(r){return r.enabled}).length + 'X/' +
                        scored[0].strategy.filterRules.filter(function(r){return r.enabled}).length + 'F'
        });

        // Progress callback
        if (onProgress) {
          onProgress({
            generation: gen + 1,
            totalGenerations: generations,
            bestReturn: scored[0].result.totalReturn,
            bestWinRate: scored[0].result.winRate,
            bestTrades: scored[0].result.closedTrades,
            pct: Math.round((gen + 1) / generations * 100)
          });
        }

        // Self-diagnosis on the best performer (skip on very large datasets)
        var diagnosis = null;
        if (scored[0].result.trades.length <= 3000) {
          diagnosis = scored[0].strategy._diagnose(candles, scored[0].result);
        }

        // Selection: top 5 survive (elitism)
        var survivors = scored.slice(0, 5).map(function(s) { return s.strategy; });

        // Breed next generation
        var nextGen = survivors.slice(); // Keep survivors

        while (nextGen.length < popSize) {
          if (Math.random() < 0.6 && survivors.length >= 2) {
            // Crossover
            var p1 = survivors[Math.floor(Math.random() * survivors.length)];
            var p2 = survivors[Math.floor(Math.random() * survivors.length)];
            if (p1 !== p2) {
              nextGen.push(p1._crossover(p2)._mutate(diagnosis));
            } else {
              nextGen.push(survivors[Math.floor(Math.random() * survivors.length)]._mutate(diagnosis));
            }
          } else {
            // Mutation only
            var parent = survivors[Math.floor(Math.random() * survivors.length)];
            nextGen.push(parent._mutate(diagnosis));
          }
        }

        // Trim
        population = nextGen.slice(0, popSize);

        // Inject best-ever to prevent regression
        if (Math.random() < 0.5) {
          population[population.length - 1] = bestEver._clone();
        }
      }

      // Final evaluation of best
      if (bestEver) {
        bestEver.name = 'EvoStrategy';
        bestEver.version = (parseFloat(this.version) + 1.0).toFixed(1);
        bestEver.description = 'Evolved from ' + this.name + ' (' + generations + ' gens, pop ' + popSize + ')';
      }

      return {
        generations: generations,
        populationSize: popSize,
        generationLog: generationLog,
        bestStrategy: bestEver,
        bestResult: bestEverResult,
        topStrategies: population.slice(0, 5).map(function(s) {
          var bt;
          try { bt = s.backtest(candles); } catch(e) { bt = { totalReturn:0, winRate:0, closedTrades:0 }; }
          var ers = s.entryRules || [], xrs = s.exitRules || [], frs = s.filterRules || [];
          return {
            name: s.name || 'Mutant',
            params: s.params || {},
            entryRules: ers.filter(function(r){return r.enabled}).map(function(r){return r.type}),
            exitRules: xrs.filter(function(r){return r.enabled}).map(function(r){return r.type}),
            filterRules: frs.filter(function(r){return r.enabled}).map(function(r){return r.type}),
            totalReturn: bt.totalReturn,
            winRate: bt.winRate,
            closedTrades: bt.closedTrades
          };
        })
      };
    },

    // ---- Serialize ----
    serialize: function() {
      return JSON.stringify({
        name: this.name, version: this.version,
        description: this.description,
        generation: this.generation, parentInfo: this.parentInfo,
        params: this.params,
        entryRules: this.entryRules,
        exitRules: this.exitRules,
        filterRules: this.filterRules,
        savedAt: new Date().toISOString().slice(0, 19)
      }, null, 2);
    }
  };
}

// ---- Default Chaos strategy instance ----
var ChaosStrategy = createStrategy(
  'Chaos v2.0', '2.0.0',
  'Self-evolving Chaos — Alligator + AO + Fractals with rule-based genetic evolution',
  undefined, undefined, undefined, undefined
);

// Auto-register
if (typeof window !== 'undefined') {
  window.__loadedStrategy = ChaosStrategy;
}
