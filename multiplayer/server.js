// ============================================================
// 局域网联机德州扑克服务器
// 既是静态文件服务器（托管 public/client.html），也是WebSocket游戏服务器。
// 不做多房间系统：一个进程 = 一桌牌局，给"几个朋友凑一桌"这个场景用。
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const engine = require('./engine.js');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;
const ACTION_TIMEOUT_MS = Number(process.env.ACTION_TIMEOUT_MS) || 75000; // 真人超时不操作，自动弃牌/过牌
const AI_NAME_POOL = ['Arcueid','Berserker','Ciel','Diluc','Esdeath','Felt','Gilgamesh','Hitagi','Irelia'];

// ---------- 桌子/大厅状态（全局单例，一个进程一桌） ----------
let phase = 'lobby'; // 'lobby' | 'playing' | 'betweenHands' | 'gameover'
let tableSize = 6;
let tableOptions = { stack: 1000, smallBlind: 5, bigBlind: 10 };
let seats = makeEmptySeats(tableSize);
let hostConnId = null;
let game = null;
let actingSeatId = -1;
let nextHandRequested = false;

const connections = new Map(); // connId -> { ws, seatId }
const reconnectTokens = new Map(); // token -> seatId
const pendingResolvers = new Map(); // seatId -> { resolve, timer, view, holeCards }

function makeEmptySeats(n) {
  return Array.from({ length: n }, () => ({ status: 'empty', name: null, connId: null, connected: false }));
}

function usedAINames() {
  return new Set(seats.filter(s => s.status === 'ai').map(s => s.name));
}
function nextAIName() {
  const used = usedAINames();
  const free = AI_NAME_POOL.find(n => !used.has(n));
  if (free) return free;
  let i = 2;
  while (used.has(`AI ${i}`)) i++;
  return `AI ${i}`;
}

function nameWeight(str) {
  let w = 0;
  for (const ch of str) w += /[\u0020-\u00ff]/.test(ch) ? 1 : 2;
  return w;
}
function sanitizeName(raw, fallback) {
  let v = String(raw || '').trim();
  while (nameWeight(v) > 10) v = v.slice(0, -1);
  return v || fallback;
}

// ---------- WebSocket 消息收发辅助 ----------
function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function sendToSeat(seatId, msg) {
  const seat = seats[seatId];
  if (!seat || !seat.connId) return;
  const conn = connections.get(seat.connId);
  if (conn) send(conn.ws, msg);
}
function broadcast(msg) {
  for (const conn of connections.values()) send(conn.ws, msg);
}
function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

// ---------- 大厅状态广播 ----------
function lobbySeatsSnapshot() {
  return seats.map((s, i) => ({
    seatId: i,
    status: s.status,
    name: s.name,
    connected: s.status === 'human' ? s.connected : s.status === 'ai',
    isHost: s.status === 'human' && s.connId === hostConnId,
  }));
}
function broadcastLobbyState() {
  broadcast({
    type: 'lobbyState',
    phase,
    tableSize,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    tableOptions,
    seats: lobbySeatsSnapshot(),
  });
}
function sendLobbyState(ws) {
  send(ws, {
    type: 'lobbyState',
    phase,
    tableSize,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    tableOptions,
    seats: lobbySeatsSnapshot(),
  });
}

// ---------- 对局状态广播（每个连接收到的手牌可见性不同） ----------
function buildBaseSnapshot() {
  return {
    type: 'gameState',
    stage: game.stage,
    handCount: game.handCount,
    community: game.community,
    currentBet: game.currentBet,
    pot: game.totalPot(),
    minRaise: game.minRaise,
    dealerIdx: playerIdToSeatId.get(game.dealerIdx),
    sbIdx: playerIdToSeatId.get(game.sbIdx),
    bbIdx: playerIdToSeatId.get(game.bbIdx),
    actingSeatId,
    smallBlind: game.smallBlind,
    bigBlind: game.bigBlind,
    // players 按座位号(seatId)排序输出，而不是引擎内部的压缩下标，方便客户端直接对照大厅座位
    players: game.players
      .map(p => ({
        seatId: playerIdToSeatId.get(p.id), name: p.name, stack: p.stack, bet: p.bet,
        folded: p.folded, allIn: p.allIn, isHuman: p.isHuman, lastAction: p.lastAction,
        _fullPlayer: p,
      }))
      .sort((a, b) => a.seatId - b.seatId),
  };
}
function broadcastGameState() {
  if (!game) return;
  const base = buildBaseSnapshot();
  for (const conn of connections.values()) {
    if (conn.seatId == null) { sendLobbyState(conn.ws); continue; }
    const seatId = conn.seatId;
    const playersWithCards = base.players.map(pl => {
      const full = pl._fullPlayer;
      const reveal = (game.stage === 'showdown' && !full.folded) || pl.seatId === seatId;
      return { id: pl.seatId, name: pl.name, stack: pl.stack, bet: pl.bet, folded: pl.folded, allIn: pl.allIn, isHuman: pl.isHuman, lastAction: pl.lastAction, holeCards: reveal ? full.holeCards : null };
    });
    send(conn.ws, { ...base, players: playersWithCards, yourSeatId: seatId });
  }
}

