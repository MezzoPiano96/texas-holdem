// ============================================================
// 纯逻辑引擎：从 texas-holdem.html 复制而来（牌型评估 + PokerGame + AI决策）
// 不依赖任何浏览器全局对象（document/window），可以原样在 Node 里跑。
// 故意保持跟原文件几乎一致而不是重构合并，确保不会动到已部署的单机版。
// 如果以后要修引擎/AI的bug，这两份要分别改。
// ============================================================

// ---------- 1. 牌型评估 ----------
const SUITS = ['s','h','d','c'];
const RANKS = [2,3,4,5,6,7,8,9,10,11,12,13,14];
const RANK_LABEL = {11:'J',12:'Q',13:'K',14:'A'};
const SUIT_SYMBOL = {s:'♠',h:'♥',d:'♦',c:'♣'};
const HAND_NAMES = ['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺'];

function makeDeck(){ const d=[]; for(const s of SUITS) for(const r of RANKS) d.push({r,s}); return d; }
function shuffle(deck){ const d=deck.slice(); for(let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; } return d; }

function evaluate5(cards){
  const ranks = cards.map(c=>c.r).sort((a,b)=>b-a);
  const suits = cards.map(c=>c.s);
  const isFlush = suits.every(s=>s===suits[0]);
  const uniq = [...new Set(ranks)];
  let isStraight=false, straightHigh=0;
  if(uniq.length===5){
    if(uniq[0]-uniq[4]===4){ isStraight=true; straightHigh=uniq[0]; }
    else if(JSON.stringify(uniq)===JSON.stringify([14,5,4,3,2])){ isStraight=true; straightHigh=5; }
  }
  const counts={};
  for(const r of ranks) counts[r]=(counts[r]||0)+1;
  const groups = Object.entries(counts).map(([r,c])=>[Number(r),c]).sort((a,b)=> b[1]-a[1] || b[0]-a[0]);
  if(isStraight && isFlush) return [8, straightHigh];
  if(groups[0][1]===4) return [7, groups[0][0], groups[1][0]];
  if(groups[0][1]===3 && groups[1][1]===2) return [6, groups[0][0], groups[1][0]];
  if(isFlush) return [5, ...ranks];
  if(isStraight) return [4, straightHigh];
  if(groups[0][1]===3) return [3, groups[0][0], ...groups.slice(1).map(g=>g[0])];
  if(groups[0][1]===2 && groups[1][1]===2){
    const pairs=[groups[0][0],groups[1][0]].sort((a,b)=>b-a);
    return [2, pairs[0], pairs[1], groups[2][0]];
  }
  if(groups[0][1]===2) return [1, groups[0][0], ...groups.slice(1).map(g=>g[0])];
  return [0, ...ranks];
}
function cmpScore(a,b){
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const av=a[i]||0, bv=b[i]||0;
    if(av!==bv) return av-bv;
  }
  return 0;
}
function combinations(arr,k){
  const res=[];
  function helper(start,combo){
    if(combo.length===k){ res.push(combo.slice()); return; }
    for(let i=start;i<arr.length;i++){ combo.push(arr[i]); helper(i+1,combo); combo.pop(); }
  }
  helper(0,[]);
  return res;
}
function evaluate7(cards){
  let best=null;
  for(const c of combinations(cards,5)){
    const score = evaluate5(c);
    if(best===null || cmpScore(score,best)>0) best=score;
  }
  return best;
}

// ---------- 2. 游戏引擎（状态机 + 边池） ----------
class PokerGame{
  constructor(playerNames, startStack, smallBlind, bigBlind, humanIdxs, decideFn, onUpdate){
    this.players = playerNames.map((name,i)=>({
      id:i, name, stack:startStack, holeCards:[], folded:false, allIn:false,
      bet:0, totalBet:0, isHuman:humanIdxs.includes(i), acted:false, lastAction:null
    }));
    this.smallBlind=smallBlind; this.bigBlind=bigBlind;
    this.dealerIdx=-1;
    this.decideFn=decideFn;
    this.onUpdate=onUpdate || (()=>{});
    this.handCount=0;
    this.log=[];
    this.community=[];
    this.pot=0;
  }
  activePlayers(){ return this.players.filter(p=>p.stack>0); }
  nextActiveSeat(fromIdx, predicate){
    const n=this.players.length;
    for(let step=1; step<=n; step++){
      const idx=(fromIdx+step)%n;
      if(predicate(this.players[idx])) return idx;
    }
    return -1;
  }
  pushLog(msg){ this.log.push(msg); this.onUpdate('log', msg); }

