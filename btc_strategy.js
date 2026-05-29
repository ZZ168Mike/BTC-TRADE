// ===== BTC Trading Strategy — Bill Williams Trading Chaos =====
// 纯《证券混沌操作法》实现：鳄鱼线+分形+AO+AC 四大工具
// 开仓/加仓/止损/止盈完全遵从原著规则

// ---- Indicators ----
function _smma(data, period) {
  var result=[],len=data.length;
  for(var i=0;i<len;i++){
    if(i<period){result.push(NaN);continue}
    if(i===period){var s=0;for(var j=0;j<period;j++)s+=data[i-j];result.push(s/period)}
    else result.push((result[i-1]*(period-1)+data[i])/period);
  }
  return result;
}
function _sma(data,period){
  var result=[],len=data.length,sum=0;
  for(var i=0;i<len;i++){
    if(i<period-1){result.push(NaN);sum+=data[i];continue}
    if(i===period-1){sum+=data[i];result.push(sum/period)}
    else{sum=sum-data[i-period]+data[i];result.push(sum/period)}
  }
  return result;
}
function _calcRSI(closes,period){
  period=period||14;
  var gains=[],losses=[],rsi=[];
  for(var i=1;i<closes.length;i++){var d=closes[i]-closes[i-1];gains.push(d>0?d:0);losses.push(d<0?-d:0)}
  var ag=0,al=0;
  for(var j=0;j<period;j++){ag+=gains[j];al+=losses[j]}
  ag/=period;al/=period;
  for(var k=0;k<closes.length;k++){
    if(k<period){rsi.push(NaN);continue}
    if(k===period){rsi.push(al===0?100:100-100/(1+ag/al));continue}
    var idx=k-1;
    ag=(ag*(period-1)+gains[idx])/period;al=(al*(period-1)+losses[idx])/period;
    rsi.push(al===0?100:100-100/(1+ag/al));
  }
  return rsi;
}