// ---------- 房主迁移 ----------
function migrateHostIfNeeded() {
  if (hostConnId && connections.has(hostConnId)) return; // 房主还在线
  const candidate = seats.find(s => s.status === 'human' && s.connected);
  hostConnId = candidate ? candidate.connId : null;
}

// ---------- 服务器端 decideFn：AI走原算法，真人等WebSocket消息 ----------
// game.players 用的是"已占用座位压缩后"的下标（player.id），跟大厅里持久的座位号
// （seatId，给连接/重连/座位UI用）不是一回事——大厅可能有空座位被跳过。
// playerIdToSeatId 是两者之间唯一的翻译层，所有面向网络协议的消息都用 seatId，
// 只有直接读写 engine.js 的 PokerGame 对象时才用 player.id。
let playerIdToSeatId = new Map();

function decideFn(p, view, gameRef) {
  const seatId = playerIdToSeatId.get(p.id);
  const seat = seats[seatId];
  if (seat.status === 'ai') return engine.aiDecide(p, view, gameRef);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingResolvers.delete(seatId);
      resolve({ type: view.toCall > 0 ? 'fold' : 'check' });
    }, ACTION_TIMEOUT_MS);
    pendingResolvers.set(seatId, { resolve, timer, view, holeCards: p.holeCards });
    sendYourTurn(seatId, p, view);
  });
}
function sendYourTurn(seatId, p, view) {
  sendToSeat(seatId, {
    type: 'yourTurn',
    stage: view.stage,
    pot: view.pot,
    currentBet: view.currentBet,
    minRaise: view.minRaise,
    toCall: view.toCall,
    stack: p.stack,
    bet: p.bet,
    holeCards: p.holeCards,
  });
}

function onGameUpdate(type, payload) {
  if (type === 'render') {
    broadcastGameState();
  } else if (type === 'acting') {
    actingSeatId = payload === -1 ? -1 : playerIdToSeatId.get(payload);
    broadcastGameState();
  } else if (type === 'deal') {
    broadcast({ type: 'dealt' });
  } else if (type === 'win') {
    const winnerSeatIds = (payload || []).map(id => playerIdToSeatId.get(id));
    broadcast({ type: 'win', winnerSeatIds });
  } else if (type === 'action') {
    const p = payload;
    broadcast({ type: 'actionTaken', seatId: playerIdToSeatId.get(p.id), lastAction: p.lastAction, equity: p.isHuman ? null : p.lastActionEquity, name: p.name, isHuman: p.isHuman });
  } else if (type === 'log') {
    broadcast({ type: 'logLine', text: payload });
  }
}

// ---------- 开局 / 下一手 ----------
function startActualGame() {
  const occupied = seats.map((s, i) => ({ ...s, seatId: i })).filter(s => s.status !== 'empty');
  const playerNames = occupied.map(s => s.name);
  const humanIdxs = occupied.map((s, k) => (s.status === 'human' ? k : -1)).filter(k => k !== -1);
  playerIdToSeatId = new Map();
  occupied.forEach((s, k) => playerIdToSeatId.set(k, s.seatId));
  game = new engine.PokerGame(
    playerNames, tableOptions.stack, tableOptions.smallBlind, tableOptions.bigBlind,
    humanIdxs, decideFn, onGameUpdate,
  );
  game.players.forEach(p => { if (!p.isHuman) p.aggression = 0.75 + Math.random() * 0.6; });
  phase = 'playing';
  broadcastLobbyState();
  runHand();
}

