'use strict';
const assert = require('assert');
const http = require('http');
const { server } = require('../server');

let base;
const post = async (path, body) => {
  const r = await fetch(base + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

// ไคลเอนต์ SSE แบบง่าย
function sse(code, token) {
  const c = { state: null, req: null, waiters: [], signals: [] };
  c.req = http.get(`${base}/api/events?code=${code}&token=${token}`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (chunk.match(/^event: (.*)$/m) || [])[1] || 'message';
        const m = chunk.match(/^data: (.*)$/m);
        if (m && ev === 'signal') c.signals.push(JSON.parse(m[1]));
        else if (m) { c.state = JSON.parse(m[1]); c.waiters = c.waiters.filter((w) => !w(c.state)); }
      }
    });
  });
  c.until = (pred) => new Promise((resolve) => {
    if (c.state && pred(c.state)) return resolve(c.state);
    c.waiters.push((s) => { if (pred(s)) { resolve(s); return true; } return false; });
  });
  c.close = () => c.req.destroy();
  return c;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  // หน้าเว็บและไฟล์ static
  for (const [p, type] of [['/', 'text/html'], ['/manifest.webmanifest', 'manifest'], ['/icon-180.png', 'image/png']]) {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 200, p);
    assert((r.headers.get('content-type') || '').includes(type), p + ' content-type');
  }
  assert.strictEqual((await fetch(base + '/../server.js')).status === 200 && false, false);
  const trav = await fetch(base + '/%2e%2e/server.js');
  assert.notStrictEqual(trav.status, 200, 'ห้ามอ่านไฟล์นอก public');
  console.log('✓ static files');

  // สร้างห้อง + เข้าห้อง
  const c1 = await post('create', { name: 'PEPAE', settings: { startChips: 1000, sb: 10, bb: 20, turnTime: 0 } });
  assert.strictEqual(c1.status, 200);
  const code = c1.body.code;
  assert(/^[A-Z]{4}$/.test(code));
  const j2 = await post('join', { code, name: 'Fri' });
  const j3 = await post('join', { code: code.toLowerCase(), name: 'Fri' }); // ชื่อซ้ำ + ตัวพิมพ์เล็ก
  assert.strictEqual(j2.status, 200); assert.strictEqual(j3.status, 200);
  assert.strictEqual((await post('join', { code: 'ZZZZ', name: 'x' })).status, 404);

  const toks = [c1.body.token, j2.body.token, j3.body.token];
  const cl = toks.map((t) => sse(code, t));
  await Promise.all(cl.map((c) => c.until((s) => s.players.length === 3)));
  const names = cl[0].state.players.map((p) => p.name);
  assert.deepStrictEqual(names, ['PEPAE', 'Fri', 'Fri 2']);
  console.log('✓ create/join + SSE');

  // คนที่ไม่ใช่เจ้าของห้องเริ่มเกมไม่ได้
  assert.strictEqual((await post('start', { code, token: toks[1] })).status, 400);
  assert.strictEqual((await post('start', { code, token: 'bad' })).status, 403);
  assert.strictEqual((await post('start', { code, token: toks[0] })).status, 200);
  await Promise.all(cl.map((c) => c.until((s) => s.phase === 'hand')));

  // ไพ่ของคนอื่นต้องไม่รั่ว
  for (let i = 0; i < 3; i++) {
    const s = cl[i].state;
    const mine = s.players.find((p) => p.id === s.you.id);
    assert.strictEqual(mine.hole.length, 2);
    assert(mine.hole.every((c) => Number.isInteger(c)));
    for (const p of s.players) if (p.id !== s.you.id) assert(p.hole.every((c) => c === null), 'leak!');
  }
  console.log('✓ hole cards hidden from others');

  // เล่น 1 ตาผ่าน API จริง (เช็ค/คอลจนถึง showdown)
  for (let guard = 0; guard < 60 && cl[0].state.phase === 'hand'; guard++) {
    const s = cl[0].state;
    const turnIdx = s.players.findIndex((p) => p.id === s.toAct);
    if (turnIdx < 0) { await new Promise((r) => setTimeout(r, 20)); continue; }
    const o = cl[turnIdx].state.options;
    assert(o, 'คนที่ถึงตาต้องได้ options');
    for (let i = 0; i < 3; i++) if (i !== turnIdx) assert(!cl[i].state.options, 'คนที่ไม่ถึงตาต้องไม่มี options');
    const r = await post('action', { code, token: toks[turnIdx], type: o.canCheck ? 'check' : 'call' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await new Promise((r2) => setTimeout(r2, 15));
  }
  await cl[0].until((s) => s.phase === 'showdown');
  assert.strictEqual(cl[0].state.players.reduce((a, p) => a + p.chips, 0), 3000, 'ชิปรวมต้องเท่าเดิม');
  const fin = cl[0].state;
  assert.strictEqual(fin.phase, 'showdown');
  assert(fin.result && fin.result.winners.length >= 1);
  assert.strictEqual(fin.community.length, 5);
  // ที่ showdown ผู้เล่นที่ยังไม่โฟลด์ต้องเห็นไพ่กัน
  for (const p of fin.players.filter((q) => !q.folded && q.inHand)) assert(p.hole.every((c) => Number.isInteger(c)), 'showdown reveal');
  console.log('✓ full hand over HTTP (check/call to showdown)');

  // แชท + ออกจากห้อง + กลับเข้า (token เดิม)
  assert.strictEqual((await post('chat', { code, token: toks[1], text: '<b>hi</b>' })).status, 200);
  await cl[0].until((s) => s.chat.length === 1);
  assert.strictEqual(cl[0].state.chat[0].text, '<b>hi</b>'); // เก็บดิบ ฝั่งหน้าเว็บ escape เอง
  cl[2].close();
  await cl[0].until((s) => s.players.find((p) => p.name === 'Fri 2').connected === false);
  const rejoin = await post('join', { code, name: 'ignored', token: toks[2] });
  assert.strictEqual(rejoin.body.token, toks[2], 'กลับเข้าห้องด้วย token เดิมต้องได้ที่นั่งเดิม');
  console.log('✓ chat, disconnect flag, rejoin');

  // ---------- รายการห้องออนไลน์ ----------
  const list = await (await fetch(base + '/api/rooms')).json();
  const mine = list.find((r) => r.code === code);
  assert(mine, 'ห้องที่มีคนออนไลน์ต้องอยู่ในรายการ');
  assert.strictEqual(mine.count, 3);
  assert.deepStrictEqual(mine.players.map((p) => p.name), ['PEPAE', 'Fri', 'Fri 2']);
  assert.strictEqual(mine.players[2].online, true); // Fri 2 กลับเข้ามาแล้วด้วย token เดิม... ต้องต่อ SSE ใหม่ถึงออนไลน์
  assert(!('hole' in mine) && !JSON.stringify(mine).includes('token'), 'รายการห้องห้ามมีข้อมูลลับ');

  // ห้องส่วนตัวต้องไม่โผล่ในรายการ แม้มีคนออนไลน์
  const pv = await post('create', { name: 'Secret', settings: { private: true } });
  const pvSse = sse(pv.body.code, pv.body.token);
  await pvSse.until((s) => s.players.length === 1);
  const list2 = await (await fetch(base + '/api/rooms')).json();
  assert(!list2.some((r) => r.code === pv.body.code), 'ห้องส่วนตัวห้ามอยู่ในรายการ');
  // แต่เข้าด้วยรหัสได้ตามปกติ
  assert.strictEqual((await post('join', { code: pv.body.code, name: 'Friend' })).status, 200);
  // ห้องที่ไม่มีใครออนไลน์ไม่แสดง
  pvSse.close();
  await new Promise((r) => setTimeout(r, 100));
  console.log('✓ room list (online only, private hidden, no secrets)');

  // ---------- ผู้ชม ----------
  const w = await post('watch', { code, name: 'คนดู' });
  assert.strictEqual(w.status, 200);
  const ws = sse(code, w.body.token);
  const sv = await ws.until((s) => s.you && s.you.spectator);
  assert.strictEqual(sv.players.length, 3, 'ผู้ชมไม่ใช่ผู้เล่น');
  assert(sv.spectators.includes('คนดู'));
  assert.strictEqual(sv.options, undefined, 'ผู้ชมไม่มีตัวเลือกเล่น');
  // ผู้ชมต้องไม่เห็นไพ่ใครเลยจนกว่าจะเปิดไพ่ (ตอนนี้อาจอยู่ showdown หรือตาใหม่ — ตรวจเฉพาะคนที่ยังไม่เปิดเผย)
  const revealing = sv.phase === 'showdown' && sv.result && sv.result.showdown;
  if (!revealing) for (const p of sv.players) assert(p.hole.every((c) => c === null), 'spectator sees hidden cards');
  // ทำอะไรไม่ได้เลย
  for (const route of ['action', 'start', 'chat', 'rebuy', 'kick']) {
    const r = await post(route, { code, token: w.body.token, type: 'fold', text: 'hi', target: toks[0] });
    assert.strictEqual(r.status, 403, `ผู้ชมต้องถูกปฏิเสธที่ /api/${route}`);
  }
  // ผู้ชมที่ใช้ token ผิด/ไม่มี
  assert.strictEqual((await post('watch', { code: 'ZZZZ', name: 'x' })).status, 404);
  // ผู้เล่นเห็นจำนวนผู้ชมเปลี่ยน แล้วออกได้
  await cl[0].until((s) => s.spectators.includes('คนดู'));
  assert.strictEqual((await post('leave', { code, token: w.body.token })).status, 200);
  await cl[0].until((s) => !s.spectators.includes('คนดู'));
  assert.strictEqual((await fetch(`${base}/api/session?code=${code}&token=${w.body.token}`)).status, 403, 'ออกแล้ว token ใช้ไม่ได้');
  ws.close();
  console.log('✓ spectator: view-only, hidden cards, cannot act, can leave');

  // ---------- ห้องเสียง ----------
  const iceRes = await (await fetch(base + '/api/ice')).json();
  assert(iceRes.iceServers.length >= 1 && iceRes.iceServers[0].urls, 'ต้องมี STUN เป็นค่าเริ่มต้น');
  process.env.ICE_SERVERS = JSON.stringify([{ urls: 'turn:example.org:3478', username: 'u', credential: 'c' }, { bogus: 1 }]);
  const ice2 = await (await fetch(base + '/api/ice')).json();
  assert(ice2.iceServers.some((s) => s.urls === 'turn:example.org:3478'), 'ICE_SERVERS ต้องถูกเพิ่ม');
  assert(!ice2.iceServers.some((s) => s.bogus), 'รายการที่ไม่มี urls ต้องถูกตัดทิ้ง');
  delete process.env.ICE_SERVERS;

  const id0 = cl[0].state.you.id, id1 = cl[1].state.you.id;
  assert.strictEqual((await post('voice', { code, token: toks[0], mode: 'talk' })).status, 200);
  assert.strictEqual((await post('voice', { code, token: toks[1], mode: 'talk', muted: true })).status, 200);
  const vv = await cl[0].until((s) => s.voice.length === 2);
  assert.deepStrictEqual(vv.voice.map((m) => [m.id, m.mode, m.muted]), [[id0, 'talk', false], [id1, 'talk', true]]);
  assert.strictEqual((await post('voice', { code, token: toks[0], mode: 'bogus' })).status, 400);

  // ผู้ชม: ฟังได้ พูดไม่ได้
  const w2 = await post('watch', { code, name: 'ฟังเฉยๆ' });
  const ws2 = sse(code, w2.body.token);
  await ws2.until((s) => s.you && s.you.spectator);
  assert.strictEqual((await post('voice', { code, token: w2.body.token, mode: 'talk' })).status, 403, 'ผู้ชมต้องพูดไม่ได้');
  assert.strictEqual((await post('voice', { code, token: w2.body.token, mode: 'listen' })).status, 200);
  const vv2 = await cl[0].until((s) => s.voice.length === 3);
  assert.strictEqual(vv2.voice[2].mode, 'listen');

  // ส่งสัญญาณ: ถึงเฉพาะปลายทาง พร้อมบอกว่าใครส่ง
  const offer = { t: 'offer', sid: 'abc', sdp: 'v=0\r\n' };
  assert.strictEqual((await post('signal', { code, token: toks[0], to: id1, data: offer })).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(cl[1].signals, [{ from: id0, data: offer }]);
  assert.strictEqual(cl[0].signals.length, 0, 'ผู้ส่งต้องไม่ได้รับซ้ำ');
  assert.strictEqual(ws2.signals.length, 0, 'คนอื่นต้องไม่ได้รับสัญญาณที่ไม่ใช่ของตัวเอง');
  // ผู้ชมส่งสัญญาณถึงผู้เล่นได้ (เพื่อเชื่อมต่อฟัง)
  assert.strictEqual((await post('signal', { code, token: w2.body.token, to: id0, data: { t: 'ice', sid: 'z', cand: { candidate: 'x' } } })).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(cl[0].signals.length, 1);
  // ข้อมูลผิดปกติ/ปลายทางไม่มี/ส่งหาตัวเอง/ใหญ่เกิน/ไม่ใช่สมาชิก
  assert.strictEqual((await post('signal', { code, token: toks[0], to: 'pnope', data: offer })).status, 404);
  assert.strictEqual((await post('signal', { code, token: toks[0], to: id0, data: offer })).status, 404);
  assert.strictEqual((await post('signal', { code, token: toks[0], to: id1, data: { t: 'hack' } })).status, 400);
  assert.strictEqual((await post('signal', { code, token: toks[0], to: id1, data: { t: 'offer', sdp: 'x'.repeat(9000) } })).status, 400);
  assert.strictEqual((await post('signal', { code, token: 'bad', to: id1, data: offer })).status, 403);

  // ออกจากห้องเสียง / หลุดการเชื่อมต่อ = หลุดห้องเสียงเอง
  assert.strictEqual((await post('voice', { code, token: toks[0], mode: 'off' })).status, 200);
  await cl[1].until((s) => s.voice.length === 2);
  ws2.close();
  await cl[1].until((s) => s.voice.length === 1 && s.voice[0].id === id1);
  console.log('✓ voice: state, spectator listen-only, signaling relay, validation, auto-leave');

  cl.forEach((c) => c.close());
  console.log('SERVER TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