// ---- Rule Evaluators ----
var RuleEvaluators={

  // ═══════════ ENTRY — 混沌入场信号 ═══════════
  'fractal_breakout':function(candles,i,rule,ctx){
    // 分形突破入场（5根K线分形，必须高于/低于牙齿线）
    var p=rule.params||{},lookback=p.lookback||3,price=candles[i].close;
    if(i<5)return null;
    // Find recent fractal
    var buyFractal=null,sellFractal=null;
    for(var k=lookback;k>=1;k--){
      var idx=i-k;if(idx<2||idx>=candles.length-2)continue;
      var h=candles[idx].high,l=candles[idx].low;
      var isBuyFractal=h>candles[idx-1].high&&h>candles[idx-2].high&&h>candles[idx+1].high&&h>candles[idx+2].high;
      var isSellFractal=l<candles[idx-1].low&&l<candles[idx-2].low&&l<candles[idx+1].low&&l<candles[idx+2].low;
      if(isBuyFractal&&!buyFractal)buyFractal={idx:idx,price:h};
      if(isSellFractal&&!sellFractal)sellFractal={idx:idx,price:l};
    }
    // Buy: fractal above teeth + price breaking above fractal + AO>0
    if(buyFractal&&!isNaN(ctx.teeth[buyFractal.idx])&&buyFractal.price>ctx.teeth[buyFractal.idx]){
      if(price>buyFractal.price&&candles[i-1].close<=buyFractal.price&&ctx.ao[i]>0)
        return{type:'BUY',strength:3,reason:'分形突破做多 @'+buyFractal.price.toFixed(0)};
    }
    // Sell: fractal below teeth + price breaking below fractal + AO<0
    if(sellFractal&&!isNaN(ctx.teeth[sellFractal.idx])&&sellFractal.price<ctx.teeth[sellFractal.idx]){
      if(price<sellFractal.price&&candles[i-1].close>=sellFractal.price&&ctx.ao[i]<0)
        return{type:'SELL',strength:3,reason:'分形突破做空 @'+sellFractal.price.toFixed(0)};
    }
    return null;
  },

  'ao_saucer':function(candles,i,rule,ctx){
    // AO碟型信号（零轴上方：红→绿→红=买入；零轴下方：绿→红→绿=卖出）
    var ao=ctx.ao;
    if(i<5||isNaN(ao[i])||isNaN(ao[i-1])||isNaN(ao[i-2])||isNaN(ao[i-3]))return null;
    // Need 4 bars: bar[i-3], bar[i-2], bar[i-1], bar[i]
    var b0=ao[i],b1=ao[i-1],b2=ao[i-2],b3=ao[i-3];
    // Buy saucer (above zero): red(b3) → green(b2) → red(b1) → green(b0) after red
    // Simplified: bar-1 was negative (red), bar-2 was positive (green), bar-3 was negative (red), all above zero
    if(b3<0&&b2>0&&b1<0&&b0>0&&b3>ctx.ao[i-4]&&b0>b1)
      return{type:'BUY',strength:2,reason:'AO碟型买入信号'};
    // Sell saucer (below zero)
    if(b3>0&&b2<0&&b1>0&&b0<0&&b3<ctx.ao[i-4]&&b0<b1)
      return{type:'SELL',strength:2,reason:'AO碟型卖出信号'};
    // Simplified saucer (3 bar): green→red→green above zero = buy
    if(b2>0&&b1<0&&b0>0&&ao[i-2]>0&&b0>b1)
      return{type:'BUY',strength:2,reason:'AO碟型买入(简)'};
    if(b2<0&&b1>0&&b0<0&&ao[i-2]<0&&b0<b1)
      return{type:'SELL',strength:2,reason:'AO碟型卖出(简)'};
    return null;
  },

  'ao_twin_peaks':function(candles,i,rule,ctx){
    // AO双峰信号
    var ao=ctx.ao;if(i<6)return null;
    // Search back ~20 bars for previous peak
    var isBuy=ao[i]>0&&ao[i-1]<=0; // Just crossed above zero → look for twin peaks below zero
    var isSell=ao[i]<0&&ao[i-1]>=0; // Just crossed below zero
    if(!isBuy&&!isSell)return null;
    // Find last peak below zero (for buy) or above zero (for sell)
    var peakVal=0,peakIdx=-1;
    for(var k=i-3;k>Math.max(0,i-25);k--){
      if(isBuy&&ao[k]<0&&ao[k]>ao[k-1]&&ao[k]>ao[k+1]){if(ao[k]>peakVal){peakVal=ao[k];peakIdx=k}}
      if(isSell&&ao[k]>0&&ao[k]<ao[k-1]&&ao[k]<ao[k+1]){if(ao[k]<peakVal||peakVal===0){peakVal=ao[k];peakIdx=k}}
    }
    if(peakIdx<0)return null;
    if(isBuy&&ao[i]>peakVal)return{type:'BUY',strength:2,reason:'AO双峰买入'};
    if(isSell&&ao[i]<peakVal)return{type:'SELL',strength:2,reason:'AO双峰卖出'};
    return null;
  },

  'ao_zero_cross':function(candles,i,rule,ctx){
    var ao=ctx.ao[i],aoPrev=ctx.ao[i-1]||NaN;
    if(isNaN(ao)||isNaN(aoPrev))return null;
    if(aoPrev<=0&&ao>0)return{type:'BUY',strength:1,reason:'AO穿越零轴向上'};
    if(aoPrev>=0&&ao<0)return{type:'SELL',strength:1,reason:'AO穿越零轴向下'};
    return null;
  },

  'alligator_bite':function(candles,i,rule,ctx){
    // 鳄鱼嘴张开 + 价格在嘴外 = 趋势确认
    var jaw=ctx.jaw[i],teeth=ctx.teeth[i],lips=ctx.lips[i];
    if(isNaN(jaw)||isNaN(teeth)||isNaN(lips))return null;
    var price=candles[i].close;
    var spread=Math.abs(lips-jaw)/price;
    if(spread<0.0003)return null; // 嘴没张开
    if(lips>teeth&&teeth>jaw&&price>lips)
      return{type:'BUY',strength:2,reason:'鳄鱼多头排列+价格在嘴唇上方'};
    if(lips<teeth&&teeth<jaw&&price<lips)
      return{type:'SELL',strength:2,reason:'鳄鱼空头排列+价格在嘴唇下方'};
    return null;
  },

  // ═══════════ EXIT — 混沌离场规则 ═══════════
  'fractal_stop':function(candles,i,position,ctx){
    // 分形止损：做多止损在最近买入分形低点下方，做空止损在最近卖出分形高点上方
    if(!position||i<5)return null;
    var isLong=!position.side||position.side!=='SHORT';
    var recentFractalLow=Infinity,recentFractalHigh=-Infinity;
    for(var k=1;k<=20;k++){
      var idx=i-k;if(idx<2||idx>=candles.length-2)continue;
      var h=candles[idx].high,l=candles[idx].low;
      if(h>candles[idx-1].high&&h>candles[idx-2].high&&h>candles[idx+1].high&&h>candles[idx+2].high)
        recentFractalHigh=Math.min(recentFractalHigh,h);
      if(l<candles[idx-1].low&&l<candles[idx-2].low&&l<candles[idx+1].low&&l<candles[idx+2].low)
        recentFractalLow=Math.max(recentFractalLow,l);
    }
    if(isLong&&recentFractalLow<Infinity&&candles[i].close<recentFractalLow)
      return'分形止损: 跌破前分形低点';
    if(!isLong&&recentFractalHigh>-Infinity&&candles[i].close>recentFractalHigh)
      return'分形止损: 升穿前分形高点';
    return null;
  },

  'lips_stop':function(candles,i,position,ctx){
    // 鳄鱼嘴唇止损：价格反向穿越嘴唇线
    var price=candles[i].close,prevPrice=candles[i-1].close;
    var lips=ctx.lips[i],prevLips=ctx.lips[i-1];
    if(isNaN(lips)||isNaN(prevLips))return null;
    var isLong=!position.side||position.side!=='SHORT';
    if(isLong&&prevPrice>=prevLips&&price<lips)return'嘴唇止损: 价格跌破唇线';
    if(!isLong&&prevPrice<=prevLips&&price>lips)return'嘴唇止损: 价格升穿唇线';
    return null;
  },

  'ao_flip':function(candles,i,position,ctx){
    // AO方向翻转：多仓时AO从正变负（或连续3根下降），空仓反之
    var ao=ctx.ao;if(i<3)return null;
    var isLong=!position.side||position.side!=='SHORT';
    if(isLong&&ao[i]<0&&ao[i-1]>=0)return'AO翻转向下-离场';
    if(!isLong&&ao[i]>0&&ao[i-1]<=0)return'AO翻转向上-离场';
    // 3 bar AO reversal
    if(isLong&&ao[i]<ao[i-1]&&ao[i-1]<ao[i-2]&&ao[i-2]<ao[i-3])return'AO连续4根下降-动量衰竭';
    if(!isLong&&ao[i]>ao[i-1]&&ao[i-1]>ao[i-2]&&ao[i-2]>ao[i-3])return'AO连续4根上升-动量衰竭';
    return null;
  },

  'opposite_fractal':function(candles,i,position,ctx){
    // 反向分形突破 → 趋势反转，全部离场
    if(!position||i<5)return null;
    var isLong=!position.side||position.side!=='SHORT';
    var price=candles[i].close;
    for(var k=1;k<=5;k++){
      var idx=i-k;if(idx<2||idx>=candles.length-2)continue;
      var h=candles[idx].high,l=candles[idx].low;
      var buyFract=h>candles[idx-1].high&&h>candles[idx-2].high&&h>candles[idx+1].high&&h>candles[idx+2].high;
      var sellFract=l<candles[idx-1].low&&l<candles[idx-2].low&&l<candles[idx+1].low&&l<candles[idx+2].low;
      if(!isLong&&buyFract&&price>h&&!isNaN(ctx.teeth[idx])&&h>ctx.teeth[idx])
        return'反向分形: 多头突破-空仓离场';
      if(isLong&&sellFract&&price<l&&!isNaN(ctx.teeth[idx])&&l<ctx.teeth[idx])
        return'反向分形: 空头突破-多仓离场';
    }
    return null;
  },

  'time_exit':function(candles,i,position,ctx){
    var barsHeld=i-(position.entryIndex||position._entryIdx||0);
    return(barsHeld>=ctx.params.maxBars)?'超时离场('+barsHeld+'根K线)':null;
  },

  // ═══════════ FILTERS ═══════════
  'alligator_awake':function(candles,i,signal,ctx){
    // 鳄鱼必须醒着（嘴张开），缠绕则不交易
    var jaw=ctx.jaw[i],teeth=ctx.teeth[i],lips=ctx.lips[i];
    if(isNaN(jaw)||isNaN(teeth)||isNaN(lips))return false;
    var spread=Math.abs(Math.max(jaw,teeth,lips)-Math.min(jaw,teeth,lips))/candles[i].close;
    return spread>=0.0003; // 0.03% spread minimum
  },

  'ao_confirm':function(candles,i,signal,ctx){
    // AO必须确认方向
    if(isNaN(ctx.ao[i]))return false;
    if(signal.type==='BUY')return ctx.ao[i]>0;
    return ctx.ao[i]<0;
  },

  'ac_confirm':function(candles,i,signal,ctx){
    // AC指标确认
    if(!ctx.ac||isNaN(ctx.ac[i]))return true;
    // AC与AO同向
    if(signal.type==='BUY')return ctx.ac[i]>0||ctx.ac[i]>ctx.ac[i-1];
    return ctx.ac[i]<0||ctx.ac[i]<ctx.ac[i-1];
  },

  'volume_ok':function(candles,i,signal,ctx){
    if(!ctx._getAvgVol20||isNaN(ctx._getAvgVol20()[i]))return true;
    return candles[i].volume>=ctx._getAvgVol20()[i]*0.5;
  },

  'rsi_ok':function(candles,i,signal,ctx){
    if(!ctx._getRSI14||isNaN(ctx._getRSI14()[i]))return true;
    var rsi=ctx._getRSI14();
    if(signal.type==='BUY')return rsi[i]<90;
    return rsi[i]>10;
  }
};

