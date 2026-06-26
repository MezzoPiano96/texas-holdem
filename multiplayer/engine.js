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
      bet:0, totalBet:0, isHuman:humanIdxs.includes(i), acted:false, lastActionType:null, lastActionAmount:null
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
  // log 跟单机版一样用 "cls::text" 的格式存样式标记，客户端按 :: 拆开渲染成带 class 的条目
  pushLog(msg, cls){ const entry = cls ? cls+'::'+msg : msg; this.log.push(entry); this.onUpdate('log', entry); }
  roleBadgeFor(idx){
    if(idx===this.sbIdx) return '<span class="log-role sb">S</span>';
    if(idx===this.bbIdx) return '<span class="log-role bb">B</span>';
    return '';
  }
  cardText(c){
    const rl=RANK_LABEL[c.r]||c.r, sym=SUIT_SYMBOL[c.s], red=(c.s==='h'||c.s==='d');
    return `<span class="log-card-sym${red?' red':''}">${rl}${sym}</span>`;
  }

  async playHand(){
    const inHand=this.activePlayers();
    if(inHand.length<2) return {gameOver:true};
    this.handCount++;
    this.community=[];
    this.deck=shuffle(makeDeck());
    for(const p of this.players){
      p.folded = p.stack<=0;
      p.allIn=false; p.bet=0; p.totalBet=0; p.holeCards=[]; p.acted=false; p.lastActionType=null; p.lastActionAmount=null;
    }
    this.dealerIdx = this.nextActiveSeat(this.dealerIdx, p=>p.stack>0 || p===this.players[this.dealerIdx]);
    if(this.dealerIdx===-1) this.dealerIdx = this.players.findIndex(p=>p.stack>0);

    for(let r=0;r<2;r++) for(const p of this.players){ if(!p.folded) p.holeCards.push(this.deck.pop()); }

    const sbIdx=this.nextActiveSeat(this.dealerIdx, p=>!p.folded);
    const bbIdx=this.nextActiveSeat(sbIdx, p=>!p.folded);
    this.sbIdx=sbIdx; this.bbIdx=bbIdx;
    this.pushLog(`第 ${this.handCount} 手 · 庄家 ${this.players[this.dealerIdx].name}`, 'entry-hand');
    this.postBet(sbIdx,this.smallBlind);
    this.pushLog(`${this.roleBadgeFor(sbIdx)}<span class="log-name">${this.players[sbIdx].name}</span> 下小盲 ${this.smallBlind}（底池 ${this.totalPot()}）`, 'entry-blind');
    this.postBet(bbIdx,this.bigBlind);
    this.pushLog(`${this.roleBadgeFor(bbIdx)}<span class="log-name">${this.players[bbIdx].name}</span> 下大盲 ${this.bigBlind}（底池 ${this.totalPot()}）`, 'entry-blind');
    this.currentBet=this.bigBlind;
    this.minRaise=this.bigBlind;
    this.stage='preflop';
    this.onUpdate('deal');
    this.onUpdate('render');

    let firstToAct=this.nextActiveSeat(bbIdx, p=>!p.folded);
    await this.bettingRound(firstToAct);
    if(this.onlyOneLeft()){ this.awardPotsNoShowdown(); this.onUpdate('render'); return {gameOver:false}; }

    this.stage='flop';
    this.deck.pop();
    const flopCards=[this.deck.pop(),this.deck.pop(),this.deck.pop()];
    this.community.push(...flopCards);
    this.pushLog(`翻牌 ${flopCards.map(c=>this.cardText(c)).join(' ')}`, 'entry-street');
    this.resetStreet();
    this.onUpdate('deal');
    this.onUpdate('render');
    await this.bettingRound(this.nextActiveSeat(this.dealerIdx, p=>!p.folded && !p.allIn));
    if(this.onlyOneLeft()){ this.awardPotsNoShowdown(); this.onUpdate('render'); return {gameOver:false}; }

    this.stage='turn';
    this.deck.pop(); const turnCard=this.deck.pop(); this.community.push(turnCard);
    this.pushLog(`转牌 ${this.community.slice(0,3).map(c=>this.cardText(c)).join(' ')} <b>${this.cardText(turnCard)}</b>`, 'entry-street');
    this.resetStreet();
    this.onUpdate('deal');
    this.onUpdate('render');
    await this.bettingRound(this.nextActiveSeat(this.dealerIdx, p=>!p.folded && !p.allIn));
    if(this.onlyOneLeft()){ this.awardPotsNoShowdown(); this.onUpdate('render'); return {gameOver:false}; }

    this.stage='river';
    this.deck.pop(); const riverCard=this.deck.pop(); this.community.push(riverCard);
    this.pushLog(`河牌 ${this.community.slice(0,4).map(c=>this.cardText(c)).join(' ')} <b>${this.cardText(riverCard)}</b>`, 'entry-street');
    this.resetStreet();
    this.onUpdate('deal');
    this.onUpdate('render');
    await this.bettingRound(this.nextActiveSeat(this.dealerIdx, p=>!p.folded && !p.allIn));
    if(this.onlyOneLeft()){ this.awardPotsNoShowdown(); this.onUpdate('render'); return {gameOver:false}; }

    this.stage='showdown';
    this.pushLog(`摊牌 ${this.community.map(c=>this.cardText(c)).join(' ')}`, 'entry-street');
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
    for(const p of this.players){ p.bet=0; p.acted=p.folded||p.allIn; if(!p.allIn){ p.lastActionType=null; p.lastActionAmount=null; } }
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
    const toCall=this.currentBet - p.bet;
    if(action.type==='fold'){
      if(toCall===0){ p.acted=true; p.lastActionType='check'; p.lastActionAmount=null; return; } // 没必要弃牌时自动转过牌
      p.folded=true; p.acted=true; p.lastActionType='fold'; p.lastActionAmount=null;
    } else if(action.type==='check'){
      if(toCall>0){ this.applyAction(p,{type:'call'}); return; }
      p.acted=true; p.lastActionType='check'; p.lastActionAmount=null;
    } else if(action.type==='call'){
      const amt=Math.min(toCall,p.stack);
      p.stack-=amt; p.bet+=amt; p.totalBet+=amt;
      if(p.stack===0) p.allIn=true;
      p.acted=true;
      if(amt>0){ p.lastActionType='call'; p.lastActionAmount=amt; } else { p.lastActionType='check'; p.lastActionAmount=null; }
    } else if(action.type==='raise' || action.type==='bet'){
      let raiseTo=Math.max(action.amount||0, this.currentBet + this.minRaise);
      raiseTo=Math.min(raiseTo, p.bet + p.stack);
      const amt=raiseTo - p.bet;
      const raiseSize = raiseTo - this.currentBet;
      p.stack-=amt; p.bet+=amt; p.totalBet+=amt;
      if(p.stack===0) p.allIn=true;
      this.currentBet=raiseTo;
      if(raiseSize>=this.minRaise) this.minRaise=raiseSize;
      p.acted=true; p.lastActionType = p.allIn?'allin':'raise'; p.lastActionAmount=raiseTo;
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
      p.acted=true; p.lastActionType='allin'; p.lastActionAmount=p.bet;
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
    this.pushLog(`🏆 <span class="log-name">${winner.name}</span> 获得彩池 ${amount}（其余玩家已弃牌）`, 'entry-win');
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
      const winnerNames=winners.map(id=>`<span class="log-name">${this.players[id].name}</span>`).join('、');
      this.pushLog(`🏆 彩池 ${pot.amount} 由 ${winnerNames} 赢得（${HAND_NAMES[results[winners[0]][0]]}）`, 'entry-win');
    }
    for(const p of this.players) p.totalBet=0;
    this.onUpdate('win', [...allWinnerIds]);
  }
}

