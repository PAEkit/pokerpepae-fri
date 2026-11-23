'use strict';
const assert = require('assert');
const { evaluate } = require('../lib/hands');
const { Room } = require('../lib/game');

// ---------- ทดสอบการจัดอันดับมือ ----------
const C = (s) => {
  const r = '23456789TJQKA'.indexOf(s[0]);
  const su = 'shdc'.indexOf(s[1]);
  return su * 13 + r;
};
const H = (str) => evaluate(str.split(' ').map(C));
const cases = [
  ['As Ks Qs Js Ts 2d 3c', 'รอยัลฟลัช'],
  ['9h 8h 7h 6h 5h Ad Ac', 'สเตรทฟลัช'],
  ['Ah 2h 3h 4h 5h Kd Kc', 'สเตรทฟลัช'], // wheel flush
  ['Kh Kd Kc Ks 2d 3c 4s', 'โฟร์การ์ด'],
  ['Kh Kd Kc 2s 2d 3c 4s', 'ฟูลเฮ้าส์'],
  ['Kh Kd Kc 2s 2d 2c 4s', 'ฟูลเฮ้าส์'], // สองตอง เลือก KKK22
  ['2h 9h 4h Jh Kh Ad 3c', 'ฟลัช'],
  ['Ah 2d 3c 4s 5h 9d Kc', 'สเตรท'], // wheel
  ['6h 7d 8c 9s Th 2d 2c', 'สเตรท'],
  ['Kh Kd Kc 2s 5d 9c 4s', 'ตอง'],
  ['Kh Kd 5c 5s 2d 9c 4s', 'สองคู่'],
  ['Kh Kd 5c 6s 2d 9c 4s', 'หนึ่งคู่'],
  ['Ah Kd 5c 6s 2d 9c 4s', 'ไฮการ์ด'],
];
for (const [hand, name] of cases) assert.strictEqual(H(hand).name, name, hand);

// เปรียบเทียบผู้ชนะ
const beats = (a, b) => assert(H(a).score > H(b).score, `${a} should beat ${b}`);
beats('Ah Ad Kc 7s 2d 9c 4s', 'Kh Kd Ac 7s 2d 9c 4s');        // คู่ A > คู่ K
beats('Ah Kd 5c 6s 2d 9c 4s', 'Ah Qd 5c 6s 2d 9c 4s');        // kicker
beats('6h 7d 8c 9s Th 2d 2c', 'Ah 2d 3c 4s 5h 9d Kc');        // สเตรทสูง > wheel
beats('Kh Kd Kc 2s 2d 3c 4s', 'Qh Qd Qc As Ad 3c 4s');        // ฟูลเฮ้าส์ตองสูงกว่า
beats('Kh Kd 5c 5s 2d 9c 4s', 'Kh Kd 4c 4s 2d 9c Ts');        // สองคู่ ตัวล่างสูงกว่า
assert.strictEqual(H('Ah Kd 5c 6s 2d 9c 4s').score, H('Ac Ks 5d 6h 2c 9s 4d').score); // เสมอ
console.log('✓ hand ranking');

// ---------- จำลองเล่นทั้งเกมหลายร้อยรอบ ----------
function rand(n) { return Math.floor(Math.random() * n); }

function playGame(nPlayers, opts = {}) {
  const room = new Room('TEST', { startChips: opts.startChips || 500, sb: 5, bb: 10, turnTime: 0 }, { shuffleEvery: 0, nextHandDelay: 1e9, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 });
  const ps = [];
  for (let i = 0; i < nPlayers; i++) ps.push(room.addPlayer('P' + i));
  const totalChips = ps.length * room.settings.startChips;
  room.start(ps[0]);
  let hands = 0;
  let guard = 0;
  while (room.phase !== 'waiting' && hands < (opts.maxHands || 200)) {
    if (++guard > 100000) throw new Error('infinite loop');
    if (room.phase === 'hand') {
      const p = room.players[room.toActIdx];
      assert(p, 'ต้องมีคนถึงตา');
      const o = room.optionsFor(p);
      const r = Math.random();
      let a;
      if (r < 0.15 && !o.canCheck) a = { type: 'fold' };
      else if (r < 0.25) a = { type: 'allin' };
      else if (r < 0.45 && o.canRaise) a = { type: 'raise', amount: o.minRaiseTo + rand(Math.max(1, o.maxRaiseTo - o.minRaiseTo + 1)) };
      else a = o.canCheck ? { type: 'check' } : { type: 'call' };
      room.act(p, a);
    } else if (room.phase === 'showdown') {
      hands++;
      // ชิปรวมต้องเท่าเดิมเสมอ
      const sum = room.players.reduce((s, q) => s + q.chips, 0);
      assert.strictEqual(sum, totalChips - 0, `chips must be conserved (hand ${hands}) got ${sum} want ${totalChips}`);
      for (const q of room.players) assert(q.chips >= 0, 'negative chips');
      const won = room.result.winners.reduce((s, w) => s + w.won, 0);
      const potSum = room.result.pots.reduce((s, x) => s + x.amount, 0);
      assert.strictEqual(won, potSum, 'winners should receive entire pot');
      room.startHand();
    } else break;
  }
  room.destroy();
  return hands;
}