async function runHand() {
  nextHandRequested = false;
  const res = await game.playHand();
  broadcastGameState();
  if (res.gameOver) {
    phase = 'gameover';
    const winner = game.players.find(p => p.stack > 0);
    broadcast({ type: 'gameOver', winnerSeatId: winner ? playerIdToSeatId.get(winner.id) : null, winnerName: winner ? winner.name : null });
    return;
  }
  phase = 'betweenHands';
  broadcast({ type: 'handEnded' });
}

// ---------- 大厅操作 ----------
function handleAddAI(connId) {
  if (connId !== hostConnId) return;
  if (phase !== 'lobby') return;
  const emptyIdx = seats.findIndex(s => s.status === 'empty');
  if (emptyIdx === -1) return;
  seats[emptyIdx] = { status: 'ai', name: nextAIName(), connId: null, connected: true };
  broadcastLobbyState();
}
function handleRemoveAI(connId, seatId) {
  if (connId !== hostConnId) return;
  if (phase !== 'lobby') return;
  const seat = seats[seatId];
  if (!seat || seat.status !== 'ai') return;
  seats[seatId] = { status: 'empty', name: null, connId: null, connected: false };
  broadcastLobbyState();
}
function handleSetTableSize(connId, size) {
  if (connId !== hostConnId) return;
  if (phase !== 'lobby') return;
  const n = Math.round(Number(size));
  if (!Number.isFinite(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) return;
  const occupied = seats.filter(s => s.status !== 'empty').length;
  if (n < occupied) return; // 不能调到比已占座位还小
  if (n > seats.length) {
    seats = seats.concat(makeEmptySeats(n - seats.length));
  } else if (n < seats.length) {
    seats = seats.slice(0, n);
  }
  tableSize = n;
  broadcastLobbyState();
}
function handleSetTableOptions(connId, opts) {
  if (connId !== hostConnId) return;
  if (phase !== 'lobby') return;
  const stack = Number(opts.stack), sb = Number(opts.smallBlind), bb = Number(opts.bigBlind);
  if (![stack, sb, bb].every(Number.isFinite) || stack <= 0 || sb <= 0 || bb <= 0) return;
  tableOptions = { stack, smallBlind: sb, bigBlind: bb };
  broadcastLobbyState();
}
function handleStartGame(connId, ws, forceFillAI) {
  if (connId !== hostConnId) return sendError(ws, 'NOT_HOST', '只有房主可以开始游戏');
  if (phase !== 'lobby') return sendError(ws, 'ALREADY_STARTED', '游戏已经开始');
  const occupied = seats.filter(s => s.status !== 'empty').length;
  if (occupied < MIN_PLAYERS) {
    if (!forceFillAI) return send(ws, { type: 'needMoreAI', shortfall: MIN_PLAYERS - occupied });
    let toAdd = MIN_PLAYERS - occupied;
    while (toAdd > 0) {
      const emptyIdx = seats.findIndex(s => s.status === 'empty');
      if (emptyIdx === -1) break;
      seats[emptyIdx] = { status: 'ai', name: nextAIName(), connId: null, connected: true };
      toAdd--;
    }
  }
  startActualGame();
}
function handleRequestNextHand(connId) {
  const conn = connections.get(connId);
  if (!conn || conn.seatId == null) return;
  if (seats[conn.seatId].status !== 'human') return;
  if (phase !== 'betweenHands') return;
  if (nextHandRequested) return;
  nextHandRequested = true;
  runHand();
}
function handleJoinLobby(connId, ws, rawName) {
  if (phase !== 'lobby') return sendError(ws, 'ALREADY_STARTED', '游戏已经开始，暂时无法加入');
  const conn = connections.get(connId);
  if (conn.seatId != null) return; // 已经占座
  const emptyIdx = seats.findIndex(s => s.status === 'empty');
  if (emptyIdx === -1) return sendError(ws, 'TABLE_FULL', '座位已满');
  const name = sanitizeName(rawName, `玩家${emptyIdx + 1}`);
  const token = crypto.randomBytes(12).toString('hex');
  seats[emptyIdx] = { status: 'human', name, connId, connected: true };
  reconnectTokens.set(token, emptyIdx);
  conn.seatId = emptyIdx;
  if (!hostConnId) hostConnId = connId;
  send(ws, { type: 'joined', seatId: emptyIdx, reconnectToken: token, isHost: hostConnId === connId });
  broadcastLobbyState();
}
function handleLeaveSeat(connId) {
  const conn = connections.get(connId);
  if (!conn || conn.seatId == null) return;
  if (phase !== 'lobby') return;
  const seatId = conn.seatId;
  for (const [tok, sid] of reconnectTokens) if (sid === seatId) reconnectTokens.delete(tok);
  seats[seatId] = { status: 'empty', name: null, connId: null, connected: false };
  conn.seatId = null;
  migrateHostIfNeeded();
  broadcastLobbyState();
}
function handleAction(connId, msg) {
  const conn = connections.get(connId);
  if (!conn || conn.seatId == null) return;
  const seatId = conn.seatId;
  const pending = pendingResolvers.get(seatId);
  if (!pending) return; // 不是这个座位在被等待，忽略（防止串座位/重复提交）
  clearTimeout(pending.timer);
  pendingResolvers.delete(seatId);
  pending.resolve({ type: msg.actionType, amount: msg.amount });
}
function handleHello(connId, ws, token) {
  if (token && reconnectTokens.has(token)) {
    const seatId = reconnectTokens.get(token);
    const seat = seats[seatId];
    if (seat && seat.status === 'human') {
      const conn = connections.get(connId);
      seat.connId = connId;
      seat.connected = true;
      conn.seatId = seatId;
      if (!hostConnId || !connections.has(hostConnId)) hostConnId = connId;
      send(ws, { type: 'joined', seatId, reconnectToken: token, isHost: hostConnId === connId });
      if (phase === 'lobby') {
        sendLobbyState(ws);
      } else {
        broadcastGameState();
        const pending = pendingResolvers.get(seatId);
        if (pending) sendToSeat(seatId, { type: 'yourTurn', stage: pending.view.stage, pot: pending.view.pot, currentBet: pending.view.currentBet, minRaise: pending.view.minRaise, toCall: pending.view.toCall, stack: game.players[seatId].stack, bet: game.players[seatId].bet, holeCards: pending.holeCards });
      }
      return;
    }
  }
  sendLobbyState(ws);
}

// ---------- 断线处理 ----------
function handleClose(connId) {
  const conn = connections.get(connId);
  connections.delete(connId);
  if (!conn || conn.seatId == null) return;
  const seatId = conn.seatId;
  const seat = seats[seatId];
  if (!seat || seat.connId !== connId) return; // 已经被新连接顶替（重连过了）

  if (phase === 'lobby') {
    for (const [tok, sid] of reconnectTokens) if (sid === seatId) reconnectTokens.delete(tok);
    seats[seatId] = { status: 'empty', name: null, connId: null, connected: false };
  } else {
    seat.connected = false;
    const pending = pendingResolvers.get(seatId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingResolvers.delete(seatId);
      pending.resolve({ type: pending.view.toCall > 0 ? 'fold' : 'check' });
    }
  }
  migrateHostIfNeeded();
  if (phase === 'lobby') broadcastLobbyState();
  else broadcastGameState();
}

// ---------- 消息分发 ----------
function handleMessage(connId, ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  switch (msg.type) {
    case 'hello': return handleHello(connId, ws, msg.reconnectToken);
    case 'joinLobby': return handleJoinLobby(connId, ws, msg.name);
    case 'leaveSeat': return handleLeaveSeat(connId);
    case 'addAI': return handleAddAI(connId);
    case 'removeAI': return handleRemoveAI(connId, msg.seatId);
    case 'setTableSize': return handleSetTableSize(connId, msg.size);
    case 'setTableOptions': return handleSetTableOptions(connId, msg);
    case 'startGame': return handleStartGame(connId, ws, !!msg.forceFillAI);
    case 'requestNextHand': return handleRequestNextHand(connId);
    case 'action': return handleAction(connId, msg);
    default: return;
  }
}

// ---------- HTTP 静态文件服务 + WebSocket ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const httpServer = http.createServer((req, ws_unused_res) => {
  const res = ws_unused_res;
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/' || reqPath === '') reqPath = '/client.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
wss.on('connection', ws => {
  const connId = crypto.randomBytes(8).toString('hex');
  connections.set(connId, { ws, seatId: null });
  sendLobbyState(ws);
  ws.on('message', raw => handleMessage(connId, ws, raw));
  ws.on('close', () => handleClose(connId));
});

httpServer.listen(PORT, () => {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  console.log('德州扑克联机服务器已启动！');
  console.log('让大家在同一个WiFi下，用手机浏览器打开下面的地址：');
  if (ips.length === 0) console.log(`  http://localhost:${PORT}/  （没检测到局域网IP，请检查网络连接）`);
  for (const ip of ips) console.log(`  http://${ip}:${PORT}/`);
  console.log('按 Ctrl+C 关闭服务器。');
});
