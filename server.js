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
// 계정(로그인) 기능 - 아이디/비밀번호로 가입하면 게임 기록과 분필이 서버에 저장돼요:
// - POST /api/auth/register               : 가입 {id, password, blob?} -> {token, id, blob}
// - POST /api/auth/login                  : 로그인 {id, password}      -> {token, id, blob}
// - POST /api/auth/logout                 : 로그아웃 (Authorization: Bearer 토큰)
// - GET  /api/account/data                : 내 저장 데이터 읽기 -> {blob}
// - POST /api/account/data                : 내 저장 데이터 통째로 저장 {blob}
// - POST /api/account/password            : 내 비밀번호 바꾸기 {oldPassword, newPassword}
// - POST /api/admin/search                : (관리자) 아이디 검색 {adminKey, query}
// - POST /api/admin/coins                 : (관리자) 분필 개수 바꾸기 {adminKey, id, coins}
// - POST /api/admin/reset                 : (관리자) 비밀번호를 0000으로 초기화 {adminKey, id}
// 관리자 비밀번호는 환경변수 ADMIN_KEY 로 정해요. (안 정하면 관리자 기능은 꺼져 있어요)
// 계정은 accounts.json 파일에 저장돼요(환경변수 ACCOUNTS_FILE로 위치 변경 가능).
// ※ 방 상태와 달리 이 파일은 서버가 재시작돼도 남아야 하니, '지워지지 않는 디스크'에 두세요.
//
// 데이터는 메모리에만 저장돼요(서버가 재시작되면 사라짐). 방 코드로 잠깐
// 노는 게임 상태만 다루니까 이 정도면 충분해요. 별도 설치(npm install)
// 없이 node server.js 만으로 바로 실행돼요.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// key = "ROOM::game" -> { data, updatedAt }
const store = new Map();
const MAX_ENTRIES = 5000; // 메모리 보호용 상한
const MAX_BODY_BYTES = 1024 * 1024; // 요청 본문 최대 1MB

// room(대문자) -> { hostId, currentGame, players: Map(playerId -> {name, lastSeen}), updatedAt }
const rooms = new Map();
const AWAY_MS = 12 * 1000;             // 이 시간 넘게 소식이 없으면 '잠깐 자리 비움'으로 표시만
const KICK_MEMORY_MS = 10 * 60 * 1000; // 추방된 사람은 10분 동안 자동 재입장 안 됨
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

// 방 정리: 사람을 자동으로 빼지는 않고, 방장이 오래 응답 없을 때만 방장을 넘겨요
// 방장이 나갔으면 남은 사람 중 아무나(가장 먼저 들어온 사람) 새 방장으로 승격
/* 자동 추방은 껐어요: 응답이 없어도 명단에서 빼지 않아요(💤 자리 비움으로만 표시).
   방에서 빠지는 건 ① 직접 나가기/창 닫기 ② 방장이 추방했을 때뿐이에요.
   다만 방장이 오래(HOST_AWAY_MS) 응답이 없으면, 게임이 멈추지 않게 지금 접속 중인 사람에게 방장만 넘겨요. */
const HOST_AWAY_MS = 60 * 1000;
const GHOST_MS = 30 * 60 * 1000; // 30분 넘게 아무 소식 없는 사람(창을 그냥 꺼버린 경우)만 명단 정리
function pruneRoom(room) {
  const now = Date.now();
  for (const [pid, p] of room.players) {
    if (now - p.lastSeen > GHOST_MS) room.players.delete(pid);
  }
  if (room.hostId && !room.players.has(room.hostId)) {
    const next = room.players.keys().next();
    room.hostId = next.done ? null : next.value;
  }
  const host = room.hostId && room.players.get(room.hostId);
  if (host && now - host.lastSeen > HOST_AWAY_MS) {
    for (const [pid, p] of room.players) {
      if (now - p.lastSeen <= AWAY_MS) { room.hostId = pid; break; }
    }
  }
}

function getOrCreateRoom(roomCode) {
  let room = rooms.get(roomCode);
  if (!room) {
    room = { hostId: null, currentGame: null, players: new Map(), kicked: new Map(), updatedAt: Date.now() };
    rooms.set(roomCode, room);
  }
  return room;
}

