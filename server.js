const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_HP = 100;
const HAND_SIZE = 7;
const ENHANCE_HAND_SIZE = 2;
const ENHANCE_RANGES = [[1, 3], [2, 4], [3, 5], [3, 7], [4, 8], [5, 9], [6, 11]];

const rooms = {}; // code -> room state
let idSeq = 1;
function uid() { return idSeq++; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function makeCard() {
  const r = Math.random();
  if (r < 0.42) return { id: uid(), type: 'attack', value: randInt(1, 14) };
  if (r < 0.80) return { id: uid(), type: 'defense', value: randInt(1, 14) };
  return { id: uid(), type: 'heal', value: randInt(1, 20) };
}
function makeEnhanceCard() {
  const r = ENHANCE_RANGES[randInt(0, ENHANCE_RANGES.length - 1)];
  return { id: uid(), type: 'enhance', min: r[0], max: r[1] };
}
function makeHand(size) {
  const hand = [];
  for (let i = 0; i < size; i++) hand.push(makeCard());
  if (!hand.some(c => c.type === 'attack')) hand[0] = { id: uid(), type: 'attack', value: randInt(1, 14) };
  return hand;
}
function makeEnhanceHand(size) {
  const hand = [];
  for (let i = 0; i < size; i++) hand.push(makeEnhanceCard());
  return hand;
}
function refill(hand) { while (hand.length < HAND_SIZE) hand.push(makeCard()); }
function refillEnhance(hand) { while (hand.length < ENHANCE_HAND_SIZE) hand.push(makeEnhanceCard()); }

function newRoom(code) {
  return {
    code,
    sockets: [null, null],
    names: ['플레이어 1', '플레이어 2'],
    hp: [MAX_HP, MAX_HP],
    hands: [makeHand(HAND_SIZE), makeHand(HAND_SIZE)],
    enhance: [makeEnhanceHand(ENHANCE_HAND_SIZE), makeEnhanceHand(ENHANCE_HAND_SIZE)],
    turnPlayer: 0,
    turnCount: 1,
    phase: 'ATTACK', // ATTACK | DEFEND
    pendingAttack: null,
    log: [],
    gameOver: false,
    winner: null
  };
}

function pushLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 60) room.log.shift();
}

function publicState(room) {
  return {
    code: room.code,
    names: room.names,
    connected: room.sockets.map(s => !!s),
    hp: room.hp,
    hands: room.hands,
    enhance: room.enhance,
    turnPlayer: room.turnPlayer,
    turnCount: room.turnCount,
    phase: room.phase,
    pendingAttack: room.pendingAttack,
    log: room.log,
    gameOver: room.gameOver,
    winner: room.winner
  };
}

function broadcast(room) {
  const state = publicState(room);
  room.sockets.forEach((sid, idx) => {
    if (sid) io.to(sid).emit('state', { you: idx, state });
  });
}

io.on('connection', (socket) => {
  socket.on('join', (rawCode) => {
    const code = String(rawCode || 'ROOM').toUpperCase().trim().slice(0, 8) || 'ROOM';
    if (!rooms[code]) rooms[code] = newRoom(code);
    const room = rooms[code];

    const idx = room.sockets.findIndex(s => s === null);
    if (idx === -1) {
      socket.emit('joinError', '이 방은 이미 두 명이 들어와 있습니다.');
      return;
    }

    room.sockets[idx] = socket.id;
    socket.data.room = code;
    socket.data.idx = idx;
    pushLog(room, `${room.names[idx]}이(가) 입장했습니다.`);

    if (room.sockets.every(s => s !== null)) {
      pushLog(room, '두 플레이어가 모두 모였다. 전투 시작!');
    }
    socket.emit('joined', { you: idx, code });
    broadcast(room);
  });

  socket.on('action', (payload) => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const idx = socket.data.idx;
    if (room.gameOver) return;
    if (room.sockets.filter(Boolean).length < 2) return;

    if (room.phase === 'ATTACK') {
      if (idx !== room.turnPlayer) return;
      handleAttackPhase(room, idx, payload || {});
    } else if (room.phase === 'DEFEND') {
      const defenderIdx = 1 - room.pendingAttack.attackerIdx;
      if (idx !== defenderIdx) return;
      handleDefendPhase(room, idx, payload || {});
    }
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (code && rooms[code]) {
      const room = rooms[code];
      const idx = socket.data.idx;
      if (idx !== undefined && room.sockets[idx] === socket.id) {
        room.sockets[idx] = null;
        pushLog(room, `${room.names[idx]}의 연결이 끊어졌습니다.`);
        broadcast(room);
      }
    }
  });
});