  async playHand(){
    const inHand=this.activePlayers();
    if(inHand.length<2) return {gameOver:true};
    this.handCount++;
    this.community=[];
    this.deck=shuffle(makeDeck());
    for(const p of this.players){
      p.folded = p.stack<=0;
      p.allIn=false; p.bet=0; p.totalBet=0; p.holeCards=[]; p.acted=false; p.lastAction=null;
    }
    this.dealerIdx = this.nextActiveSeat(this.dealerIdx, p=>p.stack>0 || p===this.players[this.dealerIdx]);
    if(this.dealerIdx===-1) this.dealerIdx = this.players.findIndex(p=>p.stack>0);

    for(let r=0;r<2;r++) for(const p of this.players){ if(!p.folded) p.holeCards.push(this.deck.pop()); }

    const sbIdx=this.nextActiveSeat(this.dealerIdx, p=>!p.folded);
    const bbIdx=this.nextActiveSeat(sbIdx, p=>!p.folded);
    this.sbIdx=sbIdx; this.bbIdx=bbIdx;
    this.postBet(sbIdx,this.smallBlind);
    this.postBet(bbIdx,this.bigBlind);
    this.currentBet=this.bigBlind;
    this.minRaise=this.bigBlind;
    this.stage='preflop';
    this.pushLog(`第${this.handCount}手开始 · 庄家 ${this.players[this.dealerIdx].name} · 盲注 ${this.players[sbIdx].name}(SB) / ${this.players[bbIdx].name}(BB)`);
    this.onUpdate('deal');
    this.onUpdate('render');

    let firstToAct=this.nextActiveSeat(bbIdx, p=>!p.folded);
    await this.bettingRound(firstToAct);
    if(this.onlyOneLeft()){ this.awardPotsNoShowdown(); this.onUpdate('render'); return {gameOver:false}; }

    this.stage='flop';
    this.deck.pop();
    this.community.push(this.deck.pop(),this.deck.pop(),this.deck.pop());
    this.resetStreet();
    this.onUpdate('deal');
    this.onUpdate('render');
    await this.bettingRound(this.nextActiveSeat(this.dealerIdx, p=>!p.folded && !p.allIn));
    if(this.onlyOneLeft()){ this.awardPotsNoShowdown(); this.onUpdate('render'); return {gameOver:false}; }

    this.stage='turn';
    this.deck.pop(); this.community.push(this.deck.pop());
    this.resetStreet();
    this.onUpdate('deal');
    this.onUpdate('render');
    await this.bettingRound(this.nextActiveSeat(this.dealerIdx, p=>!p.folded && !p.allIn));
    if(this.onlyOneLeft()){ this.awardPotsNoShowdown(); this.onUpdate('render'); return {gameOver:false}; }

    this.stage='river';
    this.deck.pop(); this.community.push(this.deck.pop());
    this.resetStreet();
    this.onUpdate('deal');
    this.onUpdate('render');
    await this.bettingRound(this.nextActiveSeat(this.dealerIdx, p=>!p.folded && !p.allIn));
    if(this.onlyOneLeft()){ this.awardPotsNoShowdown(); this.onUpdate('render'); return {gameOver:false}; }

    this.stage='showdown';
    this.showdown();
    this.onUpdate('render');
    return {gameOver:false};
  }

  postBet(idx,amount){
    const p=this.players[idx];
    const actual=Math.min(amount,p.stack);
    p.stack-=actual; p.bet+=actual; p.totalBet+=actual;
    if(p.stack===0) p.allIn=true;
  }
  resetStreet(){
    for(const p of this.players){ p.bet=0; p.acted=p.folded||p.allIn; p.lastAction=p.allIn?p.lastAction:null; }
    this.currentBet=0; this.minRaise=this.bigBlind;
  }
  onlyOneLeft(){ return this.players.filter(p=>!p.folded).length<=1; }
  eligibleToAct(p){ return !p.folded && !p.allIn; }
  needsAction(){ return this.players.some(p=>this.eligibleToAct(p) && (!p.acted || p.bet!==this.currentBet)); }

  async bettingRound(startIdx){
    if(startIdx===-1 || this.players.filter(p=>this.eligibleToAct(p)).length===0) return;
    let idx=startIdx, guard=0;
    while(this.needsAction() && guard<2000){
      guard++;
      const p=this.players[idx];
      if(this.eligibleToAct(p) && (!p.acted || p.bet!==this.currentBet)){
        this.onUpdate('acting', p.id);
        const action = await this.decideFn(p, this.viewFor(p), this);
        this.applyAction(p, action);
        this.onUpdate('acting', -1);
        this.onUpdate('action', p);
        this.onUpdate('render');
      }
      idx=(idx+1)%this.players.length;
    }
  }

