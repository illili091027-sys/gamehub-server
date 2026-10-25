// 쉬는 시간 게임판 - 온라인 방 상태 공유 서버 (외부 라이브러리 없이 Node.js만 사용)
//
// 두 가지 역할을 해요:
// 1) 방 로비(대기실) 관리 - 누가 들어와 있는지, 누가 방장인지, 방장이 무슨
//    게임을 골랐는지를 추적합니다.
// 2) 게임 상태 저장 - "이어쓰기", "픽셀 맞추기" 같은 게임을 할 때 방 코드별로
//    저장해야 하는 상태(문장 목록, 정답 진행 상황 등)를 저장했다가 돌려줍니다.
//
// - GET  /api/ping                        : 서버가 켜져 있는지 확인용
// - GET  /api/state?room=..&game=..       : 그 방/게임의 저장된 상태 읽기
// - POST /api/state?room=..&game=..       : 그 방/게임의 상태를 통째로 저장(덮어쓰기)
// - GET  /api/states?room=..&prefix=..    : 이름이 prefix로 시작하는 상태들을 한 번에 읽기 (실시간 게임용)
// - GET  /api/room/state?room=..          : 로비 상태(플레이어 목록/방장/선택된 게임) 읽기
// - POST /api/room/join                   : 방에 입장(또는 갱신) {room, playerId, name}
// - POST /api/room/heartbeat              : 살아있다고 알리기 {room, playerId}
// - POST /api/room/leave                  : 방 나가기 {room, playerId}
// - POST /api/room/select-game            : 방장이 게임 선택 {room, playerId, game}
// - POST /api/room/kick                   : 방장이 다른 사람 추방 {room, hostId, targetId}
// - POST /api/room/delegate               : 방장이 방장 자리 위임 {room, hostId, targetId}
//
// 데이터는 메모리에만 저장돼요(서버가 재시작되면 사라짐). 방 코드로 잠깐
// 노는 게임 상태만 다루니까 이 정도면 충분해요. 별도 설치(npm install)
// 없이 node server.js 만으로 바로 실행돼요.

const http = require('http');
const { URL } = require('url');

// key = "ROOM::game" -> { data, updatedAt }
const store = new Map();
const MAX_ENTRIES = 5000; // 메모리 보호용 상한
const MAX_BODY_BYTES = 1024 * 1024; // 요청 본문 최대 1MB

// room(대문자) -> { hostId, currentGame, players: Map(playerId -> {name, lastSeen}), updatedAt }
const rooms = new Map();
const PRESENCE_TIMEOUT_MS = 10 * 1000; // 이 시간 동안 하트비트 없으면 나간 것으로 간주
const NAME_MAX_LEN = 20;

function isValidToken(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
}

function makeKey(room, game) {
  return room.toUpperCase() + '::' + game;
}

// 24시간 이상 안 쓰인 방은 주기적으로 정리
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.updatedAt > MAX_AGE_MS) store.delete(key);
  }
  for (const [key, room] of rooms) {
    if (now - room.updatedAt > MAX_AGE_MS) rooms.delete(key);
  }
}, 30 * 60 * 1000).unref();

// 방 안에서 하트비트가 끊긴(PRESENCE_TIMEOUT_MS 이상 지난) 플레이어를 정리하고,
// 방장이 나갔으면 남은 사람 중 아무나(가장 먼저 들어온 사람) 새 방장으로 승격
function pruneRoom(room) {
  const now = Date.now();
  for (const [pid, p] of room.players) {
    if (now - p.lastSeen > PRESENCE_TIMEOUT_MS) room.players.delete(pid);
  }
  if (room.hostId && !room.players.has(room.hostId)) {
    const next = room.players.keys().next();
    room.hostId = next.done ? null : next.value;
  }
}

function getOrCreateRoom(roomCode) {
  let room = rooms.get(roomCode);
  if (!room) {
    room = { hostId: null, currentGame: null, players: new Map(), updatedAt: Date.now() };
    rooms.set(roomCode, room);
  }
  return room;
}