// ---------- 3. AI 决策：蒙特卡洛模拟胜率（equity）+ 底池赔率 + 防剥削混合策略 ----------
// 站在该玩家视角，重建"未知牌"集合：全牌组中减去自己手牌和已翻出的公共牌
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
// 只给地狱AI用：简化版抽牌检测，不需要展示文字，只要知道"有没有有效抽牌"
function detectDraws(hole, board){
  const all=[...hole, ...board];
  if(all.length<5) return {hasDraw:false, flushDraw:false};
  const made=evaluate7(all)[0];
  const unseenCards=makeDeck().filter(c=>!all.some(oc=>oc.r===c.r&&oc.s===c.s));
  let hasDraw=false, flushDraw=false;
  for(const idx of [4,5,6,7,8]){
    if(made>=idx) continue;
    let count=0;
    for(const c of unseenCards){
      if(evaluate7([...all,c])[0]>=idx){ count++; if(count>0) break; }
    }
    if(count>0){ hasDraw=true; if(idx===5) flushDraw=true; }
  }
  return {hasDraw, flushDraw};
}

function decideActionBeginner(p, view, game){
  const numOpponents=game.players.filter(o=>o!==p && !o.folded).length;
  if(numOpponents<=0) return {type: view.toCall>0?'call':'check'};
  const equity=estimateEquity(p.holeCards, view.community, numOpponents, 50); // 迭代少，胜率估算比较粗糙
  const potOdds = view.toCall>0 ? view.toCall/(view.pot+view.toCall) : 0;

  let action;
  if(view.toCall===0){
    if(equity>0.72 && Math.random()<0.5){
      const size=Math.round(Math.max(view.minRaise, view.pot*0.5));
      action={type:'bet', amount:view.currentBet+size};
    } else {
      action={type:'check'};
    }
  } else if(equity > potOdds-0.15 || Math.random()<0.2){
    // calling station：跟注门槛很松，几乎不弃牌
    action = (equity>0.8 && Math.random()<0.3)
      ? {type:'raise', amount:view.currentBet+Math.round(Math.max(view.minRaise, view.pot*0.5))}
      : {type:'call'};
  } else {
    action={type:'fold'};
  }

  if((action.type==='bet'||action.type==='raise') && p.stack<=view.toCall+1){
    action={type: view.toCall>0 ? 'call':'check'};
  }
  if(p.stack===0) action={type: view.toCall>0?'call':'check'};
  return action;
}

