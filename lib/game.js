'use strict';
// เอนจินเกม Texas Hold'em (ชิปสมมติ) — ไม่มีแพ็กเกจเสริม
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { evaluate } = require('./hands');

const MAX_PLAYERS = 9;
const STREETS = ['preflop', 'flop', 'turn', 'river'];

function newDeck() {
  const d = [...Array(52).keys()];
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

const fmt = (n) => n.toLocaleString('en-US');

class Room extends EventEmitter {
  constructor(code, settings = {}, timing = {}) {
    super();
    this.code = code;
    this.settings = {
      startChips: clampInt(settings.startChips, 100, 1000000, 1000),
      sb: clampInt(settings.sb, 1, 100000, 10),
      bb: clampInt(settings.bb, 2, 200000, 20),
      turnTime: clampInt(settings.turnTime, 0, 300, 30), // วินาที, 0 = ไม่จำกัด
    };
    if (this.settings.bb < this.settings.sb) this.settings.bb = this.settings.sb * 2;
    this.timing = { nextHandDelay: 8000, offlineDelay: 5000, ...timing };

    this.players = [];
    this.hostId = null;
    this.phase = 'lobby'; // lobby | hand | showdown | ended
    this.handNo = 0;
    this.dealerIdx = -1;
    this.deck = [];
    this.community = [];
    this.street = 'preflop';
    this.currentBet = 0;
    this.minRaise = this.settings.bb;
    this.toActIdx = -1;
    this.result = null;
    this.log = [];
    this.chat = [];
    this.chatSeq = 0;
    this.turnDeadline = null;
    this.nextHandAt = null;
    this.turnTimer = null;
    this.nextTimer = null;
    this.lastActive = Date.now();
    this.seq = 0;
  }

  // ---------- ผู้เล่น ----------
  playerByToken(token) { return this.players.find((p) => p.token === token) || null; }
  playerById(id) { return this.players.find((p) => p.id === id) || null; }

  addPlayer(name, token) {
    if (token) {
      const ex = this.playerByToken(token);
      if (ex && !ex.left) { ex.connected = true; this.touch(); return ex; }
    }
    if (this.players.filter((p) => !p.left).length >= MAX_PLAYERS) throw new UserError('ห้องเต็มแล้ว (สูงสุด 9 คน)');
    name = String(name || '').trim().slice(0, 14) || 'ผู้เล่น';
    const taken = new Set(this.players.filter((p) => !p.left).map((p) => p.name));
    let finalName = name;
    for (let i = 2; taken.has(finalName); i++) finalName = `${name} ${i}`;
    const p = {
      id: 'p' + crypto.randomBytes(3).toString('hex'),
      token: crypto.randomBytes(16).toString('hex'),
      name: finalName,
      chips: this.settings.startChips,
      bet: 0, total: 0,
      hole: [], inHand: false, folded: false, allIn: false, hasActed: false,
      connected: true, left: false, lastAction: '', rebuys: 0,
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.addLog(`${p.name} เข้าห้อง`);
    this.touch();
    return p;
  }

  setConnected(p, v) {
    if (p.connected === v) return;
    p.connected = v;
    // ถ้าหลุดตอนถึงตาตัวเอง ให้เริ่มนับถอยหลังสั้นๆ
    if (!v && this.phase === 'hand' && this.players[this.toActIdx] === p) this.scheduleTurn();
    this.touch();
  }

  leave(p) {
    if (p.left) return;
    p.left = true;
    p.connected = false;
    this.addLog(`${p.name} ออกจากห้อง`);
    if (this.phase === 'hand' && p.inHand && !p.folded) {
      if (this.players[this.toActIdx] === p) {
        this.applyFold(p);
        this.afterAction();
      } else {
        p.folded = true;
        p.lastAction = 'โฟลด์';
        if (this.contenders().length === 1) this.awardUncontested();
      }
    }
    if (this.hostId === p.id) {
      const next = this.players.find((q) => !q.left && q.connected) || this.players.find((q) => !q.left);
      this.hostId = next ? next.id : null;
    }
    if (this.phase !== 'hand') this.players = this.players.filter((q) => !q.left);
    this.touch();
  }

  kick(host, targetId) {
    if (host.id !== this.hostId) throw new UserError('เฉพาะเจ้าของห้องเท่านั้น');
    const t = this.playerById(targetId);
    if (!t || t === host) throw new UserError('ไม่พบผู้เล่น');
    t.kicked = true;
    this.leave(t);
  }

  rebuy(p) {
    if (p.chips > 0) throw new UserError('ยังมีชิปอยู่');
    if (this.phase === 'hand' && p.inHand) throw new UserError('รอจบตานี้ก่อน');
    p.chips = this.settings.startChips;
    p.rebuys++;
    this.addLog(`${p.name} ซื้อชิปเพิ่ม ${fmt(this.settings.startChips)}`);
    this.touch();
  }

  say(p, text) {
    text = String(text || '').trim().slice(0, 80);
    if (!text) return;
    this.chat.push({ id: ++this.chatSeq, from: p.id, name: p.name, text });
    if (this.chat.length > 40) this.chat.shift();
    this.touch();
  }

  // ---------- เริ่มเกม / เริ่มตา ----------
  start(p) {
    if (p.id !== this.hostId) throw new UserError('เฉพาะเจ้าของห้องที่เริ่มเกมได้');
    if (this.phase === 'hand' || this.phase === 'showdown') throw new UserError('เกมเริ่มไปแล้ว');
    const alive = this.players.filter((q) => !q.left);
    if (alive.length < 2) throw new UserError('ต้องมีผู้เล่นอย่างน้อย 2 คน');
    if (this.phase === 'ended') {
      for (const q of alive) { q.chips = this.settings.startChips; q.rebuys = 0; }
      this.handNo = 0;
      this.dealerIdx = -1;
      this.log = [];
    }
    this.startHand();
  }

  startHand() {
    clearTimeout(this.nextTimer);
    clearTimeout(this.turnTimer);
    this.nextHandAt = null;
    this.players = this.players.filter((q) => !q.left);
    const eligible = this.players.filter((q) => q.chips > 0);
    if (eligible.length < 2) {
      this.phase = 'ended';
      this.result = null;
      this.toActIdx = -1;
      this.turnDeadline = null;
      const w = eligible[0];
      this.addLog(w ? `🏆 ${w.name} ชนะทั้งเกม!` : 'เกมจบ');
      this.endedWinnerId = w ? w.id : null;
      this.touch();
      return;
    }

    this.phase = 'hand';
    this.handNo++;
    this.result = null;
    this.deck = newDeck();
    this.community = [];
    this.street = 'preflop';
    for (const q of this.players) {
      q.bet = 0; q.total = 0; q.hole = []; q.folded = false; q.allIn = false;
      q.hasActed = false; q.lastAction = ''; q.inHand = q.chips > 0;
    }

    const n = this.players.length;
    const nextIdx = (from, pred) => {
      for (let i = 1; i <= n; i++) {
        const idx = (from + i) % n;
        if (pred(this.players[idx])) return idx;
      }
      return -1;
    };
    this.dealerIdx = nextIdx(this.dealerIdx < 0 ? n - 1 : this.dealerIdx, (q) => q.inHand);
    const headsUp = eligible.length === 2;
    this.sbIdx = headsUp ? this.dealerIdx : nextIdx(this.dealerIdx, (q) => q.inHand);
    this.bbIdx = nextIdx(this.sbIdx, (q) => q.inHand);

    for (const q of this.players) if (q.inHand) q.hole = [this.deck.pop(), this.deck.pop()];

    const sbP = this.players[this.sbIdx];
    const bbP = this.players[this.bbIdx];
    this.postBlind(sbP, this.settings.sb);
    this.postBlind(bbP, this.settings.bb);
    sbP.lastAction = `SB ${fmt(sbP.bet)}`;
    bbP.lastAction = `BB ${fmt(bbP.bet)}`;
    this.currentBet = Math.max(sbP.bet, bbP.bet);
    this.minRaise = this.settings.bb;
    this.addLog(`— ตาที่ ${this.handNo} — ดีลเลอร์ ${this.players[this.dealerIdx].name}`);

    this.toActIdx = this.nextActor(this.bbIdx);
    // กรณีมีคนเดียว (หรือไม่มีใคร) ที่ยังเล่นต่อได้ ไม่ต้องเดิมพันต่อ
    this.afterBlinds();
    this.touch();
  }

  afterBlinds() {
    const actors = this.actors();
    const needAction = actors.some((q) => !(q.hasActed && q.bet === this.currentBet));
    const canBet = actors.length >= 2 || (actors.length === 1 && actors[0].bet < this.currentBet);
    if (!canBet || !needAction) { this.toActIdx = -1; this.endRound(); return; }
    this.scheduleTurn();
  }

  postBlind(p, amt) {
    const a = Math.min(amt, p.chips);
    p.chips -= a; p.bet += a; p.total += a;
    if (p.chips === 0) p.allIn = true;
  }

  // ---------- ตัวช่วย ----------
  contenders() { return this.players.filter((q) => q.inHand && !q.folded); }
  actors() { return this.players.filter((q) => q.inHand && !q.folded && !q.allIn); }
  nextActor(from) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      const q = this.players[idx];
      if (q.inHand && !q.folded && !q.allIn) return idx;
    }
    return -1;
  }
  totalPot() { return this.players.reduce((s, q) => s + q.total, 0); }

  optionsFor(p) {
    const toCall = Math.max(0, this.currentBet - p.bet);
    const maxTo = p.bet + p.chips;
    const minTo = Math.min(this.currentBet + this.minRaise, maxTo);
    return {
      toCall: Math.min(toCall, p.chips),
      canCheck: toCall === 0,
      canRaise: p.chips > toCall,
      minRaiseTo: minTo,
      maxRaiseTo: maxTo,
      isBet: this.currentBet === 0,
    };
  }

  // ---------- การกระทำ ----------
  act(p, action) {
    if (this.phase !== 'hand') throw new UserError('ตอนนี้ยังไม่ใช่ช่วงเดิมพัน');
    if (this.players[this.toActIdx] !== p) throw new UserError('ยังไม่ถึงตาคุณ');
    const o = this.optionsFor(p);
    const type = action && action.type;

    if (type === 'fold') {
      this.applyFold(p);
    } else if (type === 'check') {
      if (!o.canCheck) throw new UserError('เช็คไม่ได้ ต้องคอลหรือโฟลด์');
      p.lastAction = 'เช็ค';
      p.hasActed = true;
      this.addLog(`${p.name} เช็ค`);
    } else if (type === 'call') {
      if (o.canCheck) throw new UserError('ไม่มีอะไรให้คอล');
      this.putIn(p, o.toCall);
      p.hasActed = true;
      p.lastAction = p.allIn ? 'ออลอิน' : `คอล ${fmt(o.toCall)}`;
      this.addLog(`${p.name} ${p.allIn ? 'ออลอิน' : 'คอล'} ${fmt(o.toCall)}`);
    } else if (type === 'raise' || type === 'allin') {
      if (!o.canRaise && type === 'raise') throw new UserError('ชิปไม่พอเรส');
      let to = type === 'allin' ? o.maxRaiseTo : Math.floor(Number(action.amount));
      if (!Number.isFinite(to)) throw new UserError('จำนวนไม่ถูกต้อง');
      if (to > o.maxRaiseTo) to = o.maxRaiseTo;
      if (to < o.minRaiseTo && to !== o.maxRaiseTo) throw new UserError(`ต้องเรสอย่างน้อยเป็น ${fmt(o.minRaiseTo)}`);
      if (to <= this.currentBet) {
        // ออลอินแต่ได้แค่คอล
        this.putIn(p, o.toCall);
        p.hasActed = true;
        p.lastAction = p.allIn ? 'ออลอิน' : `คอล ${fmt(o.toCall)}`;
        this.addLog(`${p.name} ${p.allIn ? 'ออลอิน' : 'คอล'} ${fmt(o.toCall)}`);
      } else {
        const wasBet = this.currentBet === 0;
        const raiseSize = to - this.currentBet;
        this.putIn(p, to - p.bet);
        if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
        this.currentBet = to;
        for (const q of this.players) if (q !== p) q.hasActed = false; // เปิดให้ทุกคนตอบใหม่
        p.hasActed = true;
        p.lastAction = p.allIn ? `ออลอิน ${fmt(to)}` : `${wasBet ? 'เดิมพัน' : 'เรสเป็น'} ${fmt(to)}`;
        this.addLog(`${p.name} ${p.allIn ? 'ออลอิน' : wasBet ? 'เดิมพัน' : 'เรสเป็น'} ${fmt(to)}`);
      }
    } else {
      throw new UserError('การกระทำไม่ถูกต้อง');
    }
    this.afterAction();
  }

  putIn(p, amt) {
    amt = Math.min(amt, p.chips);
    p.chips -= amt; p.bet += amt; p.total += amt;
    if (p.chips === 0) p.allIn = true;
  }

  applyFold(p) {
    p.folded = true;
    p.hasActed = true;
    p.lastAction = 'โฟลด์';
    this.addLog(`${p.name} โฟลด์`);
  }

  afterAction() {
    if (this.phase !== 'hand') return;
    if (this.contenders().length === 1) { this.awardUncontested(); return; }
    const pending = (q) => !(q.hasActed && q.bet === this.currentBet);
    const n = this.players.length;
    let next = -1;
    for (let i = 1; i <= n; i++) {
      const idx = (this.toActIdx + i) % n;
      const q = this.players[idx];
      if (q.inHand && !q.folded && !q.allIn && pending(q)) { next = idx; break; }
    }
    if (next === -1) { this.endRound(); return; }
    this.toActIdx = next;
    this.scheduleTurn();
    this.touch();
  }

  endRound() {
    clearTimeout(this.turnTimer);
    this.turnDeadline = null;
    for (;;) {
      if (this.street === 'river') { this.showdown(); return; }
      this.street = STREETS[STREETS.indexOf(this.street) + 1];
      this.deck.pop(); // เผาไพ่
      const k = this.street === 'flop' ? 3 : 1;
      for (let i = 0; i < k; i++) this.community.push(this.deck.pop());
      for (const q of this.players) { q.bet = 0; q.hasActed = false; if (!q.folded && !q.allIn) q.lastAction = ''; }
      this.currentBet = 0;
      this.minRaise = this.settings.bb;
      const label = { flop: 'ฟลอป', turn: 'เทิร์น', river: 'ริเวอร์' }[this.street];
      this.addLog(`${label}: ${this.community.map(cardText).join(' ')}`);
      if (this.actors().length >= 2) {
        this.toActIdx = this.nextActor(this.dealerIdx);
        this.scheduleTurn();
        this.touch();
        return;
      }
      // ไม่มีใครเดิมพันต่อได้แล้ว → เปิดไพ่ที่เหลือจนจบ
    }
  }

  // ---------- จบตา ----------
  awardUncontested() {
    clearTimeout(this.turnTimer);
    this.turnDeadline = null;
    const w = this.contenders()[0];
    const pot = this.totalPot();
    w.chips += pot;
    this.addLog(`${w.name} ชนะ ${fmt(pot)} (ทุกคนโฟลด์)`);
    this.finishHand({
      showdown: false,
      pots: [{ amount: pot, winners: [w.id], eligible: [w.id] }],
      winners: [{ id: w.id, won: pot, handName: null }],
      hands: {},
    });
  }

  showdown() {
    clearTimeout(this.turnTimer);
    this.turnDeadline = null;
    const all = this.players.filter((q) => q.inHand);
    const cont = this.contenders();

    // คืนเงินส่วนที่ไม่มีใครคอล
    const sorted = [...all].sort((a, b) => b.total - a.total);
    if (sorted.length >= 2 && sorted[0].total > sorted[1].total) {
      const diff = sorted[0].total - sorted[1].total;
      sorted[0].chips += diff; sorted[0].total -= diff;
      this.addLog(`คืน ${fmt(diff)} ให้ ${sorted[0].name} (ไม่มีคนคอล)`);
    }

    const hands = {};
    for (const q of cont) {
      const ev = evaluate([...q.hole, ...this.community]);
      hands[q.id] = { hole: q.hole, name: ev.name, best: ev.best, score: ev.score };
    }

    const levels = [...new Set(cont.map((q) => q.total).filter((t) => t > 0))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const L of levels) {
      let amount = 0;
      for (const q of all) amount += Math.max(0, Math.min(q.total, L) - prev);
      const eligible = cont.filter((q) => q.total >= L);
      if (amount > 0) pots.push({ amount, eligible: eligible.map((q) => q.id), winners: [] });
      prev = L;
    }
    // เงินส่วนเกินของคนที่โฟลด์ (ถ้ามี) ใส่เข้าพ็อตสุดท้าย
    const top = levels[levels.length - 1] || 0;
    const extra = all.reduce((s, q) => s + Math.max(0, q.total - Math.max(top, 0)), 0);
    if (extra > 0 && pots.length) pots[pots.length - 1].amount += extra;

    const won = {};
    const n = this.players.length;
    for (const pot of pots) {
      let bestScore = -1;
      for (const id of pot.eligible) bestScore = Math.max(bestScore, hands[id].score);
      const ws = pot.eligible.filter((id) => hands[id].score === bestScore);
      // เรียงผู้ชนะจากซ้ายมือดีลเลอร์ เพื่อแจกเศษชิป
      ws.sort((a, b) => seatDist(this.players, this.dealerIdx, a, n) - seatDist(this.players, this.dealerIdx, b, n));
      const share = Math.floor(pot.amount / ws.length);
      let rem = pot.amount - share * ws.length;
      for (const id of ws) {
        const amt = share + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
        won[id] = (won[id] || 0) + amt;
        this.playerById(id).chips += amt;
      }
      pot.winners = ws;
    }
    const winners = Object.entries(won).map(([id, w]) => ({ id, won: w, handName: hands[id].name }));
    for (const w of winners) this.addLog(`${this.playerById(w.id).name} ชนะ ${fmt(w.won)} ด้วย ${w.handName}`);
    this.finishHand({ showdown: true, pots, winners, hands });
  }

  finishHand(result) {
    this.result = result;
    this.phase = 'showdown';
    this.toActIdx = -1;
    this.turnDeadline = null;
    this.nextHandAt = Date.now() + this.timing.nextHandDelay;
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => this.startHand(), this.timing.nextHandDelay);
    this.touch();
  }

  // ---------- ไทเมอร์ตาเล่น ----------
  scheduleTurn() {
    clearTimeout(this.turnTimer);
    this.turnDeadline = null;
    const p = this.players[this.toActIdx];
    if (this.phase !== 'hand' || !p) return;
    let ms = null;
    if (!p.connected) ms = this.settings.turnTime > 0
      ? Math.min(this.settings.turnTime * 1000, this.timing.offlineDelay)
      : this.timing.offlineDelay;
    else if (this.settings.turnTime > 0) ms = this.settings.turnTime * 1000;
    if (ms == null) return;
    this.turnDeadline = Date.now() + ms;
    this.turnTimer = setTimeout(() => this.autoAct(p), ms);
  }

  autoAct(p) {
    if (this.phase !== 'hand' || this.players[this.toActIdx] !== p) return;
    const o = this.optionsFor(p);
    try { this.act(p, { type: o.canCheck ? 'check' : 'fold' }); } catch (e) { /* ignore */ }
  }

  // ---------- มุมมองของผู้เล่นแต่ละคน ----------
  viewFor(token) {
    const me = this.playerByToken(token);
    const reveal = this.phase === 'showdown' && this.result && this.result.showdown;
    const cur = this.players[this.toActIdx];
    const players = this.players.map((q, i) => {
      const shown = q === me || (reveal && q.inHand && !q.folded);
      return {
        id: q.id, name: q.name, chips: q.chips, bet: q.bet, total: q.total,
        folded: q.folded, allIn: q.allIn, inHand: q.inHand, connected: q.connected, left: q.left,
        isDealer: this.phase !== 'lobby' && i === this.dealerIdx,
        isHost: q.id === this.hostId,
        lastAction: q.lastAction,
        rebuys: q.rebuys,
        hole: shown ? q.hole : (q.inHand && !q.folded && this.phase !== 'lobby' ? [null, null] : []),
      };
    });
    const view = {
      v: ++this.seq,
      code: this.code,
      settings: this.settings,
      phase: this.phase,
      handNo: this.handNo,
      street: this.street,
      community: this.community,
      pot: this.totalPot(),
      currentBet: this.currentBet,
      toAct: cur ? cur.id : null,
      turnDeadline: this.turnDeadline,
      nextHandAt: this.nextHandAt,
      hostId: this.hostId,
      endedWinnerId: this.phase === 'ended' ? this.endedWinnerId : null,
      players,
      you: me ? { id: me.id, handName: this.myHandName(me) } : null,
      result: this.phase === 'showdown' ? this.publicResult() : null,
      log: this.log.slice(-40),
      chat: this.chat.slice(-20),
      serverNow: Date.now(),
    };
    if (me && cur === me && this.phase === 'hand') view.options = this.optionsFor(me);
    return view;
  }

  myHandName(me) {
    if (this.phase === 'lobby' || !me.inHand || me.folded || this.community.length < 3) return null;
    return evaluate([...me.hole, ...this.community]).name;
  }

  publicResult() {
    const r = this.result;
    if (!r) return null;
    const hands = {};
    if (r.showdown) for (const [id, h] of Object.entries(r.hands)) hands[id] = { name: h.name, best: h.best };
    return { showdown: r.showdown, pots: r.pots, winners: r.winners, hands };
  }

  addLog(text) {
    this.log.push(text);
    if (this.log.length > 120) this.log.shift();
  }

  touch() {
    this.lastActive = Date.now();
    this.emit('change');
  }

  destroy() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.nextTimer);
    this.removeAllListeners();
  }
}

function seatDist(players, dealerIdx, id, n) {
  const i = players.findIndex((q) => q.id === id);
  return (i - dealerIdx + n) % n || n;
}

function clampInt(v, lo, hi, dflt) {
  v = Math.floor(Number(v));
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
}

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = '23456789TJQKA';
function cardText(c) { return RANKS[c % 13] .replace('T', '10') + SUITS[Math.floor(c / 13)]; }

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

module.exports = { Room, UserError, MAX_PLAYERS };