function roomStateJson(room, forPid) {
  const now = Date.now();
  const out = {
    hostId: room.hostId,
    currentGame: room.currentGame,
    players: Array.from(room.players, ([id, p]) => ({ id: id, name: p.name, away: now - p.lastSeen > AWAY_MS })),
  };
  if (forPid && room.kicked && room.kicked.has(forPid)) out.kicked = true;
  return out;
}
function isKicked(room, pid) {
  if (!room.kicked) room.kicked = new Map();
  const t = room.kicked.get(pid);
  if (!t) return false;
  if (Date.now() - t > KICK_MEMORY_MS) { room.kicked.delete(pid); return false; }
  return true;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning');
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


// ===================== 계정 (아이디/비밀번호) =====================
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || path.join(__dirname, 'accounts.json');
const ADMIN_KEY = String(process.env.ADMIN_KEY || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();   // 앞뒤 공백·따옴표가 같이 들어가도 무시
const RESET_PW = '0000';
const MAX_USERS = 3000;
const MAX_BLOB_BYTES = 300 * 1024;      // 한 사람이 저장할 수 있는 데이터 총량
const MAX_VALUE_BYTES = 100 * 1024;     // 항목 하나 최대 크기
const SESSION_MS = 90 * 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_가-힣]{3,16}$/;
// 기기마다 다른 값이라 저장하지 않는 항목들
const BLOB_SKIP = new Set(['gamehub_server_url', 'gamehub_player_id', 'gamehub_lc_pos', 'gamehub_hw_room', 'gamehub_hw_name', 'gamehub_auth']);

// users: idLower -> { id, salt, hash, createdAt, updatedAt, blob }
// sessions: sha256(token) -> { user, at }
let db = { users: {}, sessions: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  if (loaded && loaded.users) db = { users: loaded.users, sessions: loaded.sessions || {} };
  console.log('계정 ' + Object.keys(db.users).length + '개 불러옴 (' + ACCOUNTS_FILE + ')');
} catch (e) { /* 처음 켠 경우 */ }

let saveTimer = null;
function saveDbSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = ACCOUNTS_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, ACCOUNTS_FILE);   // 쓰다 꺼져도 파일이 깨지지 않게
    } catch (e) { console.error('계정 파일 저장 실패:', e.message); }
  }, 400);
}
function flushDb() {
  try { fs.writeFileSync(ACCOUNTS_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(ACCOUNTS_FILE + '.tmp', ACCOUNTS_FILE); } catch (e) {}
}
process.on('SIGTERM', () => { flushDb(); process.exit(0); });
process.on('SIGINT', () => { flushDb(); process.exit(0); });

function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function sha(t) { return crypto.createHash('sha256').update(t).digest('hex'); }
function newSession(userKey) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { user: userKey, at: Date.now() };
  saveDbSoon();
  return token;
}
function tokenFrom(req, body) {
  const h = String(req.headers['authorization'] || '');
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return body && typeof body.token === 'string' ? body.token : '';
}
function userFromToken(token) {
  if (!token) return null;
  const s = db.sessions[sha(token)];
  if (!s) return null;
  if (Date.now() - s.at > SESSION_MS) { delete db.sessions[sha(token)]; saveDbSoon(); return null; }
  return db.users[s.user] ? { key: s.user, user: db.users[s.user] } : null;
}
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(db.sessions)) if (now - db.sessions[k].at > SESSION_MS) delete db.sessions[k];
  saveDbSoon();
}, 6 * 60 * 60 * 1000).unref();

// 비밀번호 무작위 대입 막기: 같은 기기+아이디로 10번 틀리면 5분 쉬어요
const fails = new Map();
function failKey(req, id) { return (req.socket.remoteAddress || '') + '|' + String(id).toLowerCase(); }
function lockedLeft(key) {
  const f = fails.get(key);
  if (f && f.until && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000);
  return 0;
}
function noteFail(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 10) { f.until = Date.now() + 5 * 60 * 1000; f.n = 0; }
  fails.set(key, f);
}
setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (!f.until || f.until < now) if (f.n === 0) fails.delete(k); }, 10 * 60 * 1000).unref();

// 저장할 데이터 정리: gamehub_로 시작하는 문자열 항목만, 크기 제한
function cleanBlob(b) {
  const out = {};
  let total = 0;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return out;
  for (const k of Object.keys(b)) {
    if (!k.startsWith('gamehub_') || k.length > 100 || BLOB_SKIP.has(k)) continue;
    const v = b[k];
    if (typeof v !== 'string' || Buffer.byteLength(v) > MAX_VALUE_BYTES) continue;
    total += Buffer.byteLength(k) + Buffer.byteLength(v);
    if (total > MAX_BLOB_BYTES) break;
    out[k] = v;
  }
  return out;
}