function roomStateJson(room) {
  return {
    hostId: room.hostId,
    currentGame: room.currentGame,
    players: Array.from(room.players, ([id, p]) => ({ id: id, name: p.name })),
  };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req, cb) {
  let chunks = [];
  let total = 0;
  let tooBig = false;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      tooBig = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooBig) return cb(new Error('too_large'), null);
    if (chunks.length === 0) return cb(null, {});
    try {
      cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (e) {
      cb(e, null);
    }
  });
  req.on('error', (e) => cb(e, null));
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('게임판 서버가 작동 중이에요. (' + store.size + '개 방 저장됨)');
  }

  if (url.pathname === '/api/ping' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, time: Date.now(), batch: true });
  }

  // 여러 사람의 상태를 한 번에 읽기 (예: prefix=pio_ → pio_사람1, pio_사람2 ...)
  // 땅따먹기/블록 배틀처럼 빠르게 주고받는 게임에서 요청 수를 크게 줄여줘요.
  if (url.pathname === '/api/states' && req.method === 'GET') {
    const room = url.searchParams.get('room') || '';
    const prefix = url.searchParams.get('prefix') || '';
    if (!isValidToken(room) || !isValidToken(prefix)) {
      return sendJson(res, 400, { error: 'room, prefix 파라미터가 올바르지 않아요' });
    }
    const head = makeKey(room, prefix);
    const out = {};
    for (const [key, entry] of store) {
      if (key.startsWith(head)) out[key.slice(room.length + 2)] = entry.data;
    }
    return sendJson(res, 200, { data: out });
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const room = url.searchParams.get('room') || '';
    const game = url.searchParams.get('game') || '';
    if (!isValidToken(room) || !isValidToken(game)) {
      return sendJson(res, 400, { error: 'room, game 파라미터가 올바르지 않아요' });
    }
    const entry = store.get(makeKey(room, game));
    return sendJson(res, 200, { data: entry ? entry.data : null });
  }

  if (url.pathname === '/api/state' && req.method === 'POST') {
    const room = url.searchParams.get('room') || '';
    const game = url.searchParams.get('game') || '';
    if (!isValidToken(room) || !isValidToken(game)) {
      return sendJson(res, 400, { error: 'room, game 파라미터가 올바르지 않아요' });
    }
    return readJsonBody(req, (err, body) => {
      if (err || typeof body !== 'object' || body === null) {
        return sendJson(res, 400, { error: '저장할 데이터가 올바르지 않아요' });
      }
      const key = makeKey(room, game);
      if (!store.has(key) && store.size >= MAX_ENTRIES) {
        let oldestKey = null, oldestTime = Infinity;
        for (const [k, e] of store) {
          if (e.updatedAt < oldestTime) { oldestTime = e.updatedAt; oldestKey = k; }
        }
        if (oldestKey) store.delete(oldestKey);
      }
      store.set(key, { data: body, updatedAt: Date.now() });
      return sendJson(res, 200, { ok: true });
    });
  }

  if (url.pathname === '/api/room/state' && req.method === 'GET') {
    const room = url.searchParams.get('room') || '';
    if (!isValidToken(room)) return sendJson(res, 400, { error: 'room 파라미터가 올바르지 않아요' });
    const roomCode = room.toUpperCase();
    const r = getOrCreateRoom(roomCode);
    pruneRoom(r);
    return sendJson(res, 200, roomStateJson(r));
  }

  if (url.pathname === '/api/room/join' && req.method === 'POST') {
    return readJsonBody(req, (err, body) => {
      if (err || typeof body !== 'object' || body === null) return sendJson(res, 400, { error: 'bad_request' });
      const room = String(body.room || '');
      const playerId = String(body.playerId || '');
      const name = String(body.name || '').slice(0, NAME_MAX_LEN);
      if (!isValidToken(room) || !isValidToken(playerId) || !name) {
        return sendJson(res, 400, { error: 'room, playerId, name이 필요해요' });
      }
      const roomCode = room.toUpperCase();
      const r = getOrCreateRoom(roomCode);
      pruneRoom(r);
      const isNew = !r.players.has(playerId);
      r.players.set(playerId, { name: name, lastSeen: Date.now() });
      if (!r.hostId) r.hostId = playerId; // 방에 아무도 없었으면 내가 방장
      r.updatedAt = Date.now();
      return sendJson(res, 200, roomStateJson(r));
    });
  }

  if (url.pathname === '/api/room/heartbeat' && req.method === 'POST') {
    return readJsonBody(req, (err, body) => {
      if (err || typeof body !== 'object' || body === null) return sendJson(res, 400, { error: 'bad_request' });
      const room = String(body.room || '');
      const playerId = String(body.playerId || '');
      if (!isValidToken(room) || !isValidToken(playerId)) return sendJson(res, 400, { error: 'bad_request' });
      const roomCode = room.toUpperCase();
      const r = rooms.get(roomCode);
      if (r && r.players.has(playerId)) {
        r.players.get(playerId).lastSeen = Date.now();
        r.updatedAt = Date.now();
      }
      const r2 = getOrCreateRoom(roomCode);
      pruneRoom(r2);
      return sendJson(res, 200, roomStateJson(r2));
    });
  }

  if (url.pathname === '/api/room/leave' && req.method === 'POST') {
    return readJsonBody(req, (err, body) => {
      if (err || typeof body !== 'object' || body === null) return sendJson(res, 400, { error: 'bad_request' });
      const room = String(body.room || '');
      const playerId = String(body.playerId || '');
      if (!isValidToken(room) || !isValidToken(playerId)) return sendJson(res, 400, { error: 'bad_request' });
      const roomCode = room.toUpperCase();
      const r = rooms.get(roomCode);
      if (r) {
        r.players.delete(playerId);
        pruneRoom(r);
        r.updatedAt = Date.now();
      }
      return sendJson(res, 200, { ok: true });
    });
  }

  if (url.pathname === '/api/room/select-game' && req.method === 'POST') {
    return readJsonBody(req, (err, body) => {
      if (err || typeof body !== 'object' || body === null) return sendJson(res, 400, { error: 'bad_request' });
      const room = String(body.room || '');
      const playerId = String(body.playerId || '');
      const game = body.game === null ? null : String(body.game || '');
      if (!isValidToken(room) || !isValidToken(playerId)) return sendJson(res, 400, { error: 'bad_request' });
      if (game !== null && !isValidToken(game)) return sendJson(res, 400, { error: 'bad_game' });
      const roomCode = room.toUpperCase();
      const r = getOrCreateRoom(roomCode);
      pruneRoom(r);
      if (r.hostId !== playerId) return sendJson(res, 403, { error: '방장만 게임을 선택할 수 있어요' });
      r.currentGame = game;
      r.updatedAt = Date.now();
      return sendJson(res, 200, roomStateJson(r));
    });
  }

  if (url.pathname === '/api/room/kick' && req.method === 'POST') {
    return readJsonBody(req, (err, body) => {
      if (err || typeof body !== 'object' || body === null) return sendJson(res, 400, { error: 'bad_request' });
      const room = String(body.room || '');
      const hostId = String(body.hostId || '');
      const targetId = String(body.targetId || '');
      if (!isValidToken(room) || !isValidToken(hostId) || !isValidToken(targetId)) {
        return sendJson(res, 400, { error: 'bad_request' });
      }
      const roomCode = room.toUpperCase();
      const r = getOrCreateRoom(roomCode);
      pruneRoom(r);
      if (r.hostId !== hostId) return sendJson(res, 403, { error: '방장만 추방할 수 있어요' });
      if (targetId === hostId) return sendJson(res, 400, { error: '자기 자신은 추방할 수 없어요' });
      r.players.delete(targetId);
      r.updatedAt = Date.now();
      return sendJson(res, 200, roomStateJson(r));
    });
  }

  if (url.pathname === '/api/room/delegate' && req.method === 'POST') {
    return readJsonBody(req, (err, body) => {
      if (err || typeof body !== 'object' || body === null) return sendJson(res, 400, { error: 'bad_request' });
      const room = String(body.room || '');
      const hostId = String(body.hostId || '');
      const targetId = String(body.targetId || '');
      if (!isValidToken(room) || !isValidToken(hostId) || !isValidToken(targetId)) {
        return sendJson(res, 400, { error: 'bad_request' });
      }
      const roomCode = room.toUpperCase();
      const r = getOrCreateRoom(roomCode);
      pruneRoom(r);
      if (r.hostId !== hostId) return sendJson(res, 403, { error: '방장만 위임할 수 있어요' });
      if (!r.players.has(targetId)) return sendJson(res, 400, { error: '그 사람은 방에 없어요' });
      r.hostId = targetId;
      r.updatedAt = Date.now();
      return sendJson(res, 200, roomStateJson(r));
    });
  }

  sendJson(res, 404, { error: 'not_found' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('게임판 서버 시작됨: http://localhost:' + PORT);
});