// ---- Rule Templates ----
var RuleTemplates={
  entry:[
    {type:'fractal_breakout',params:{lookback:3},weight:1.0,enabled:true},
    {type:'ao_saucer',params:{},weight:0.8,enabled:true},
    {type:'ao_twin_peaks',params:{},weight:0.7,enabled:true},
    {type:'ao_zero_cross',params:{},weight:0.5,enabled:true},
    {type:'alligator_bite',params:{},weight:0.6,enabled:true}
  ],
  exit:[
    {type:'fractal_stop',params:{},weight:1.0,enabled:true},
    {type:'lips_stop',params:{},weight:1.0,enabled:true},
    {type:'ao_flip',params:{},weight:0.8,enabled:true},
    {type:'opposite_fractal',params:{},weight:1.0,enabled:true},
    {type:'time_exit',params:{},weight:0.3,enabled:true}
  ],
  filter:[
    {type:'alligator_awake',params:{},weight:1.0,enabled:true},
    {type:'ao_confirm',params:{},weight:1.0,enabled:true},
    {type:'ac_confirm',params:{},weight:0.5,enabled:false},
    {type:'volume_ok',params:{},weight:0.3,enabled:false},
    {type:'rsi_ok',params:{},weight:0.2,enabled:false}
  ]
};