function handleAttackPhase(room, idx, payload) {
  const hand = room.hands[idx];

  if (payload.type === 'pass') {
    pushLog(room, `${room.names[idx]}이(가) 턴을 넘겼습니다.`);
    endTurn(room);
    return;
  }

  if (payload.type === 'heal') {
    const card = hand.find(c => c.id === payload.cardId && c.type === 'heal');
    if (!card) return;
    room.hands[idx] = hand.filter(c => c.id !== card.id);
    refill(room.hands[idx]);
    room.hp[idx] = Math.min(MAX_HP, room.hp[idx] + card.value);
    pushLog(room, `${room.names[idx]}이(가) 회복카드로 체력을 ${card.value} 회복했습니다. (${room.hp[idx]}/${MAX_HP})`);
    endTurn(room);
    return;
  }

  if (payload.type === 'attack') {
    const card = hand.find(c => c.id === payload.cardId && c.type === 'attack');
    if (!card) return;
    let total = card.value;
    let bonusText = '';

    room.hands[idx] = hand.filter(c => c.id !== card.id);

    if (payload.enhanceId) {
      const enhHand = room.enhance[idx];
      const enh = enhHand.find(c => c.id === payload.enhanceId);
      if (enh) {
        const bonus = randInt(enh.min, enh.max);
        total += bonus;
        bonusText = ` (강화 +${bonus})`;
        room.enhance[idx] = enhHand.filter(c => c.id !== enh.id);
        refillEnhance(room.enhance[idx]);
      }
    }
    refill(room.hands[idx]);

    room.pendingAttack = { attackerIdx: idx, base: card.value, total, bonusText };
    pushLog(room, `${room.names[idx]}이(가) 공격력 ${card.value}${bonusText} = 총 ${total}의 공격을 준비했습니다.`);
    room.phase = 'DEFEND';
  }
}

function handleDefendPhase(room, idx, payload) {
  const atk = room.pendingAttack;
  let dmg = atk.total;

  if (payload.type === 'defend') {
    const card = room.hands[idx].find(c => c.id === payload.cardId && c.type === 'defense');
    if (card) {
      dmg = Math.max(0, atk.total - card.value);
      pushLog(room, `${room.names[idx]}이(가) 방어카드 ${card.value}로 막아 ${dmg}의 피해만 받았습니다. (방어카드는 재사용 가능, 손에 남음)`);
    } else {
      pushLog(room, `${room.names[idx]}이(가) 공격 ${atk.total}을 그대로 맞았습니다.`);
    }
  } else {
    pushLog(room, `${room.names[idx]}이(가) 공격 ${atk.total}을 그대로 맞았습니다.`);
  }

  room.hp[idx] = Math.max(0, room.hp[idx] - dmg);
  room.pendingAttack = null;
  room.phase = 'ATTACK';

  if (room.hp[idx] <= 0) {
    room.gameOver = true;
    room.winner = 1 - idx;
    pushLog(room, `${room.names[1 - idx]}의 승리! ${room.names[idx]}이(가) 쓰러졌습니다.`);
    return;
  }

  endTurn(room);
}

function endTurn(room) {
  room.turnPlayer = 1 - room.turnPlayer;
  room.turnCount += 1;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