  applyAction(p, action){
    // action.equity（如果有）是AI做这个决定时算出的自己胜率，纯粹给语音播报用来调
    // 语调/音量/语速（信心越足说话越响越快），不影响任何游戏规则判断
    p.lastActionEquity = action.equity!=null ? action.equity : null;
    const toCall=this.currentBet - p.bet;
    if(action.type==='fold'){
      if(toCall===0){ p.acted=true; p.lastAction='过牌'; return; } // 没必要弃牌时自动转过牌
      p.folded=true; p.acted=true; p.lastAction='弃牌';
    } else if(action.type==='check'){
      if(toCall>0){ this.applyAction(p,{type:'call'}); return; }
      p.acted=true; p.lastAction='过牌';
    } else if(action.type==='call'){
      const amt=Math.min(toCall,p.stack);
      p.stack-=amt; p.bet+=amt; p.totalBet+=amt;
      if(p.stack===0) p.allIn=true;
      p.acted=true; p.lastAction = amt>0 ? `跟注 ${amt}` : '过牌';
    } else if(action.type==='raise' || action.type==='bet'){
      let raiseTo=Math.max(action.amount||0, this.currentBet + this.minRaise);
      raiseTo=Math.min(raiseTo, p.bet + p.stack);
      const amt=raiseTo - p.bet;
      const raiseSize = raiseTo - this.currentBet;
      p.stack-=amt; p.bet+=amt; p.totalBet+=amt;
      if(p.stack===0) p.allIn=true;
      this.currentBet=raiseTo;
      if(raiseSize>=this.minRaise) this.minRaise=raiseSize;
      p.acted=true; p.lastAction = p.allIn?`全下 ${raiseTo}`:`加注到 ${raiseTo}`;
      for(const other of this.players){ if(other!==p && this.eligibleToAct(other)) other.acted=false; }
    } else if(action.type==='allin'){
      const amt=p.stack;
      if(amt<=0){ this.applyAction(p,{type: toCall>0?'fold':'check'}); return; }
      p.stack=0; p.bet+=amt; p.totalBet+=amt; p.allIn=true;
      if(p.bet>this.currentBet){
        const raiseSize=p.bet-this.currentBet;
        this.currentBet=p.bet;
        if(raiseSize>=this.minRaise) this.minRaise=raiseSize;
        for(const other of this.players){ if(other!==p && this.eligibleToAct(other)) other.acted=false; }
      }
      p.acted=true; p.lastAction=`全下 ${p.bet}`;
    }
  }

  viewFor(p){
    return {
      community:this.community.slice(),
      currentBet:this.currentBet,
      pot:this.totalPot(),
      toCall:this.currentBet - p.bet,
      minRaise:this.minRaise,
      stage:this.stage,
      players:this.players.map(o=>({id:o.id,name:o.name,stack:o.stack,bet:o.bet,folded:o.folded,allIn:o.allIn,isHuman:o.isHuman}))
    };
  }
  totalPot(){ return this.players.reduce((s,p)=>s+p.totalBet,0); }

  computeSidePots(){
    const contributors=this.players.filter(p=>p.totalBet>0);
    const levels=[...new Set(contributors.map(p=>p.totalBet))].sort((a,b)=>a-b);
    const pots=[]; let prevLevel=0;
    for(const level of levels){
      const eligiblePlayers=this.players.filter(p=>p.totalBet>=level && !p.folded);
      let layerTotal=0;
      for(const p of this.players) layerTotal += Math.max(0, Math.min(p.totalBet,level)-prevLevel);
      if(layerTotal>0) pots.push({amount:layerTotal, eligible:eligiblePlayers.map(p=>p.id)});
      prevLevel=level;
    }
    return pots;
  }
  awardPotsNoShowdown(){
    const winner=this.players.find(p=>!p.folded);
    const amount=this.totalPot();
    winner.stack+=amount;
    this.pushLog(`${winner.name} 获得彩池 ${amount}（其余玩家已弃牌）`);
    for(const p of this.players) p.totalBet=0;
    this.onUpdate('win', [winner.id]);
  }
  showdown(){
    const pots=this.computeSidePots();
    const results={};
    const allWinnerIds=new Set();
    for(const p of this.players) if(!p.folded) results[p.id]=evaluate7([...p.holeCards, ...this.community]);
    for(const pot of pots){
      const eligible=pot.eligible.filter(id=>results[id]);
      if(eligible.length===0) continue;
      let best=eligible[0];
      for(const id of eligible) if(cmpScore(results[id],results[best])>0) best=id;
      const winners=eligible.filter(id=>cmpScore(results[id],results[best])===0);
      const share=Math.floor(pot.amount/winners.length);
      let remainder=pot.amount-share*winners.length;
      for(const id of winners){
        this.players[id].stack += share + (remainder>0?1:0);
        if(remainder>0) remainder--;
        allWinnerIds.add(id);
      }
      this.pushLog(`彩池 ${pot.amount} 由 ${winners.map(id=>this.players[id].name).join('、')} 赢得（${HAND_NAMES[results[winners[0]][0]]}）`);
    }
    for(const p of this.players) p.totalBet=0;
    this.onUpdate('win', [...allWinnerIds]);
  }
}