function decideActionNormal(p, view, game){
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
  return action;
}

function decideActionHell(p, view, game){
  const numOpponents=game.players.filter(o=>o!==p && !o.folded).length;
  if(numOpponents<=0) return {type: view.toCall>0?'call':'check'};
  const iterations = view.stage==='preflop' ? 900 : 700; // 迭代次数远高于正常档，胜率估算更准
  const equity=estimateEquity(p.holeCards, view.community, numOpponents, iterations);

  const aggression=p.aggression || 1;
  const potOdds = view.toCall>0 ? view.toCall/(view.pot+view.toCall) : 0;
  const evMargin = equity - potOdds;
  const {hasDraw} = view.community.length>0 ? detectDraws(p.holeCards, view.community) : {hasDraw:false};

  let action;
  if(view.toCall===0){
    if(equity>0.58 || (hasDraw && Math.random()<0.55)){
      const sizeFrac = 0.45 + Math.min(0.45, Math.max(0, equity-0.45))*0.85 + Math.random()*0.08;
      const size=Math.round(Math.max(view.minRaise, view.pot*sizeFrac));
      action={type:'bet', amount:view.currentBet+size};
    } else if(equity<0.3 && Math.random()<0.2){
      const size=Math.round(Math.max(view.minRaise, view.pot*(0.5+Math.random()*0.25)));
      action={type:'bet', amount:view.currentBet+size};
    } else {
      action={type:'check'};
    }
  } else {
    const raiseSizeFrac=0.55+Math.random()*0.35;
    const balancedBluffFreq=raiseSizeFrac/(1+raiseSizeFrac);
    const isBluffRaise=(hasDraw || equity<0.25) && Math.random()<balancedBluffFreq*0.5*aggression;
    if(isBluffRaise && p.stack>view.toCall*2.5){
      const size=Math.round(Math.max(view.minRaise, view.pot*raiseSizeFrac));
      action={type:'raise', amount:view.currentBet+size};
    } else if(evMargin>0.1 && equity>0.58){
      const sizeFrac=0.55+Math.min(0.3, Math.max(0,equity-0.58))*1.2+Math.random()*0.1;
      const size=Math.round(Math.max(view.minRaise, view.pot*sizeFrac));
      action={type:'raise', amount:view.currentBet+size};
    } else if(evMargin > -0.03){
      action={type:'call'};
    } else if(hasDraw && view.toCall <= p.stack*0.08){
      action={type:'call'};
    } else {
      action={type:'fold'};
    }
  }

  if((action.type==='bet'||action.type==='raise') && p.stack<=view.toCall+1){
    action={type: view.toCall>0 ? 'call':'check'};
  }
  if(p.stack===0) action={type: view.toCall>0?'call':'check'};
  return action;
}

function decideAction(p, view, game, difficulty){
  if(difficulty==='beginner') return decideActionBeginner(p, view, game);
  if(difficulty==='hell') return decideActionHell(p, view, game);
  return decideActionNormal(p, view, game);
}

// 暂停时不让AI偷偷继续思考/行动：跟单机版一样，暂停期间不扣减剩余思考时间，恢复后接着倒计时
let enginePaused=false;
function setPaused(v){ enginePaused=!!v; }
function isPaused(){ return enginePaused; }
function pauseAwareDelay(ms){
  return new Promise(resolve=>{
    let remaining=ms, last=Date.now();
    (function tick(){
      const now=Date.now();
      if(!enginePaused) remaining -= (now-last);
      last=now;
      if(remaining<=0){ resolve(); return; }
      setTimeout(tick, Math.min(remaining, 100));
    })();
  });
}

function aiDecide(p, view, game, difficulty){
  return new Promise(async resolve=>{
    const thinkTime = 550 + Math.random()*700;
    await pauseAwareDelay(thinkTime);
    resolve(decideAction(p, view, game, difficulty));
  });
}

// 跟单机版一致：把 lastActionType/lastActionAmount 格式化成给人看的文字，
// 这样网络上只传结构化数据，真正的文案由客户端自己拼，方便以后要做多语言也不用改协议
function formatAction(type, amount){
  if(!type) return '';
  if(type==='fold') return '弃牌';
  if(type==='check') return '过牌';
  if(type==='call') return `跟注 ${amount}`;
  if(type==='raise') return `加注到 ${amount}`;
  if(type==='allin') return `全下 ${amount}`;
  return '';
}

module.exports = {
  SUITS, RANKS, RANK_LABEL, SUIT_SYMBOL, HAND_NAMES,
  makeDeck, shuffle, evaluate5, evaluate7, cmpScore, combinations,
  PokerGame,
  unseenCardsFor, estimateEquity, decideAction, aiDecide, formatAction,
  setPaused, isPaused,
};
