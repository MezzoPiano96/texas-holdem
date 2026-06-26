const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const engine = require('../engine.js');
const server = require('../server.js');

function card(r, s) {
  return { r, s };
}

test('evaluate7 recognizes royal flush over extra cards', () => {
  const score = engine.evaluate7([
    card(14, 's'), card(13, 's'), card(12, 's'), card(11, 's'), card(10, 's'),
    card(2, 'h'), card(3, 'd'),
  ]);
  assert.deepEqual(score, [8, 14]);
});

test('evaluate7 handles wheel straight', () => {
  const score = engine.evaluate7([
    card(14, 's'), card(5, 'h'), card(4, 'd'), card(3, 'c'), card(2, 's'),
    card(9, 'h'), card(12, 'd'),
  ]);
  assert.equal(score[0], 4);
  assert.equal(score[1], 5);
});

test('computeSidePots splits all-in contribution levels', () => {
  const game = new engine.PokerGame(['A', 'B', 'C'], 1000, 5, 10, [], () => ({ type: 'check' }));
  game.players[0].totalBet = 50;
  game.players[1].totalBet = 100;
  game.players[2].totalBet = 200;

  assert.deepEqual(game.computeSidePots(), [
    { amount: 150, eligible: [0, 1, 2] },
    { amount: 100, eligible: [1, 2] },
    { amount: 100, eligible: [2] },
  ]);
});

test('PokerGame logs escape player names while keeping card markup', async () => {
  const logs = [];
  const game = new engine.PokerGame(['<img src=x>', 'Bob'], 100, 5, 10, [0, 1], () => ({ type: 'fold' }), (type, payload) => {
    if (type === 'log') logs.push(payload);
  });

  await game.playHand();

  assert.equal(logs.some((line) => line.includes('<img src=x>')), false);
  assert.equal(logs.some((line) => line.includes('&lt;img src=x&gt;')), true);
});

test('seat maps preserve sparse lobby seats', () => {
  const occupied = [{ seatId: 0 }, { seatId: 3 }, { seatId: 7 }];
  const { playerToSeat, seatToPlayer } = server._internals.buildSeatMaps(occupied);

  assert.equal(playerToSeat.get(1), 3);
  assert.equal(seatToPlayer.get(7), 2);
  assert.equal(seatToPlayer.has(1), false);
});

test('normalizePlayerAction clamps raises and rejects illegal checks', () => {
  const pending = {
    view: { toCall: 10, currentBet: 20, minRaise: 10 },
    stack: 100,
    bet: 10,
  };

  assert.deepEqual(server._internals.normalizePlayerAction({ actionType: 'raise', amount: 999 }, pending), { type: 'raise', amount: 110 });
  assert.deepEqual(server._internals.normalizePlayerAction({ actionType: 'raise', amount: 21 }, pending), { type: 'raise', amount: 30 });
  assert.equal(server._internals.normalizePlayerAction({ actionType: 'check' }, pending), null);
  assert.deepEqual(server._internals.normalizePlayerAction({ actionType: 'call' }, pending), { type: 'call' });
  assert.deepEqual(server._internals.normalizePlayerAction({ actionType: 'allin' }, pending), { type: 'allin' });
  assert.equal(server._internals.normalizePlayerAction({ actionType: 'raise', amount: Infinity }, pending), null);
});

test('publicPathForUrl rejects malformed and traversal paths', () => {
  const clientPath = server._internals.publicPathForUrl('/');
  assert.equal(path.basename(clientPath), 'client.html');
  assert.equal(server._internals.publicPathForUrl('/%E0%A4%A'), null);
  assert.equal(server._internals.publicPathForUrl('/../server.js'), null);
});