// ---- Strategy constructor ----
function createStrategy(name,version,desc,params,entryRules,exitRules,filterRules){
  return{
    name:name||'TradingChaos',
    version:version||'1.0.0',
    description:desc||'Bill Williams Trading Chaos — Alligator + Fractals + AO + AC',
    generation:0,parentInfo:'original',

    params:params||{
      // Alligator (with right-shift per Williams)
      jawPeriod:13,jawShift:8,
      teethPeriod:8,teethShift:5,
      lipsPeriod:5,lipsShift:3,
      // AO
      aoFast:5,aoSlow:34,
      // Risk
      leverage:200,
      positionSize:0.05,     // 5% per trade
      maxMargin:100,         // max $100 margin per entry
      maxLayers:3,           // 3-step adding (AC based)
      maxBars:100            // safety exit
    },

    entryRules:entryRules||[
      {id:'e1',type:'fractal_breakout',params:{lookback:3},weight:1.0,enabled:true},
      {id:'e2',type:'ao_saucer',params:{},weight:0.8,enabled:true},
      {id:'e3',type:'ao_twin_peaks',params:{},weight:0.7,enabled:true},
      {id:'e4',type:'ao_zero_cross',params:{},weight:0.5,enabled:true},
      {id:'e5',type:'alligator_bite',params:{},weight:0.6,enabled:true}
    ],

    exitRules:exitRules||[
      {id:'x1',type:'fractal_stop',params:{},weight:1.0,enabled:true},
      {id:'x2',type:'lips_stop',params:{},weight:1.0,enabled:true},
      {id:'x3',type:'ao_flip',params:{},weight:0.8,enabled:true},
      {id:'x4',type:'opposite_fractal',params:{},weight:1.0,enabled:true},
      {id:'x5',type:'time_exit',params:{},weight:0.3,enabled:true}
    ],

    filterRules:filterRules||[
      {id:'f1',type:'alligator_awake',params:{},weight:1.0,enabled:true},
      {id:'f2',type:'ao_confirm',params:{},weight:1.0,enabled:true},
      {id:'f3',type:'ac_confirm',params:{},weight:0.5,enabled:false},
      {id:'f4',type:'volume_ok',params:{},weight:0.3,enabled:false},
      {id:'f5',type:'rsi_ok',params:{},weight:0.2,enabled:false}
    ],

    // ---- Build context with all 4 chaos indicators ----
    _buildContext:function(candles){
      var mp=candles.map(function(c){return(c.high+c.low)/2;});
      var self=this,p=this.params;
      // Alligator with right-shift (Williams原著: Jaw右移8, Teeth右移5, Lips右移3)
      var rawJaw=_smma(mp,p.jawPeriod),rawTeeth=_smma(mp,p.teethPeriod),rawLips=_smma(mp,p.lipsPeriod);
      var jaw=[],teeth=[],lips=[];
      for(var i=0;i<candles.length;i++){
        jaw.push(i>=p.jawShift?rawJaw[i-p.jawShift]:NaN);
        teeth.push(i>=p.teethShift?rawTeeth[i-p.teethShift]:NaN);
        lips.push(i>=p.lipsShift?rawLips[i-p.lipsShift]:NaN);
      }
      // AO (Awesome Oscillator)
      var aoFast=_sma(mp,p.aoFast),aoSlow=_sma(mp,p.aoSlow);
      var ao=mp.map(function(_,i){return(!isNaN(aoFast[i])&&!isNaN(aoSlow[i]))?aoFast[i]-aoSlow[i]:NaN;});
      // AC (Acceleration/Deceleration) = AO - 5-period SMA of AO
      var aoSma5=_sma(ao.map(function(v){return isNaN(v)?0:v;}),5);
      var ac=ao.map(function(v,i){return(!isNaN(v)&&!isNaN(aoSma5[i]))?v-aoSma5[i]:NaN;});
      // Color: positive=green, negative=red
      var aoColor=ao.map(function(v,i){
        if(isNaN(v))return 0;
        if(i===0)return v>=0?1:-1;
        return v>=ao[i-1]?1:-1;
      });
      var acColor=ac.map(function(v,i){
        if(isNaN(v))return 0;
        if(i===0)return v>=0?1:-1;
        return v>=ac[i-1]?1:-1;
      });

      var ctx={
        jaw:jaw,teeth:teeth,lips:lips,ao:ao,ac:ac,aoColor:aoColor,acColor:acColor,
        params:this.params,entryRules:this.entryRules,exitRules:this.exitRules,filterRules:this.filterRules,
        _getCloses:function(){if(!this._closes)this._closes=candles.map(function(c){return c.close});return this._closes;},
        _getMA10:function(){if(!this.__ma10)this.__ma10=_sma(this._getCloses(),10);return this.__ma10;},
        _getMA20:function(){if(!this.__ma20)this.__ma20=_sma(this._getCloses(),20);return this.__ma20;},
        _getAvgVol20:function(){
          if(this.__avgVol20)return this.__avgVol20;
          var a=[],s=0;
          for(var vi=0;vi<candles.length;vi++){s+=candles[vi].volume;if(vi>=20)s-=candles[vi-20].volume;a.push(s/Math.min(20,vi+1));}
          this.__avgVol20=a;return a;
        },
        _getRSI14:function(){if(!this.__rsi14)this.__rsi14=_calcRSI(this._getCloses(),14);return this.__rsi14;}
      };
      return ctx;
    },

    // ---- Generate signal at index ----
    generateSignal:function(candles,index,prebuiltCtx){
      var minIdx=Math.max(this.params.jawPeriod+this.params.jawShift,this.params.aoSlow)+5;
      if(index<minIdx)return null;
      var ctx=prebuiltCtx||this._buildContext(candles);
      var i=index,bestSignal=null,bestScore=0;
      for(var r=0;r<this.entryRules.length;r++){
        var rule=this.entryRules[r];
        if(!rule.enabled||rule.weight<=0)continue;
        var sig=RuleEvaluators[rule.type]?RuleEvaluators[rule.type](candles,i,rule,ctx):null;
        if(!sig)continue;
        // Apply filters
        var blocked=false;
        for(var f=0;f<this.filterRules.length;f++){
          var fr=this.filterRules[f];
          if(!fr.enabled||fr.weight<=0)continue;
          if(RuleEvaluators[fr.type]&&!RuleEvaluators[fr.type](candles,i,sig,ctx)){blocked=true;break;}
        }
        if(blocked)continue;
        var score=sig.strength*rule.weight;
        if(score>bestScore){bestSignal=sig;bestScore=score;}
      }
      return bestSignal;
    },

    // ---- Check exit conditions ----
    _checkExit:function(candles,index,position,ctx){
      for(var r=0;r<this.exitRules.length;r++){
        var rule=this.exitRules[r];
        if(!rule.enabled||rule.weight<=0)continue;
        if(RuleEvaluators[rule.type]){
          var reason=RuleEvaluators[rule.type](candles,index,position,ctx);
          if(reason)return reason;
        }
      }
      return null;
    },

    // ---- Check AC add-position signal (3-step adding) ----
    checkACAdd:function(candles,index,position,ctx){
      if(!ctx.ac||isNaN(ctx.ac[index]))return false;
      var ac=ctx.ac,acC=ctx.acColor;
      if(index<3)return false;
      var isLong=!position.side||position.side!=='SHORT';
      // AC穿越零轴 = 加仓信号
      if(isLong&&ac[index]>0&&ac[index-1]<=0)return true;
      if(!isLong&&ac[index]<0&&ac[index-1]>=0)return true;
      // AC与AO同向连续3根增长
      if(isLong&&acC[index]===1&&acC[index-1]===1&&acC[index-2]===1&&ac[index]>ac[index-1])return true;
      if(!isLong&&acC[index]===-1&&acC[index-1]===-1&&acC[index-2]===-1&&ac[index]<ac[index-1])return true;
      return false;
    },

    // ---- Take profit check (3-step: ATR×2, AO divergence, opposite fractal) ----
    checkTakeProfit:function(candles,index,position,ctx,atr){
      if(!position)return null;
      var price=candles[index].close;
      var isLong=!position.side||position.side!=='SHORT';
      var entryPrice=position.entryPrice||position.entryPrice||0;
      var pnlPct=isLong?(price-entryPrice)/entryPrice:(entryPrice-price)/entryPrice;
      var lev=this.params.leverage||200;
      var capGain=pnlPct*lev*100;

      // Step 1: ATR×2 target → close 1/3
      if(atr&&!isNaN(atr)&&!position._tp1){
        var target=isLong?entryPrice+atr*2:entryPrice-atr*2;
        if(isLong?price>=target:price<=target){
          position._tp1=true;
          return{reason:'TP1: ATR×2目标达成 +'+capGain.toFixed(0)+'%',closePct:0.33};
        }
      }
      // Step 2: AO divergence (AO方向改变)
      if(position._tp1&&!position._tp2&&index>=3){
        var ao=ctx.ao;
        if(isLong&&ao[index]<ao[index-1]&&ao[index-1]<ao[index-2]){
          position._tp2=true;
          return{reason:'TP2: AO动量背离 +'+capGain.toFixed(0)+'%',closePct:0.33};
        }
        if(!isLong&&ao[index]>ao[index-1]&&ao[index-1]>ao[index-2]){
          position._tp2=true;
          return{reason:'TP2: AO动量背离 +'+capGain.toFixed(0)+'%',closePct:0.33};
        }
      }
      // Step 3: Opposite fractal → close remaining
      if(position._tp2&&!position._tp3){
        var sig=this.generateSignal(candles,index,ctx);
        if(sig&&((isLong&&sig.type==='SELL'&&sig.strength>=2)||(!isLong&&sig.type==='BUY'&&sig.strength>=2))){
          position._tp3=true;
          return{reason:'TP3: 反向信号 +'+capGain.toFixed(0)+'%',closePct:1.0};
        }
      }
      return null;
    },

    // ---- Backtest ----
    backtest:function(candles,initialCapital){
      initialCapital=initialCapital||100000;
      var capital=initialCapital,position=null,trades=[],equityCurve=[];
      var ctx=this._buildContext(candles);
      // Calculate ATR for take profit
      var atrVals=[];
      for(var ai=0;ai<candles.length;ai++){
        if(ai===0){atrVals.push(NaN);continue}
        var tr=Math.max(candles[ai].high-candles[ai].low,Math.abs(candles[ai].high-candles[ai-1].close),Math.abs(candles[ai].low-candles[ai-1].close));
        if(ai<14)atrVals.push(NaN);
        else if(ai===14){var s=0;for(var j=0;j<14;j++)s+=Math.max(candles[ai-j].high-candles[ai-j].low,Math.abs(candles[ai-j].high-candles[ai-j-1].close),Math.abs(candles[ai-j].low-candles[ai-j-1].close));atrVals.push(s/14)}
        else atrVals.push((atrVals[ai-1]*13+tr)/14);
      }

      for(var i=0;i<candles.length;i++){
        var price=candles[i].close;
        equityCurve.push({time:candles[i].time,value:capital+(position?position.qty*price:0)});

        if(position){
          // Check exit
          var exitReason=this._checkExit(candles,i,position,ctx);
          // Check take profit
          var tpResult=this.checkTakeProfit(candles,i,position,ctx,atrVals[i]);
          if(tpResult){
            var closeQty=position.qty*tpResult.closePct;
            var tpPnl=position.side==='SHORT'?(position.entryPrice-price)*closeQty:(price-position.entryPrice)*closeQty;
            var tpMargin=position.margin*tpResult.closePct;
            capital+=tpMargin+tpPnl;
            position.qty-=closeQty;
            position.margin-=tpMargin;
            trades.push({time:candles[i].time,type:'TP',price:price,qty:+closeQty.toFixed(6),pnl:+tpPnl.toFixed(2),reason:tpResult.reason,side:position.side});
            if(position.qty<=0)position=null;
            continue;
          }
          if(exitReason){
            var pnl=position.side==='SHORT'?(position.entryPrice-price)*position.qty:(price-position.entryPrice)*position.qty;
            if(pnl<-position.margin)pnl=-position.margin;
            capital+=position.margin+pnl;
            var pnlPct=position.margin>0?(pnl/position.margin*100):0;
            trades.push({time:candles[i].time,type:position.side==='SHORT'?'COVER':'SELL',price:price,qty:+position.qty.toFixed(6),pnl:+pnl.toFixed(2),reason:exitReason,pnlPct:+pnlPct.toFixed(1),barsHeld:i-position.entryIndex,side:position.side});
            position=null;
            continue;
          }
          // Check AC add position
          if(this.checkACAdd(candles,i,position,ctx)&&(position._layers||1)<(this.params.maxLayers||3)){
            var addMargin=Math.min(capital*this.params.positionSize,this.params.maxMargin||100);
            var lev=this.params.leverage||1;
            var addQty=(addMargin*lev)/price;
            position.entryPrice=(position.entryPrice*position.qty+price*addQty)/(position.qty+addQty);
            position.qty+=addQty;
            position.margin+=addMargin;
            position._layers=(position._layers||1)+1;
            capital-=addMargin;
            trades.push({time:candles[i].time,type:'ADD',price:price,qty:+addQty.toFixed(6),pnl:0,reason:'AC加仓 #'+position._layers,side:position.side});
          }
        }

        var signal=this.generateSignal(candles,i,ctx);
        if(!signal)continue;

        if(!position&&(signal.type==='BUY'||signal.type==='SELL')){
          var isShort=signal.type==='SELL';
          var margin=Math.min(capital*this.params.positionSize,this.params.maxMargin||100);
          var lev=this.params.leverage||1;
          var qty=(margin*lev)/price;
          position={side:isShort?'SHORT':'LONG',qty:qty,entryPrice:price,entryIndex:i,margin:margin,leverage:lev,_layers:1};
          capital-=margin;
          trades.push({time:candles[i].time,type:isShort?'SHORT':'LONG',price:price,qty:+qty.toFixed(6),pnl:0,reason:signal.reason+' [s:'+signal.strength+']',side:position.side});
        }
      }

      if(position){
        var lastPx=candles[candles.length-1].close;
        var endPnl=position.side==='SHORT'?(position.entryPrice-lastPx)*position.qty:(lastPx-position.entryPrice)*position.qty;
        if(endPnl<-position.margin)endPnl=-position.margin;
        capital+=position.margin+endPnl;
        trades.push({time:candles[candles.length-1].time,type:'CLOSE',price:lastPx,qty:+position.qty.toFixed(6),pnl:+endPnl.toFixed(2),reason:'End',side:position.side});
      }

      var closedTrades=trades.filter(function(t){return t.pnl!==0;});
      var wins=closedTrades.filter(function(t){return t.pnl>0;});
      var losses=closedTrades.filter(function(t){return t.pnl<0;});
      var entryTrades=trades.filter(function(t){return t.pnl===0;});

      return{
        initialCapital:initialCapital,finalCapital:+capital.toFixed(2),
        totalReturn:+((capital-initialCapital)/initialCapital*100).toFixed(2),
        totalEntries:entryTrades.length,closedTrades:closedTrades.length,
        winningTrades:wins.length,losingTrades:losses.length,
        winRate:closedTrades.length>0?+(wins.length/closedTrades.length*100).toFixed(1):0,
        avgBarsHeld:closedTrades.length>0?+(closedTrades.reduce(function(s,t){return s+(t.barsHeld||0)},0)/closedTrades.length).toFixed(1):0,
        trades:trades,equityCurve:equityCurve
      };
    },

    // ---- Self-diagnosis ----
    _diagnose:function(candles,btResult,liveTrades){
      var ctx=this._buildContext(candles);
      var diagnosis={addFilters:[],removeFilters:[],addEntry:[],adjustParams:{}};
      if(liveTrades&&liveTrades.length>0){
        var liveDiag=this._learnFromTrades(liveTrades,candles);
        for(var ld=0;ld<liveDiag.addFilters.length;ld++){if(diagnosis.addFilters.indexOf(liveDiag.addFilters[ld])<0)diagnosis.addFilters.push(liveDiag.addFilters[ld])}
        for(var le=0;le<liveDiag.addEntry.length;le++){if(diagnosis.addEntry.indexOf(liveDiag.addEntry[le])<0)diagnosis.addEntry.push(liveDiag.addEntry[le])}
        for(var pk2 in liveDiag.adjustParams){diagnosis.adjustParams[pk2]=liveDiag.adjustParams[pk2]}
      }
      var closedTrades=btResult.trades.filter(function(t){return t.pnl!==0;});
      var losingTrades=closedTrades.filter(function(t){return t.pnl<0;});
      if(losingTrades.length===0){diagnosis.addEntry.push('ao_saucer');return diagnosis}
      // Filters to enable
      if(btResult.winRate<40){
        diagnosis.addFilters.push('ac_confirm');diagnosis.addFilters.push('volume_ok');
      }
      return diagnosis;
    },

    _learnFromTrades:function(tradeResults,candles){
      var diagnosis={addFilters:[],removeFilters:[],addEntry:[],adjustParams:{}};
      if(!tradeResults||tradeResults.length===0)return diagnosis;
      var lossCount=0,winCount=0;
      for(var t=0;t<tradeResults.length;t++){if(tradeResults[t].pnl>0)winCount++;else lossCount++}
      if(lossCount>winCount&&lossCount>=3){
        diagnosis.addFilters.push('ac_confirm');diagnosis.addFilters.push('rsi_ok');
      }
      return diagnosis;
    },

    _clone:function(){
      return createStrategy(this.name,this.version,this.description,
        JSON.parse(JSON.stringify(this.params)),JSON.parse(JSON.stringify(this.entryRules)),
        JSON.parse(JSON.stringify(this.exitRules)),JSON.parse(JSON.stringify(this.filterRules)));
    },

    _mutate:function(diagnosis){
      var mutant=this._clone();
      mutant.generation=(this.generation||0)+1;
      mutant.parentInfo=this.name+'-gen'+(this.generation||0);
      var ruleIdCounter=100;

      // Param mutation
      var paramKeys=['jawPeriod','teethPeriod','lipsPeriod','aoFast','aoSlow','leverage','maxBars'];
      for(var pk=0;pk<paramKeys.length;pk++){
        var key=paramKeys[pk];
        if(Math.random()<0.3){
          var val=mutant.params[key],delta=val*(Math.random()-0.5)*0.3,newVal=val+delta;
          if(key==='jawPeriod')newVal=Math.max(7,Math.min(21,Math.round(newVal)));
          if(key==='teethPeriod')newVal=Math.max(5,Math.min(13,Math.round(newVal)));
          if(key==='lipsPeriod')newVal=Math.max(3,Math.min(8,Math.round(newVal)));
          if(key==='aoFast')newVal=Math.max(3,Math.min(8,Math.round(newVal)));
          if(key==='aoSlow')newVal=Math.max(21,Math.min(55,Math.round(newVal)));
          if(key==='leverage')newVal=Math.round(Math.max(10,Math.min(200,newVal)));
          if(key==='maxBars')newVal=Math.max(30,Math.min(200,Math.round(newVal)));
          mutant.params[key]=newVal;
        }
      }
      if(mutant.params.jawPeriod<=mutant.params.teethPeriod)mutant.params.jawPeriod=mutant.params.teethPeriod+2;
      if(mutant.params.teethPeriod<=mutant.params.lipsPeriod)mutant.params.teethPeriod=mutant.params.lipsPeriod+2;

      // Rule toggle
      var allRules=[{arr:mutant.entryRules},{arr:mutant.exitRules},{arr:mutant.filterRules}];
      for(var ar=0;ar<allRules.length;ar++){
        for(var ri=0;ri<allRules[ar].arr.length;ri++){
          if(Math.random()<0.2)allRules[ar].arr[ri].enabled=!allRules[ar].arr[ri].enabled;
          if(Math.random()<0.15)allRules[ar].arr[ri].weight=+Math.max(0.1,Math.min(2,allRules[ar].arr[ri].weight+(Math.random()-0.5)*0.4)).toFixed(2);
        }
      }

      // Apply diagnosis
      if(diagnosis){
        if(diagnosis.addFilters){for(var df=0;df<diagnosis.addFilters.length;df++){
          var ft=diagnosis.addFilters[df],existing=mutant.filterRules.find(function(r){return r.type===ft});
          if(existing){existing.enabled=true;existing.weight=0.7}else{mutant.filterRules.push({id:'f'+(++ruleIdCounter),type:ft,params:{},weight:0.6,enabled:true})}
        }}
        if(diagnosis.addEntry){for(var de=0;de<diagnosis.addEntry.length;de++){
          var et=diagnosis.addEntry[de],ex=mutant.entryRules.find(function(r){return r.type===et});
          if(ex){ex.enabled=true;ex.weight=0.6}else{mutant.entryRules.push({id:'e'+(++ruleIdCounter),type:et,params:{},weight:0.5,enabled:true})}
        }}
        if(diagnosis._bootstrap){mutant.params.positionSize=Math.min(0.05,mutant.params.positionSize*0.7)}
      }
      return mutant;
    },

    _crossover:function(other){
      var child=this._clone();
      child.generation=Math.max(this.generation,other.generation)+1;
      child.parentInfo=this.name+' x '+other.name;
      for(var k in child.params){if(child.params.hasOwnProperty(k)&&other.params.hasOwnProperty(k))child.params[k]=Math.random()<0.5?this.params[k]:other.params[k]}
      return child;
    },

    iterate:function(candles,config){
      if(!candles||candles.length<20)return{generations:0,populationSize:0,generationLog:[],bestStrategy:null,bestResult:null,topStrategies:[]};
      config=config||{};
      var popSize=typeof config==='number'?20:(config.populationSize||20);
      var generations=typeof config==='number'?config:(config.generations||5);
      var liveFeedback=config.liveFeedback||[],self=this;
      var population=[this._clone()];
      for(var i=1;i<popSize;i++)population.push(this._mutate(null));
      var bestEver=null,bestEverResult=null,generationLog=[];
      for(var gen=0;gen<generations;gen++){
        var scored=[];
        for(var pi=0;pi<population.length;pi++){var bt=population[pi].backtest(candles);scored.push({strategy:population[pi],result:bt})}
        scored.sort(function(a,b){var sA=a.result.totalReturn*(a.result.winRate/100),sB=b.result.totalReturn*(b.result.winRate/100);return sB-sA});
        if(!bestEver||scored[0].result.totalReturn>bestEverResult.totalReturn){bestEver=scored[0].strategy._clone();bestEverResult=scored[0].result}
        generationLog.push({generation:gen+1,bestReturn:scored[0].result.totalReturn,bestWinRate:scored[0].result.winRate,bestTrades:scored[0].result.closedTrades});
        var diagnosis=scored[0].result.trades.length<=3000?scored[0].strategy._diagnose(candles,scored[0].result,liveFeedback):null;
        var survivors=scored.slice(0,5).map(function(s){return s.strategy});
        var nextGen=survivors.slice();
        while(nextGen.length<popSize){
          if(Math.random()<0.6&&survivors.length>=2){var p1=survivors[Math.floor(Math.random()*survivors.length)],p2=survivors[Math.floor(Math.random()*survivors.length)];nextGen.push(p1!==p2?p1._crossover(p2)._mutate(diagnosis):survivors[Math.floor(Math.random()*survivors.length)]._mutate(diagnosis))}
          else{nextGen.push(survivors[Math.floor(Math.random()*survivors.length)]._mutate(diagnosis))}
        }
        population=nextGen.slice(0,popSize);
        if(Math.random()<0.5)population[population.length-1]=bestEver._clone();
      }
      if(bestEver){bestEver.name='EvoStrategy';bestEver.version=(parseFloat(this.version)+1.0).toFixed(1);bestEver.description='Evolved from '+this.name}
      return{generations:generations,populationSize:popSize,generationLog:generationLog,bestStrategy:bestEver,bestResult:bestEverResult,topStrategies:population.slice(0,5).map(function(s){var bt;try{bt=s.backtest(candles)}catch(e){bt={totalReturn:0,winRate:0,closedTrades:0}};return{name:s.name,params:s.params,totalReturn:bt.totalReturn,winRate:bt.winRate,closedTrades:bt.closedTrades}})}
    },

    serialize:function(){
      return JSON.stringify({name:this.name,version:this.version,description:this.description,generation:this.generation,parentInfo:this.parentInfo,params:this.params,entryRules:this.entryRules,exitRules:this.exitRules,filterRules:this.filterRules,savedAt:new Date().toISOString().slice(0,19)},null,2);
    }
  };
}

// Default strategy instance
var ChaosStrategy=createStrategy('TradingChaos v1.0','1.0.0','Bill Williams Trading Chaos — Alligator + Fractals + AO + AC',undefined,undefined,undefined,undefined);
if(typeof window!=='undefined'){window.__loadedStrategy=ChaosStrategy;}