// ---------- 3. AI 决策：蒙特卡洛模拟胜率（equity）+ 底池赔率 + 防剥削混合策略 ----------
function unseenCardsFor(hole, board){
  const seen=new Set([...hole, ...board].map(c=>c.r+'-'+c.s));
  return makeDeck().filter(c=>!seen.has(c.r+'-'+c.s));
}
function estimateEquity(hole, board, numOpponents, iterations){
  if(numOpponents<=0) return 1;
  const unseen=unseenCardsFor(hole, board);
  let winShare=0;
  for(let i=0;i<iterations;i++){
    const shuffled=shuffle(unseen);
    let idx=0;
    const oppHoles=[];
    for(let o=0;o<numOpponents;o++) oppHoles.push([shuffled[idx++], shuffled[idx++]]);
    const fullBoard=board.slice();
    while(fullBoard.length<5) fullBoard.push(shuffled[idx++]);
    const myScore=evaluate7([...hole, ...fullBoard]);
    let beaten=false, tieCount=0;
    for(const oh of oppHoles){
      const cmp=cmpScore(myScore, evaluate7([...oh, ...fullBoard]));
      if(cmp<0){ beaten=true; break; }
      if(cmp===0) tieCount++;
    }
    if(!beaten) winShare += tieCount>0 ? 1/(tieCount+1) : 1;
  }
  return winShare/iterations;
}

function decideAction(p, view, game){
  const numOpponents=game.players.filter(o=>o!==p && !o.folded).length;
  if(numOpponents<=0) return {type: view.toCall>0?'call':'check'};
  const iterations = view.stage==='preflop' ? 260 : 170;
  const equity=estimateEquity(p.holeCards, view.community, numOpponents, iterations);

  const aggression=p.aggression || 1;
  const potOdds = view.toCall>0 ? view.toCall/(view.pot+view.toCall) : 0;
  const evMargin = equity - potOdds; // 正值=跟注在数学上有利可图（暂不计入隐含赔率）
  const defendNoise=(Math.random()-0.5)*0.12; // 增加随机性，避免决策被轻易预测/剥削
  const isBluff=Math.random() < (0.05 + 0.05*aggression);

  let action;
  if(view.toCall===0){
    const valueBetChance = equity>0.62 ? 0.75 : (equity>0.45 ? 0.32 : 0.08);
    if(isBluff || Math.random() < valueBetChance*aggression){
      const sizeFrac = equity>0.75 ? (0.65+Math.random()*0.35) : (0.45+Math.random()*0.35);
      const size=Math.round(Math.max(view.minRaise, view.pot*sizeFrac));
      action={type:'bet', amount:view.currentBet+size};
    } else {
      action={type:'check'};
    }
  } else if(isBluff && p.stack>view.toCall*3){
    // 偶尔纯诈唬加注，保持不可预测性，不会"只要被加注就一定弃牌"
    const size=Math.round(Math.max(view.minRaise, view.pot*(0.6+Math.random()*0.5)));
    action={type:'raise', amount:view.currentBet+size};
  } else if(evMargin+defendNoise>0.12 && equity>0.55 && Math.random()<(0.35+0.4*aggression)){
    // 胜率明显超过赔率要求：主动加注扩大领先优势（价值加注）
    const size=Math.round(Math.max(view.minRaise, view.pot*(0.55+Math.random()*0.45)));
    action={type:'raise', amount:view.currentBet+size};
  } else if(evMargin+defendNoise > -0.05){
    // 胜率接近或超过赔率要求：跟注（不会因为对方加大注码就机械弃牌）
    action={type:'call'};
  } else if(view.toCall <= p.stack*0.04 && Math.random()<0.5){
    // 跟注成本相对筹码极小，隐含赔率上仍值得偶尔跟看
    action={type:'call'};
  } else {
    action={type:'fold'};
  }

  if((action.type==='bet'||action.type==='raise') && p.stack<=view.toCall+1){
    action={type: view.toCall>0 ? 'call':'check'};
  }
  if(p.stack===0) action={type: view.toCall>0?'call':'check'};
  action.equity=equity; // 暴露给语音播报用，跟规则判断无关
  return action;
}

function aiDecide(p, view, game){
  return new Promise(resolve=>{
    const thinkTime = 550 + Math.random()*700;
    setTimeout(()=>resolve(decideAction(p, view, game)), thinkTime);
  });
}

module.exports = {
  SUITS, RANKS, RANK_LABEL, SUIT_SYMBOL, HAND_NAMES,
  makeDeck, shuffle, evaluate5, evaluate7, cmpScore, combinations,
  PokerGame,
  unseenCardsFor, estimateEquity, decideAction, aiDecide,
};