let total = 0;
for (let g = 0; g < 300; g++) total += playGame(2 + (g % 8));
console.log(`✓ simulated ${total} hands, chips always conserved`);

// ---------- กรณีเฉพาะ ----------
// 1) ไซด์พ็อต: A(100) B(300) C(300) ออลอินทั้งหมด
{
  const room = new Room('T', { startChips: 1000, sb: 5, bb: 10, turnTime: 0 }, { shuffleEvery: 0, nextHandDelay: 1e9, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  a.chips = 100; b.chips = 300; c.chips = 300;
  room.start(a);
  // บังคับไพ่: A ได้ AA, B ได้ KK, C ได้ QQ ; บอร์ดไม่ช่วย
  const set = (p, x, y) => { p.hole = [C(x), C(y)]; };
  set(a, 'As', 'Ad'); set(b, 'Ks', 'Kd'); set(c, 'Qs', 'Qd');
  room.deck = ['2c', '3d', '8h', '9c', '4s', '6d', '7s', 'Jh', '5c'].reverse().map(C); // pop ได้จากท้าย
  // ต้องมีไพ่พอสำหรับเผา+บอร์ด: ลำดับ pop: burn, f1,f2,f3, burn, turn, burn, river
  room.deck = ['Td', '2c', '3d', '8h', '9c', '4s', '6d', '7s', 'Jh', '5c'].reverse().map(C);
  for (let i = 0; i < 3 && room.phase === 'hand'; i++) {
    const p = room.players[room.toActIdx];
    room.act(p, { type: 'allin' });
  }
  assert.strictEqual(room.phase, 'showdown');
  const byName = Object.fromEntries(room.players.map((p) => [p.name, p.chips]));
  assert.strictEqual(byName.A, 300, 'A ชนะพ็อตหลัก 3x100');
  assert.strictEqual(byName.B, 400, 'B ชนะไซด์พ็อต 2x200');
  assert.strictEqual(byName.C, 0);
  assert.strictEqual(room.result.pots.length, 2);
  console.log('✓ side pot');
}

// 2) ทุกคนโฟลด์ → ได้พ็อตโดยไม่เปิดไพ่
{
  const room = new Room('T', { startChips: 1000, sb: 5, bb: 10, turnTime: 0 }, { shuffleEvery: 0, nextHandDelay: 1e9, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  room.start(a);
  room.act(room.players[room.toActIdx], { type: 'fold' });
  room.act(room.players[room.toActIdx], { type: 'fold' });
  assert.strictEqual(room.phase, 'showdown');
  assert.strictEqual(room.result.showdown, false);
  const v = room.viewFor(a.token);
  assert(v.players.every((p) => p.id === a.id ? true : p.hole.every((x) => x === null) || p.hole.length === 0), 'ต้องไม่เห็นไพ่คนอื่น');
  assert.strictEqual(room.players.reduce((s, p) => s + p.chips, 0), 3000);
  console.log('✓ fold-out win');
}

// 3) เฮดส์อัพ: ดีลเลอร์เป็น SB และเล่นก่อนพรีฟลอป
{
  const room = new Room('T', { startChips: 1000, sb: 5, bb: 10, turnTime: 0 }, { shuffleEvery: 0, nextHandDelay: 1e9, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 });
  const [a, b] = ['A', 'B'].map((n) => room.addPlayer(n));
  room.start(a);
  const dealer = room.players[room.dealerIdx];
  assert.strictEqual(room.players[room.toActIdx], dealer);
  assert.strictEqual(dealer.bet, 5);
  console.log('✓ heads-up blinds');
}

// 4) ตรวจกันโกง: ไพ่คนอื่นไม่รั่วใน view, ทำผิดตา/ผิดกติกาแล้ว error
{
  const room = new Room('T', { startChips: 1000, sb: 5, bb: 10, turnTime: 0 }, { shuffleEvery: 0, nextHandDelay: 1e9, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  room.start(a);
  const view = JSON.stringify(room.viewFor(a.token));
  for (const p of [b, c]) for (const card of p.hole) {
    // ไพ่ของคนอื่นห้ามปรากฏเป็นค่าใน players[].hole ของ view
    const parsed = JSON.parse(view);
    for (const pl of parsed.players) if (pl.id === p.id) assert(pl.hole.every((x) => x === null));
  }
  const notTurn = room.players.find((p, i) => i !== room.toActIdx);
  assert.throws(() => room.act(notTurn, { type: 'fold' }), /ยังไม่ถึงตา/);
  const cur = room.players[room.toActIdx];
  assert.throws(() => room.act(cur, { type: 'raise', amount: 11 }), /อย่างน้อย/);
  assert.throws(() => room.act(cur, { type: 'check' }), /เช็คไม่ได้/);
  console.log('✓ hidden cards & validation');
}

// 4b) ออกจากห้องกลางตา / จบเกม / เริ่มใหม่ / ซื้อชิป / หลุดการเชื่อมต่อ
{
  const mk = (n) => {
    const room = new Room('T', { startChips: 1000, sb: 5, bb: 10, turnTime: 0 }, { shuffleEvery: 0, nextHandDelay: 1e9, offlineDelay: 50, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 });
    const ps = Array.from({ length: n }, (_, i) => room.addPlayer('P' + i));
    return { room, ps };
  };
  // สองคน: คนหนึ่งออกกลางตา → อีกคนชนะทันที
  let { room, ps } = mk(2);
  room.start(ps[0]);
  room.leave(ps[1]);
  assert.strictEqual(room.phase, 'showdown');
  assert.strictEqual(room.result.winners[0].id, ps[0].id);
  assert(ps[0].chips > 1000, 'ผู้ชนะได้บลายด์ของคนที่ออก');
  assert.strictEqual(ps[0].chips + ps[1].chips, 2000, 'ชิปรวมต้องเท่าเดิม');
  room.destroy();

  // สามคน: คนที่ถึงตาออก → เกมเดินต่อ ไม่ค้าง
  ({ room, ps } = mk(3));
  room.start(ps[0]);
  const cur = room.players[room.toActIdx];
  room.leave(cur);
  assert.strictEqual(room.phase, 'hand');
  assert.notStrictEqual(room.players[room.toActIdx], cur);
  assert(room.players[room.toActIdx], 'ต้องมีคนถึงตาต่อ');
  room.destroy();

  // คนหนึ่งชนะหมด → หยุดรอบายอิน (ไม่มีเริ่มเกมใหม่/ไม่รีเซ็ตชิป) → พอมีคนบายอิน เกมเดินต่อเอง
  ({ room, ps } = mk(2));
  ps[0].chips = 1000; ps[1].chips = 20;
  room.start(ps[0]);
  ps[0].hole = [C('As'), C('Ad')]; ps[1].hole = [C('2c'), C('7d')];
  room.deck = ['Td', '3h', '4s', '9c', 'Jd', '8h', 'Qs', 'Kc'].reverse().map(C);
  for (let g = 0; g < 20 && room.phase === 'hand'; g++) room.act(room.players[room.toActIdx], { type: 'allin' });
  assert.strictEqual(room.phase, 'showdown');
  room.startHand();
  const loser = ps.find((p) => p.chips === 0);
  assert.strictEqual(loser, ps[1], 'คนที่ชิปหมดต้องเป็น P1');
  {
    assert.strictEqual(room.phase, 'waiting');
    assert.strictEqual(room.viewFor(ps[0].token).soleId, ps[0].id);
    const before = ps[0].chips;
    assert(before > 1000, 'ผู้ชนะมีชิปมากกว่าตอนเริ่ม');
    assert.throws(() => room.start(ps[0]), /เกมเริ่มไปแล้ว/, 'ไม่มีการเริ่มเกมใหม่');
    assert.throws(() => room.rebuy(ps[0]), /ยังมีชิป/);
    assert.strictEqual(room.community.length, 0, 'โต๊ะต้องเคลียร์ไพ่ตอนรอ');
    assert.strictEqual(room.totalPot(), 0, 'พ็อตต้องเป็น 0 ตอนรอ');
    room.rebuy(loser);
    assert.strictEqual(loser.chips + loser.bet, 1000, 'ได้ชิปบายอินครบ (ตาใหม่เริ่มแล้ว จึงอาจหักบลายด์ไปแล้ว)');
    assert.strictEqual(loser.rebuys, 1);
    assert.strictEqual(room.phase, 'hand', 'บายอินแล้วมีชิป 2 คน เกมต้องเดินต่อเอง');
    assert.strictEqual(room.handNo, 2, 'เลขตาต่อเนื่อง ไม่เริ่มนับใหม่');
    assert.strictEqual(ps[0].chips + ps[1].chips + room.totalPot(), before + 1000, 'ชิปของผู้ชนะต้องไม่ถูกรีเซ็ต');
  }
  room.destroy();

  // ผู้เล่นหลุดการเชื่อมต่อตอนถึงตา → ระบบโฟลด์ให้หลังหน่วงสั้นๆ
  ({ room, ps } = mk(3));
  room.start(ps[0]);
  const t = room.players[room.toActIdx];
  room.setConnected(t, false);
  global.__offline = new Promise((r) => setTimeout(() => { assert(t.folded, 'คนหลุดต้องถูกโฟลด์อัตโนมัติ'); room.destroy(); r(); }, 200));
  console.log('✓ leave mid-hand / game end / restart / rebuy');
}

// 4c) ออลอิน: เปิดไพ่ในมือให้เห็น แล้วเปิดไพ่กลางทีละใบแบบเว้นจังหวะ (ใช้เวลาจริงสั้นๆ ในเทสต์)
(async () => {
  const room = new Room('T', { startChips: 1000, sb: 5, bb: 10, turnTime: 0 },
    { shuffleEvery: 0, nextHandDelay: 1e9, runoutFirstDelay: 60, runoutDelay: 60, resumeDelay: 0 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  room.start(a);
  const seen = [];
  const snap = () => ({ phase: room.phase, board: room.community.length, runout: room.runout });
  room.on('change', () => { const s = snap(); const last = seen[seen.length - 1]; if (!last || JSON.stringify(last) !== JSON.stringify(s)) seen.push(s); });

  // ก่อนออลอิน ไพ่ของคนอื่นต้องไม่เปิด
  for (const p of room.players) for (const q of room.viewFor(a.token).players) if (q.id !== a.id) assert(q.hole.every((x) => x === null));
  const t0 = Date.now();
  for (let g = 0; g < 6 && room.phase === 'hand' && room.toActIdx >= 0; g++) room.act(room.players[room.toActIdx], { type: 'allin' });
  assert.strictEqual(room.phase, 'hand', 'ต้องยังไม่จบทันที — กำลังเปิดไพ่ทีละใบ');
  assert.strictEqual(room.runout, true);
  assert.strictEqual(room.community.length, 0, 'ยังไม่เปิดไพ่กลางทันที');
  assert.strictEqual(room.toActIdx, -1);
  assert.throws(() => room.act(room.players[0], { type: 'check' }), /ยังไม่ถึงตา/, 'ระหว่างเปิดไพ่ห้ามกดอะไร');
  // ผู้เล่นทุกคนที่ยังอยู่ในมือเห็นไพ่ของกันและกันระหว่างเปิดไพ่
  const v = room.viewFor(a.token);
  assert.strictEqual(v.runout, true);
  for (const q of v.players.filter((x) => !x.folded && x.inHand)) assert(q.hole.every((x) => Number.isInteger(x)), 'ออลอินแล้วต้องเปิดไพ่ในมือ');

  await new Promise((r) => { const iv = setInterval(() => { if (room.phase === 'showdown') { clearInterval(iv); r(); } }, 10); });
  const elapsed = Date.now() - t0;
  const boards = seen.filter((s) => s.phase === 'hand').map((s) => s.board);
  assert.deepStrictEqual([...new Set(boards)], [0, 3, 4, 5], `ต้องเปิดทีละ 0→3→4→5 แต่ได้ ${boards}`);
  assert(elapsed >= 60 * 4 - 20, `ต้องเว้นจังหวะจริง (ใช้ ${elapsed}ms)`);
  assert.strictEqual(room.community.length, 5);
  assert.strictEqual(room.players.reduce((s, p) => s + p.chips, 0), 3000);
  room.destroy();
  console.log('✓ all-in runout paced (0→3→4→5), hole cards revealed');
})();

// 4b) สถิติกำจัดผู้เล่น + กราฟชิป + ตำแหน่ง SB/BB
(() => {
  const room = new Room('K', { startChips: 500, sb: 5, bb: 10, turnTime: 0 }, { shuffleEvery: 0, nextHandDelay: 1e9, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 });
  const ps = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  room.start(ps[0]);
  const v0 = room.viewFor(ps[0].token);
  assert.strictEqual(v0.players.filter((p) => p.isSB).length, 1);
  assert.strictEqual(v0.players.filter((p) => p.isBB).length, 1);
  for (let i = 0; i < 20 && room.phase === 'hand'; i++) { const p = room.players[room.toActIdx]; if (!p) break; room.act(p, { type: 'allin' }); }
  assert.strictEqual(room.phase, 'showdown');
  const v = room.viewFor(ps[0].token);
  const dead = v.players.filter((p) => p.chips === 0);
  assert(dead.length >= 1, 'ต้องมีคนชิปหมด');
  const kills = v.players.reduce((s, p) => s + p.kills, 0);
  assert(kills >= dead.length, 'ต้องนับการกำจัด');
  assert.strictEqual(v.chart.pts.length, 2);
  assert.deepStrictEqual(v.chart.pts[0].slice(1), [500, 500, 500]);
  assert.strictEqual(v.chart.pts[1].slice(1).reduce((a, b) => a + b, 0), 1500);
  room.destroy();
  console.log('✓ kills, chip chart, SB/BB flags');
})();

// 4c) ทัวร์นาเมนต์
(async () => {
  const T = { shuffleEvery: 0, nextHandDelay: 1e9, tourEndDelay: 0, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 };
  const allinHand = (room) => { for (let i = 0; i < 40 && room.phase === 'hand'; i++) { const p = room.players[room.toActIdx]; if (!p) break; room.act(p, { type: 'allin' }); } };
  const foldHand = (room) => { for (let i = 0; i < 40 && room.phase === 'hand'; i++) { const p = room.players[room.toActIdx]; if (!p) break; const o = room.optionsFor(p); room.act(p, { type: o.canCheck ? 'check' : 'fold' }); } };

  // บลายด์เพิ่ม 2 เท่าทุก N ตา, ชิป = ฿ x 10, ล็อกคนเข้า
  let room = new Room('TA', { tournament: true, buyIn: 100, sb: 10, bb: 20, levelHands: 2, turnTime: 0 }, T);
  let ps = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  assert.strictEqual(room.settings.startChips, 1000);
  room.start(ps[0]);
  const seen = [];
  for (let h = 0; h < 4; h++) { seen.push(room.settings.bb); foldHand(room); room.startHand(); }
  assert.deepStrictEqual(seen, [20, 20, 40, 40], 'บลายด์ต้องเพิ่ม 2 เท่าทุก 2 ตา ได้ ' + seen);
  assert.throws(() => room.addPlayer('Z'), /เริ่มไปแล้ว/, 'บลายด์ขึ้นแล้ว เข้าไม่ได้');
  room.destroy();

  // สมัครเข้าร่วมกลางเกมได้ จนกว่าบลายด์จะขึ้นครั้งแรก
  room = new Room('TL', { tournament: true, buyIn: 100, sb: 10, bb: 20, levelHands: 3, turnTime: 0 }, T);
  ps = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  room.start(ps[0]);
  assert.ok(room.lateOpen());
  const late = room.addPlayer('Late');
  assert.strictEqual(late.chips, 1000);
  assert.ok(room.viewFor(ps[0].token).tourney.lateOpen);
  foldHand(room); room.startHand();
  assert.ok(room.players.find((q) => q.name === 'Late').inHand, 'คนใหม่ได้เล่นตาถัดไป');
  foldHand(room); room.startHand(); // ตาที่ 3 = ระดับบลายด์แรกสุดท้าย
  assert.ok(!room.lateOpen(), 'ตาที่ 3 แล้วปิดรับ');
  assert.throws(() => room.addPlayer('Z2'), /เริ่มไปแล้ว/);
  room.destroy();

  // 3 คน: ชิปหมด = ตกรอบทันที (ปิดบายอิน) และกลายเป็นผู้ชม จนเหลือผู้ชนะ
  room = new Room('TB', { tournament: true, buyIn: 100, sb: 10, bb: 20, turnTime: 0 }, T);
  ps = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  room.start(ps[0]);
  for (let g = 0; g < 30 && room.phase !== 'over'; g++) {
    if (room.phase === 'hand') allinHand(room);
    else if (room.phase === 'showdown') room.startHand();
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.strictEqual(room.phase, 'over', 'ต้องจบทัวร์นาเมนต์');
  const res = room.tour.result;
  assert.deepStrictEqual(res.rows.map((r) => r.place), [1, 2, 3]);
  assert.strictEqual(res.pool, 300);
  assert.strictEqual(res.rows.reduce((a, r) => a + r.prize + r.bounty, 0), 300, 'รางวัลรวมต้องเท่ายอดบายอิน');
  assert.ok(res.rows.every((r) => r.prize % 10 === 0 && r.bounty % 10 === 0));
  assert.ok(res.bountyTotal === 0 || res.bountyTotal === 100, 'Bounty ขั้นต่ำ 100 และถูกแจกเฉพาะเมื่อมีคนกำจัดผู้เล่น');
  const loser = room.players.find((p) => p.place === 3);
  assert(loser.out && room.viewFor(loser.token).you.spectator, 'ผู้ตกรอบต้องเป็นผู้ชม');
  room.destroy();

  // สูตรเงินรางวัล: Bounty 10% (ขั้นต่ำ 100) แล้วที่เหลือ 50/30/20 ปัดหลัก 10
  room = new Room('TP', { tournament: true, buyIn: 100, sb: 10, bb: 20, turnTime: 0 }, T);
  ps = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  assert.deepStrictEqual(room.payouts(1000).prizes, [500, 300, 200], 'ไม่มีใครกำจัดใคร → Bounty คืนกองกลาง');
  ps[1].kills = 2;
  let po = room.payouts(1000);
  assert.strictEqual(po.each, 100); assert.deepStrictEqual(po.prizes, [450, 270, 180]);
  po = room.payouts(300); assert.strictEqual(po.each, 100); assert.deepStrictEqual(po.prizes, [100, 60, 40]);
  ps[0].kills = 2; po = room.payouts(1000); assert.strictEqual(po.each, 50, 'เสมอกันแบ่งเท่ากัน'); assert.deepStrictEqual(po.prizes, [450, 270, 180]);
  assert.strictEqual(room.bountyAmount(5000), 500);
  room.destroy();

  // 6 คน: ชิปหมดแล้วบายอินเพิ่มได้ 2 ครั้ง, ครั้งที่ 3 ไม่ได้ → ตกรอบ
  room = new Room('TC', { tournament: true, buyIn: 100, sb: 10, bb: 20, turnTime: 0 }, T);
  ps = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => room.addPlayer(n));
  room.start(ps[0]);
  room.phase = 'showdown'; // จำลองหลังจบตา
  room.players[1].chips = 0;
  room.handNo = 1; room.tourAfterHand();
  assert(!room.players[1].out && room.players[1].bustHand === 1, 'ต้องรอบายอินเพิ่ม ไม่ตกรอบทันที');
  room.rebuy(room.players[1]);
  assert.strictEqual(room.players[1].chips, 1000);
  room.players[1].chips = 0; room.handNo = 2; room.tourAfterHand(); room.rebuy(room.players[1]);
  room.players[1].chips = 0; room.handNo = 3; room.tourAfterHand();
  assert(room.players[1].out, 'บายอินครบ 2 ครั้งแล้วชิปหมด ต้องตกรอบ');
  assert.strictEqual(room.players[1].place, 6);
  // หมดเวลา 5 ตาโดยไม่บายอิน = สละสิทธิ์
  room.players[2].chips = 0; room.handNo = 3; room.tourAfterHand();
  assert(!room.players[2].out);
  room.handNo = 8; room.tourForfeit(); // ตาถัดไปคือ 9 > 3+5
  assert(room.players[2].out, 'เกิน 5 ตาต้องสละสิทธิ์');
  room.destroy();
  // 4 คน: คนชิปหมดเป็นอันดับ 4 ยังบายอินได้ (ปิดเฉพาะตอนเหลือ 3 คนสุดท้าย)
  room = new Room('TD', { tournament: true, buyIn: 100, sb: 10, bb: 20, turnTime: 0 }, T);
  ps = ['A', 'B', 'C', 'D'].map((n) => room.addPlayer(n));
  room.start(ps[0]);
  room.phase = 'showdown';
  room.players[3].chips = 0; room.handNo = 1; room.tourAfterHand();
  assert(!room.players[3].out, 'อันดับ 4 ต้องยังไม่ตกรอบ');
  room.rebuy(room.players[3]);
  assert.strictEqual(room.players[3].chips, 1000);
  assert(room.viewFor(room.players[0].token).tourney.no >= 1 && room.viewFor(room.players[0].token).tourney.prizes.length === 3);
  room.players[3].chips = 0; room.handNo = 2; room.tourAfterHand();
  room.players[3].bustHand = 2; room.handNo = 9; room.tourForfeit();
  assert(room.players[3].out, 'ไม่บายอินในเวลาต้องตกรอบ');
  room.players[2].chips = 0; room.handNo = 10; room.tourAfterHand();
  assert(room.players[2].out, 'เหลือ 3 คนสุดท้ายแล้วชิปหมด ต้องตกรอบทันที');
  room.destroy();
  console.log('✓ tournament: blind levels, join lock, elimination, rebuys, prizes');
})();

// 4d) สับที่นั่ง, โชว์ไพ่, ผู้นำระหว่างลุ้น
(async () => {
  const T = { shuffleEvery: 2, shufRevealDelay: 0, shufPickTimeout: 1e9, nextHandDelay: 1e9, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 };
  const room = new Room('SH', { startChips: 1000, sb: 5, bb: 10, turnTime: 0 }, T);
  const ps = ['A', 'B', 'C', 'D'].map((n) => room.addPlayer(n));
  room.start(ps[0]);
  const foldHand = () => { for (let i = 0; i < 40 && room.phase === 'hand'; i++) { const p = room.players[room.toActIdx]; if (!p) break; const o = room.optionsFor(p); room.act(p, { type: o.canCheck ? 'check' : 'fold' }); } };
  foldHand();
  // โชว์ไพ่หลังจบตา
  const folded = room.players.find((p) => p.folded);
  room.showCards(folded);
  const v = room.viewFor(ps[0].token);
  assert(v.players.find((p) => p.id === folded.id).hole.every((c) => Number.isInteger(c)), 'ไพ่ที่โชว์ต้องเห็นทุกคน');
  assert.throws(() => room.showCards(folded), /ไม่มีไพ่/);
  room.startHand(); foldHand();
  room.startHand();                               // ตาที่ 2 จบแล้ว → ต้องเข้า phase สับที่นั่ง
  assert.strictEqual(room.phase, 'shuffle');
  const sv = room.viewFor(ps[1].token).shuffle;
  assert.strictEqual(sv.n, 4); assert.strictEqual(sv.vals, null, 'ห้ามเห็นค่าไพ่ก่อนเปิด');
  assert.throws(() => room.pickShuffle(ps[0], 9), /ไม่ถูกต้อง/);
  room.pickShuffle(ps[0], 0); assert.throws(() => room.pickShuffle(ps[1], 0), /เลือกแล้ว/);
  room.pickShuffle(ps[1], 1); room.pickShuffle(ps[2], 2);
  room.pickShuffle(ps[3], 3);                     // ครบแล้ว เปิดผลและย้ายที่นั่ง (delay 0)
  assert.strictEqual(room.phase, 'hand', 'หลังสับต้องเริ่มตาต่อ');
  const val = {}; // ดูผลจาก log: D=,SB=,BB=
  const log = room.log.find((l) => l.startsWith('🔀 ผลจั่วไพ่'));
  const nm = (k) => log.match(new RegExp(k + '=([^,]+)'))[1].trim();
  const D = room.players[room.dealerIdx].name, SB = room.players[room.sbIdx].name, BB = room.players[room.bbIdx].name;
  assert.deepStrictEqual([D, SB, BB], [nm('D'), nm('SB'), nm('BB')], 'ตำแหน่ง D/SB/BB ต้องตรงกับผลจั่ว');
  assert.strictEqual(room.players.filter((p) => p.inHand).length, 4);
  room.destroy();
  console.log('✓ shuffle seating, show cards');
})();

// 4e) ผู้นำระหว่างลุ้นไพ่
(() => {
  const room = new Room('LD', { startChips: 1000, sb: 5, bb: 10, turnTime: 0 }, { shuffleEvery: 0, nextHandDelay: 1e9, runoutDelay: 1e9, runoutFirstDelay: 1e9, resumeDelay: 0 });
  const ps = ['A', 'B'].map((n) => room.addPlayer(n));
  room.start(ps[0]);
  for (let i = 0; i < 6 && room.phase === 'hand' && !room.runout; i++) { const p = room.players[room.toActIdx]; if (!p) break; room.act(p, { type: 'allin' }); }
  assert(room.runout, 'ต้องเข้าโหมดลุ้นไพ่');
  const v = room.viewFor(ps[0].token);
  assert(Array.isArray(v.lead) && v.lead.length >= 1, 'ต้องมีผู้นำ');
  room.destroy();
  console.log('✓ runout leader');
})();

// 4.4) โชว์ไพ่อัตโนมัติหลังจบตา + ทัวร์นาเมนต์เหลือ 2 คนไม่สับที่นั่ง
(async () => {
  const room = new Room('T', { startChips: 1000, sb: 5, bb: 10 }, { shuffleEvery: 0, nextHandDelay: 1e9, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 });
  const ps = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  room.start(ps[0]);
  const f = room.players[room.toActIdx];
  room.setAutoShow(f, true);
  room.act(f, { type: 'fold' });
  for (let i = 0; i < 6 && room.phase === 'hand'; i++) { const q = room.players[room.toActIdx]; room.act(q, { type: 'fold' }); }
  assert.strictEqual(room.phase, 'showdown');
  assert(f.shown, 'ต้องโชว์ไพ่อัตโนมัติ');
  room.destroy();
  const tr = new Room('TH', { tournament: true, buyIn: 100, sb: 10, bb: 20, turnTime: 0 }, { shuffleEvery: 2, shufRevealDelay: 0, shufPickTimeout: 1e9, nextHandDelay: 1e9, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 });
  const tp = ['A', 'B', 'C'].map((n) => tr.addPlayer(n));
  tr.start(tp[0]);
  tp[2].out = true; tp[2].place = 3; tr.handNo = 2; tr.phase = 'showdown';
  tr.startHand();
  assert.strictEqual(tr.phase, 'hand', 'เหลือ 2 คนต้องไม่สับที่นั่ง');
  tr.destroy();
  console.log('✓ auto-show + heads-up no shuffle');
})();

// 4.5) เช็ค/โฟลด์ล่วงหน้า
(async () => {
  const room = new Room('T', { startChips: 1000, sb: 5, bb: 10 }, { shuffleEvery: 0, nextHandDelay: 1e9, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0, preDelay: 0 });
  const ps = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  room.start(ps[0]);
  const idle = ps.find((q) => q !== room.players[room.toActIdx] && q.inHand);
  room.setPre(idle, true);
  assert(idle.pre, 'ต้องตั้งล่วงหน้าได้');
  let guard = 0;
  while (room.phase === 'hand' && room.players[room.toActIdx] !== idle && guard++ < 10) { const q = room.players[room.toActIdx]; room.act(q, { type: q.bet < room.currentBet ? 'call' : 'check' }); }
  assert(room.phase !== 'hand' || idle.folded || idle.hasActed || room.players[room.toActIdx] !== idle, 'ล่วงหน้าต้องทำงานเมื่อถึงตา');
  room.destroy();
  console.log('✓ pre-action');
})();

// 5) ไทเมอร์: หมดเวลาแล้วเช็ค/โฟลด์อัตโนมัติ
(async () => {
  const room = new Room('T', { startChips: 1000, sb: 5, bb: 10, turnTime: 1 }, { shuffleEvery: 0, nextHandDelay: 1e9, runoutDelay: 0, runoutFirstDelay: 0, resumeDelay: 0 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => room.addPlayer(n));
  room.start(a);
  const first = room.players[room.toActIdx];
  await new Promise((r) => setTimeout(r, 1200));
  assert(first.folded, 'หมดเวลาแล้วต้องโฟลด์ (มีบิ๊กให้คอล)');
  room.destroy();
  console.log('✓ turn timer');
  await global.__offline;
  console.log('✓ offline auto-fold');
  console.log('ALL PASSED');
  process.exit(0);
})();