function handleAccount(req, res, url) {
  const p = url.pathname;
  if (req.method !== 'POST' && !(p === '/api/account/data' && req.method === 'GET')) return false;
  if (['/api/auth/register', '/api/auth/login', '/api/auth/logout', '/api/account/data', '/api/account/password', '/api/admin/search', '/api/admin/reset', '/api/admin/coins'].indexOf(p) < 0) return false;

  const run = (body) => {
    if (p === '/api/auth/register') {
      const id = String(body.id || '').trim(), pw = String(body.password || '');
      if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad_id', message: '아이디는 영어·숫자·밑줄·한글 3~16글자로 만들어요' });
      if (pw.length < 4 || pw.length > 64) return sendJson(res, 400, { error: 'bad_pw', message: '비밀번호는 4글자 이상으로 해요' });
      const key = id.toLowerCase();
      if (db.users[key]) return sendJson(res, 409, { error: 'exists', message: '이미 있는 아이디예요' });
      if (Object.keys(db.users).length >= MAX_USERS) return sendJson(res, 503, { error: 'full', message: '더 이상 가입할 수 없어요' });
      const salt = crypto.randomBytes(16).toString('hex');
      const blob = cleanBlob(body.blob);
      db.users[key] = { id: id, salt: salt, hash: hashPw(pw, salt), createdAt: Date.now(), updatedAt: Date.now(), blob: blob };
      const token = newSession(key);
      saveDbSoon();
      return sendJson(res, 200, { token: token, id: id, blob: blob });
    }
    if (p === '/api/auth/login') {
      const id = String(body.id || '').trim(), pw = String(body.password || '');
      const fk = failKey(req, id);
      const left = lockedLeft(fk);
      if (left) return sendJson(res, 429, { error: 'locked', message: '너무 많이 틀렸어요. ' + left + '초 뒤에 다시 해봐요' });
      const u = db.users[id.toLowerCase()];
      let ok = false;
      if (u) {
        const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
        ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      } else {
        hashPw(pw, 'x'.repeat(32));   // 아이디가 없어도 걸리는 시간을 비슷하게
      }
      if (!ok) { noteFail(fk); return sendJson(res, 401, { error: 'bad_login', message: '아이디나 비밀번호가 맞지 않아요' }); }
      fails.delete(fk);
      return sendJson(res, 200, { token: newSession(id.toLowerCase()), id: u.id, blob: u.blob || {}, adminCoins: u.adminCoins || null });
    }
    if (p === '/api/admin/search' || p === '/api/admin/reset' || p === '/api/admin/coins') {
      if (!ADMIN_KEY) return sendJson(res, 503, { error: 'admin_off', message: '서버에 관리자 비밀번호(ADMIN_KEY)가 설정되지 않았어요' });
      const fk = failKey(req, '__admin__');
      const left = lockedLeft(fk);
      if (left) return sendJson(res, 429, { error: 'locked', message: '너무 많이 틀렸어요. ' + left + '초 뒤에 다시 해봐요' });
      const a = crypto.createHash('sha256').update(String(body.adminKey || '')).digest();
      const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
      if (!crypto.timingSafeEqual(a, b)) { noteFail(fk); return sendJson(res, 401, { error: 'bad_admin', message: '관리자 비밀번호가 맞지 않아요' }); }
      fails.delete(fk);
      if (p === '/api/admin/search') {
        const q = String(body.query || '').trim().toLowerCase();
        const list = Object.keys(db.users).filter((k) => !q || k.includes(q)).slice(0, 1000).map((k) => {
          const u = db.users[k];
          let coins = null;
          try { coins = JSON.parse((u.blob || {}).gamehub_wallet_v1).coins; } catch (e) {}
          return { id: u.id, createdAt: u.createdAt, updatedAt: u.updatedAt, coins: coins };
        });
        return sendJson(res, 200, { users: list, total: Object.keys(db.users).length });
      }
      if (p === '/api/admin/coins') {
        const cu = db.users[String(body.id || '').trim().toLowerCase()];
        if (!cu) return sendJson(res, 400, { error: 'no_user', message: '그런 아이디가 없어요' });
        const n = Math.floor(Number(body.coins));
        if (!Number.isFinite(n) || n < 0 || n > 1e9) return sendJson(res, 400, { error: 'bad_coins', message: '분필 개수가 이상해요' });
        cu.blob = cu.blob || {};
        let w = {}; try { w = JSON.parse(cu.blob.gamehub_wallet_v1 || '{}') || {}; } catch (e) {}
        w.coins = n; if (!w.got) w.got = {}; if (!w.awarded) w.awarded = {};
        cu.blob.gamehub_wallet_v1 = JSON.stringify(w);
        cu.adminCoins = { rev: Date.now(), coins: n };   // 사용자 기기가 옛 값을 올려도 이 값이 우선
        saveDbSoon();
        console.log('[관리자] 분필 변경:', cu.id, n);
        return sendJson(res, 200, { ok: true, coins: n });
      }
      const key = String(body.id || '').trim().toLowerCase();
      const u = db.users[key];
      if (!u) return sendJson(res, 404, { error: 'no_user', message: '그런 아이디가 없어요' });
      u.salt = crypto.randomBytes(16).toString('hex');
      u.hash = hashPw(RESET_PW, u.salt);
      for (const h of Object.keys(db.sessions)) if (db.sessions[h].user === key) delete db.sessions[h];   // 로그인돼 있던 기기는 로그아웃
      for (const k of Array.from(fails.keys())) if (k.endsWith('|' + key)) fails.delete(k);
      saveDbSoon();
      console.log('[관리자] 비밀번호 초기화:', u.id);
      return sendJson(res, 200, { ok: true, id: u.id });
    }
    const who = userFromToken(tokenFrom(req, body));
    if (!who) return sendJson(res, 401, { error: 'unauthorized', message: '로그인이 필요해요' });
    if (p === '/api/auth/logout') {
      delete db.sessions[sha(tokenFrom(req, body))];
      saveDbSoon();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/account/password') {
      const oldPw = String(body.oldPassword || ''), newPw = String(body.newPassword || '');
      const a = Buffer.from(hashPw(oldPw, who.user.salt), 'hex'), b = Buffer.from(who.user.hash, 'hex');
      if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) return sendJson(res, 401, { error: 'bad_login', message: '지금 비밀번호가 맞지 않아요' });
      if (newPw.length < 4 || newPw.length > 64) return sendJson(res, 400, { error: 'bad_pw', message: '새 비밀번호는 4글자 이상으로 해요' });
      who.user.salt = crypto.randomBytes(16).toString('hex');
      who.user.hash = hashPw(newPw, who.user.salt);
      const me = sha(tokenFrom(req, body));
      for (const h of Object.keys(db.sessions)) if (db.sessions[h].user === who.key && h !== me) delete db.sessions[h];   // 다른 기기는 로그아웃
      saveDbSoon();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET') return sendJson(res, 200, { id: who.user.id, blob: who.user.blob || {}, adminCoins: who.user.adminCoins || null });
    who.user.blob = cleanBlob(body.blob);
    who.user.updatedAt = Date.now();
    saveDbSoon();
    return sendJson(res, 200, { ok: true, saved: Object.keys(who.user.blob).length });
  };

  if (req.method === 'GET') { run({}); return true; }
  readJsonBody(req, (err, body) => {
    if (err || typeof body !== 'object' || body === null) return sendJson(res, 400, { error: 'bad_request', message: '요청이 올바르지 않아요' });
    run(body);
  });
  return true;
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/account/') || url.pathname.startsWith('/api/admin/')) {
    if (handleAccount(req, res, url)) return;
  }

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('게임판 서버가 작동 중이에요. (' + store.size + '개 방 저장됨)');
  }

  if (url.pathname === '/api/ping' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, time: Date.now(), batch: true, auth: true, admin: !!ADMIN_KEY });
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
      if (body.auto && isKicked(r, playerId)) return sendJson(res, 200, roomStateJson(r, playerId));
      if (r.kicked) r.kicked.delete(playerId); // 직접 다시 입장하면 허용
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
      const r2 = getOrCreateRoom(roomCode);
      const name = String(body.name || '').slice(0, NAME_MAX_LEN);
      if (r2.players.has(playerId)) {
        r2.players.get(playerId).lastSeen = Date.now();
      } else if (name && !isKicked(r2, playerId)) {
        /* 잠깐 끊겼다 돌아온 사람(또는 서버가 재시작돼서 방이 비었을 때)은 자동으로 다시 넣어줘요 */
        r2.players.set(playerId, { name: name, lastSeen: Date.now() });
        if (!r2.hostId) r2.hostId = playerId;
      }
      r2.updatedAt = Date.now();
      pruneRoom(r2);
      return sendJson(res, 200, roomStateJson(r2, playerId));
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
      if (!r.kicked) r.kicked = new Map();
      r.kicked.set(targetId, Date.now());
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
  console.log(ADMIN_KEY ? '관리자 기능: 켜짐 (비밀번호 ' + ADMIN_KEY.length + '글자)' : '관리자 기능: 꺼짐 ← ADMIN_KEY 가 설정되지 않았어요');
});
