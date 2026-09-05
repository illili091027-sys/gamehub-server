// 쉬는 시간 게임판 - 온라인 방 상태 공유 서버 (외부 라이브러리 없이 Node.js만 사용)
//
// 게임판 HTML이 "이어쓰기", "픽셀 맞추기" 같은 온라인 게임을 할 때
// 방 코드별로 저장해야 하는 상태(문장 목록, 정답 진행 상황 등)를
// 아주 단순하게 저장했다가 돌려주는 역할만 합니다.
//
// - GET  /api/ping                  : 서버가 켜져 있는지 확인용
// - GET  /api/state?room=..&game=.. : 그 방/게임의 저장된 상태 읽기
// - POST /api/state?room=..&game=.. : 그 방/게임의 상태를 통째로 저장(덮어쓰기)
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
}, 30 * 60 * 1000).unref();

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
    return sendJson(res, 200, { ok: true, time: Date.now() });
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

  sendJson(res, 404, { error: 'not_found' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('게임판 서버 시작됨: http://localhost:' + PORT);
});
