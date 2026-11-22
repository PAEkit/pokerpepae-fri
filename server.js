'use strict';
// PokerPEPAE&Fri — เซิร์ฟเวอร์ (Node.js ล้วน ไม่ต้องติดตั้งแพ็กเกจเสริม)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Room, UserError } = require('./lib/game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map(); // code -> { room, clients: Set<{res, token}> }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // ไม่มี I, O กันสับสน
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function createRoom(settings) {
  const code = newCode();
  const room = new Room(code, settings);
  const entry = { room, clients: new Set() };
  room.on('change', () => broadcast(entry));
  rooms.set(code, entry);
  return entry;
}

function broadcast(entry) {
  for (const c of entry.clients) send(c, entry.room);
}
function send(client, room) {
  try {
    client.res.write(`event: state\ndata: ${JSON.stringify(room.viewFor(client.token))}\n\n`);
  } catch (e) { /* ปิดไปแล้ว */ }
}

// ---------- HTTP ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (ch) => {
      data += ch;
      if (data.length > 10000) { reject(new UserError('ข้อมูลใหญ่เกินไป')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new UserError('ข้อมูลไม่ถูกต้อง')); }
    });
  });
}

function lookup(code, token) {
  const entry = rooms.get(String(code || '').toUpperCase());
  if (!entry) throw new UserError('ไม่พบห้องนี้ (อาจหมดอายุหรือเซิร์ฟเวอร์รีสตาร์ท)', 404);
  const player = token ? entry.room.playerByToken(token) : null;
  const spec = token && !player ? entry.room.spectatorByToken(token) : null;
  return { entry, room: entry.room, player, spec };
}
// ผู้เล่นหรือผู้ชมก็ได้ (ใช้กับการดูข้อมูล)
function needMember(ctx) {
  if (ctx.player && !ctx.player.left) return ctx.player;
  if (ctx.spec) return ctx.spec;
  throw new UserError('คุณไม่ได้อยู่ในห้องนี้แล้ว', 403);
}
// เฉพาะผู้เล่น (ใช้กับทุกการกระทำ) — ผู้ชมทำอะไรไม่ได้ ล็อกที่ฝั่งเซิร์ฟเวอร์
function needPlayer(ctx) {
  if (ctx.spec) throw new UserError('โหมดผู้ชมดูได้อย่างเดียว', 403);
  if (!ctx.player || ctx.player.left) throw new UserError('คุณไม่ได้อยู่ในห้องนี้แล้ว', 403);
  return ctx.player;
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (req.method === 'GET' && route === '/api/events') {
    const ctx = lookup(url.searchParams.get('code'), url.searchParams.get('token'));
    const p = needMember(ctx);
    const isSpec = !!ctx.spec;
    const setOnline = (v) => (isSpec ? ctx.room.setSpecConnected(p, v) : ctx.room.setConnected(p, v));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const client = { res, token: p.token, mid: p.id };
    ctx.entry.clients.add(client);
    setOnline(true);
    send(client, ctx.room);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* noop */ } }, 20000);
    req.on('close', () => {
      clearInterval(ping);
      ctx.entry.clients.delete(client);
      const still = [...ctx.entry.clients].some((c) => c.token === p.token);
      if (!still) setOnline(false);
    });
    return;
  }

  if (req.method === 'GET' && route === '/api/session') {
    const ctx = lookup(url.searchParams.get('code'), url.searchParams.get('token'));
    needMember(ctx);
    return json(res, 200, { ok: true });
  }

  // รายการห้องที่ออนไลน์อยู่ (ไม่รวมห้องส่วนตัว และห้องที่ไม่มีผู้เล่นออนไลน์)
  if (req.method === 'GET' && route === '/api/rooms') {
    const list = [...rooms.values()]
      .map((e) => e.room)
      .filter((r) => !r.settings.private)
      .map((r) => ({ lastActive: r.lastActive, ...r.summary() }))
      .filter((r) => r.online > 0)
      .sort((a, b) => b.lastActive - a.lastActive)
      .slice(0, 20)
      .map(({ lastActive, ...rest }) => rest);
    return json(res, 200, list);
  }

  // ค่า ICE สำหรับเสียง: STUN ฟรีเป็นค่าเริ่มต้น ถ้าตั้งตัวแปร ICE_SERVERS (JSON) จะเพิ่มเข้าไป เช่น TURN ของผู้ให้บริการ
  if (req.method === 'GET' && route === '/api/ice') {
    const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    try {
      const extra = process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : [];
      if (Array.isArray(extra)) iceServers.push(...extra.filter((s) => s && s.urls));
    } catch (e) { console.error('ICE_SERVERS ไม่ใช่ JSON ที่ถูกต้อง'); }
    return json(res, 200, { iceServers });
  }

  if (req.method === 'GET' && route === '/api/health') return json(res, 200, { ok: true, rooms: rooms.size });

  if (req.method !== 'POST') throw new UserError('ไม่พบหน้านี้', 404);
  const body = await readBody(req);

  if (route === '/api/create') {
    const entry = createRoom(body.settings || {});
    const p = entry.room.addPlayer(body.name);
    return json(res, 200, { code: entry.room.code, token: p.token });
  }
  if (route === '/api/join') {
    const ctx = lookup(body.code, null);
    const p = ctx.room.addPlayer(body.name, body.token);
    return json(res, 200, { code: ctx.room.code, token: p.token });
  }

  if (route === '/api/watch') {
    const ctx = lookup(body.code, null);
    const s = ctx.room.addSpectator(body.name);
    return json(res, 200, { code: ctx.room.code, token: s.token });
  }

  const ctx = lookup(body.code, body.token);
  if (ctx.spec && route === '/api/leave') {
    ctx.room.removeSpectator(ctx.spec);
    return json(res, 200, { ok: true });
  }
  // ห้องเสียง: ทั้งผู้เล่นและผู้ชมใช้ได้ (ผู้ชมได้แค่โหมดฟัง — ตรวจใน room.setVoice)
  if (route === '/api/voice') {
    const m = needMember(ctx);
    ctx.room.setVoice(m, body.mode, body.muted);
    return json(res, 200, { ok: true });
  }
  if (route === '/api/signal') {
    const m = needMember(ctx);
    const data = body.data;
    if (!data || !['offer', 'answer', 'ice'].includes(data.t) || JSON.stringify(data).length > 8000) throw new UserError('ข้อมูลสัญญาณไม่ถูกต้อง');
    const target = ctx.room.memberById(String(body.to || ''));
    if (!target || target.id === m.id) throw new UserError('ไม่พบปลายทาง', 404);
    // ส่งต่อให้เฉพาะปลายทางในห้องเดียวกัน (เซิร์ฟเวอร์ไม่แตะต้องเนื้อหา)
    let sent = 0;
    for (const c of ctx.entry.clients) {
      if (c.mid !== target.id) continue;
      try { c.res.write(`event: signal\ndata: ${JSON.stringify({ from: m.id, data })}\n\n`); sent++; } catch (e) { /* ปิดไปแล้ว */ }
    }
    if (!sent) throw new UserError('ปลายทางไม่ได้ออนไลน์', 404);
    return json(res, 200, { ok: true });
  }

  // แชท: ผู้ชมพิมพ์/ส่งสติกเกอร์ได้ด้วย
  if (route === '/api/chat') {
    ctx.room.say(needMember(ctx), body.text);
    return json(res, 200, { ok: true });
  }

  const p = needPlayer(ctx);
  switch (route) {
    case '/api/action': ctx.room.act(p, { type: body.type, amount: body.amount }); break;
    case '/api/start': ctx.room.start(p); break;
    case '/api/leave': ctx.room.leave(p); break;
    case '/api/rebuy': ctx.room.rebuy(p); break;
    case '/api/show': ctx.room.showCards(p); break;
    case '/api/autoshow': ctx.room.setAutoShow(p, !!body.on); break;
    case '/api/pre': ctx.room.setPre(p, !!body.on); break;
    case '/api/shuffle': ctx.room.pickShuffle(p, body.slot); break;
    case '/api/chat': ctx.room.say(p, body.text); break;
    case '/api/kick': ctx.room.kick(p, body.target); break;
    default: throw new UserError('ไม่พบหน้านี้', 404);
  }
  json(res, 200, { ok: true });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('ไม่พบหน้านี้');
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof UserError) {
      if (!res.headersSent) json(res, e.status || 400, { error: e.message });
    } else {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: 'เซิร์ฟเวอร์ขัดข้อง' });
    }
  }
});

// ลบห้องที่ไม่มีใครใช้นานเกิน 6 ชั่วโมง
setInterval(() => {
  const now = Date.now();
  for (const [code, e] of rooms) {
    if (e.clients.size === 0 && now - e.room.lastActive > 6 * 3600 * 1000) {
      e.room.destroy();
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`PokerPEPAE&Fri กำลังทำงานที่พอร์ต ${PORT}`));
}
module.exports = { server, rooms };
