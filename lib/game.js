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

let tourSeq = 0;
class Room extends EventEmitter {
  constructor(code, settings = {}, timing = {}) {
    super();
    this.code = code;
    this.settings = {
      startChips: clampInt(settings.startChips, 100, 1000000, 1000),
      sb: clampInt(settings.sb, 1, 100000, 10),
      bb: clampInt(settings.bb, 2, 200000, 20),
      turnTime: clampInt(settings.turnTime, 0, 300, 30), // วินาที, 0 = ไม่จำกัด
      private: !!settings.private, // true = ไม่แสดงในรายการห้อง
    };
    if (this.settings.bb < this.settings.sb) this.settings.bb = this.settings.sb * 2;
    // โหมดทัวร์นาเมนต์: บายอิน ฿ → ชิป (฿1 = 10 ชิป), บลายด์เพิ่ม 2 เท่าทุก N ตา, บายอินเพิ่มได้ 2 ครั้ง ภายใน 5 ตาหลังชิปหมด
    this.tour = null;
    if (settings.tournament) {
      const buyIn = clampInt(settings.buyIn, 10, 100000, 100);
      const every = clampInt(settings.levelHands, 2, 50, 10);
      this.settings.tournament = true;
      this.settings.buyIn = buyIn;
      this.settings.levelHands = every;
      this.settings.startChips = buyIn * 10;
      this.settings.sb = clampInt(settings.sb, 1, 100000, 10);
      this.settings.bb = clampInt(settings.bb, 2, 200000, this.settings.sb * 2);
      if (this.settings.bb < this.settings.sb) this.settings.bb = this.settings.sb * 2;
      this.tour = {
        started: false, startedAt: null, endedAt: null, over: false,
        baseSB: this.settings.sb, baseBB: this.settings.bb, every,
        maxRebuys: 2, window: 5, finishers: [], result: null, initial: 0, no: ++tourSeq,
      };
    }
    this.timing = {
      nextHandDelay: 10000,   // พักหลังจบตา ก่อนเริ่มตาถัดไป
      shuffleEvery: 15,       // สับที่นั่งทุกกี่ตา (0 = ปิด)
      shufPickTimeout: 20000, // เวลาให้จั่วไพ่เลือกที่นั่ง
      shufRevealDelay: 6000,  // โชว์ผลจั่วก่อนย้ายที่นั่ง
      tourEndDelay: 8000,     // ทัวร์นาเมนต์: จบตาสุดท้ายแล้วรอก่อนขึ้นหน้าต่างสรุปผล
      offlineDelay: 5000,
      preDelay: 450,          // เช็ค/โฟลด์ล่วงหน้า: หน่วงก่อนทำให้เองเล็กน้อย
      runoutFirstDelay: 2500, // ออลอิน: พักให้เห็นไพ่ในมือก่อนเปิดไพ่กลาง
      runoutDelay: 3500,      // ออลอิน: เว้นจังหวะระหว่างฟลอป/เทิร์น/ริเวอร์/เปิดไพ่
      resumeDelay: 3000,      // รอบายอิน: มีคนบายอินจนครบ 2 คนแล้ว เริ่มตาใหม่ภายในกี่ ms
      ...timing,
    };

    this.players = [];
    this.hostId = null;
    this.phase = 'lobby'; // lobby | hand | showdown | waiting (เหลือคนมีชิปคนเดียว รอบายอิน)
    this.runout = false;  // true = ไม่มีใครเดิมพันต่อได้แล้ว กำลังเปิดไพ่กลางทีละใบ
    this.runTimer = null;
    this.soleId = null;   // คนที่ครองชิปทั้งโต๊ะ (ตอน waiting)
    this.handNo = 0;
    this.history = []; this.histNames = {};
    this.shuf = null; this.shufDoneFor = -1;
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
    this.spectators = []; // ผู้ชม: {id, token, name, connected, dropTimer}
  }

  // ---------- ผู้เล่น ----------
  playerByToken(token) { return this.players.find((p) => p.token === token) || null; }
  playerById(id) { return this.players.find((p) => p.id === id) || null; }

  addPlayer(name, token) {
    if (token) {
      const ex = this.playerByToken(token);
      if (ex && !ex.left) { ex.connected = true; this.touch(); return ex; }
    }
    if (this.tour && this.tour.started && !this.lateOpen()) throw new UserError('ทัวร์นาเมนต์เริ่มไปแล้วและบลายด์ขึ้นแล้ว เข้าร่วมไม่ได้ (เข้าดูอย่างเดียวได้)');
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
      connected: true, left: false, lastAction: '', rebuys: 0, kills: 0,
      out: false, place: null, bustHand: null, handStartChips: 0, shown: false, pre: null, autoShow: false,
      voice: null, muted: false, // ห้องเสียง: null | 'talk' | 'listen'
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.addLog(this.tour && this.tour.started ? `${p.name} สมัครเข้าร่วมทัวร์นาเมนต์ (ก่อนบลายด์ขึ้น) — เริ่มเล่นตาถัดไป` : `${p.name} เข้าห้อง`);
    this.maybeResume();
    this.touch();
    return p;
  }

  setConnected(p, v) {
    if (p.connected === v) return;
    p.connected = v;
    if (!v) { p.voice = null; p.muted = false; } // หลุดการเชื่อมต่อ = หลุดห้องเสียงด้วย (กลับมาแล้วฝั่งหน้าเว็บจะเข้าใหม่เอง)
    // ถ้าหลุดตอนถึงตาตัวเอง ให้เริ่มนับถอยหลังสั้นๆ
    if (!v && this.phase === 'hand' && this.players[this.toActIdx] === p) this.scheduleTurn();
    this.touch();
  }

  leave(p) {
    if (p.left) return;
    if (this.tour && this.tour.started && !this.tour.over && !p.out) this.tourEliminate([p], 'ออกจากห้อง');
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
    if (this.tour && this.tour.started && this.phase !== 'hand') this.tourCheckWinner();
    if (this.phase === 'shuffle' && this.shuf && !this.shuf.revealed) {
      const el = this.players.filter((q) => q.chips > 0 && !q.out && !q.left);
      if (el.length >= 2) this.beginShuffle(el); else { this.shuf = null; this.shufDoneFor = this.handNo; this.startHand(); }
    }
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
    if (this.tour) {
      const t = this.tour;
      if (p.out || t.over) throw new UserError('คุณตกรอบแล้ว');
      if (p.rebuys >= t.maxRebuys) throw new UserError(`ใช้สิทธิ์บายอินเพิ่มครบ ${t.maxRebuys} ครั้งแล้ว`);
      if (!this.rebuyOpen()) throw new UserError('ปิดรับบายอินเพิ่มแล้ว (เหลือผู้เล่น 3 คนสุดท้าย)');
      if (p.bustHand != null && this.handNo > p.bustHand + t.window) throw new UserError('หมดเวลาบายอินเพิ่มแล้ว');
      p.bustHand = null;
    }
    p.chips = this.settings.startChips;
    p.rebuys++;
    this.addLog(this.tour ? `${p.name} บายอินเพิ่ม ${fmt(this.settings.buyIn)}฿ (ครั้งที่ ${p.rebuys}/${this.tour.maxRebuys})` : `${p.name} ซื้อชิปเพิ่ม ${fmt(this.settings.startChips)}`);
    this.maybeResume();
    this.touch();
  }

  say(p, text) {
    text = String(text || '').trim().slice(0, 80);
    if (!text) return;
    this.chat.push({ id: ++this.chatSeq, from: p.id, name: p.name, text });
    if (this.chat.length > 40) this.chat.shift();
    this.touch();
  }

  // ---------- ผู้ชม (ดูอย่างเดียว) ----------
  spectatorByToken(token) { return this.spectators.find((s) => s.token === token) || null; }

  addSpectator(name) {
    if (this.spectators.length >= 30) throw new UserError('มีผู้ชมเต็มแล้ว');
    name = String(name || '').trim().slice(0, 14) || 'ผู้ชม';
    const s = {
      id: 's' + crypto.randomBytes(3).toString('hex'),
      token: crypto.randomBytes(16).toString('hex'),
      name, connected: true, dropTimer: null, voice: null, muted: false,
    };
    this.spectators.push(s);
    this.touch();
    return s;
  }

  removeSpectator(s) {
    clearTimeout(s.dropTimer);
    this.spectators = this.spectators.filter((x) => x !== s);
    this.touch();
  }

  setSpecConnected(s, v) {
    clearTimeout(s.dropTimer);
    s.connected = v;
    if (!v) { s.voice = null; s.muted = false; }
    // หลุดเกิน 1 นาที (เช่นปิดแอพ) ถึงจะเอาออกจากรายชื่อผู้ชม
    if (!v) s.dropTimer = setTimeout(() => { if (!s.connected) this.removeSpectator(s); }, 60000);
    this.touch();
  }

  // ---------- ห้องเสียง (เสียงไหลตรงระหว่างเครื่องด้วย WebRTC เซิร์ฟเวอร์รู้แค่ว่าใครอยู่ในห้องเสียง) ----------
  memberById(id) {
    return this.players.find((p) => p.id === id && !p.left) || this.spectators.find((s) => s.id === id) || null;
  }

  setVoice(m, mode, muted) {
    if (!['talk', 'listen', 'off'].includes(mode)) throw new UserError('โหมดเสียงไม่ถูกต้อง');
    m.voice = mode === 'off' ? null : mode;
    m.muted = mode === 'talk' ? !!muted : false;
    this.touch();
  }

  // ข้อมูลย่อสำหรับหน้า "รายการห้อง" (ไม่มีข้อมูลลับ ไม่มีไพ่)
  summary() {
    const alive = this.players.filter((p) => !p.left);
    return {
      code: this.code,
      count: alive.length,
      online: alive.filter((p) => p.connected).length,
      full: alive.length >= MAX_PLAYERS,
      players: alive.map((p) => ({ name: p.name, online: p.connected })),
      spectators: this.spectators.filter((s) => s.connected).length,
      phase: this.phase,
      handNo: this.handNo,
      settings: { startChips: this.settings.startChips, sb: this.settings.sb, bb: this.settings.bb },
      tournament: this.tour ? { started: this.tour.started, buyIn: this.settings.buyIn, over: this.tour.over, lateOpen: this.lateOpen() } : null,
    };
  }

  // ---------- เริ่มเกม / เริ่มตา ----------
  start(p) {
    if (p.id !== this.hostId) throw new UserError('เฉพาะเจ้าของห้องที่เริ่มเกมได้');
    if (this.phase !== 'lobby') throw new UserError('เกมเริ่มไปแล้ว');
    const alive = this.players.filter((q) => !q.left);
    if (alive.length < 2) throw new UserError('ต้องมีผู้เล่นอย่างน้อย 2 คน');
    if (this.tour) { this.tour.started = true; this.tour.startedAt = Date.now(); this.tour.initial = alive.length; this.addLog(`🏆 ทัวร์นาเมนต์เริ่ม! บายอิน ${fmt(this.settings.buyIn)}฿ = ${fmt(this.settings.startChips)} ชิป`); }
    this.recordHistory();
    this.startHand();
  }

  // ตอนรอบายอิน: พอมีผู้เล่นมีชิปครบ 2 คน เกมเดินต่อเอง ไม่ต้องกดเริ่มใหม่ และไม่รีเซ็ตชิปใคร
  maybeResume() {
    if (this.phase !== 'waiting') return;
    if (this.players.filter((q) => !q.left && q.chips > 0).length < 2) return;
    if (this.nextHandAt) return; // กำลังนับถอยหลังอยู่แล้ว
    const d = this.timing.resumeDelay;
    if (d <= 0) { this.startHand(); return; }
    this.nextHandAt = Date.now() + d;
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => this.startHand(), d);
  }

  startHand() {
    clearTimeout(this.nextTimer);
    clearTimeout(this.turnTimer);
    clearTimeout(this.runTimer);
    this.runout = false;
    this.nextHandAt = null;
    this.players = this.players.filter((q) => !q.left);
    if (this.tour) {
      if (this.tour.over) return;
      this.tourForfeit();
      if (this.tourCheckWinner()) return;
    }
    const eligible = this.players.filter((q) => q.chips > 0 && !q.out);
    const every = this.timing.shuffleEvery;
    if (every > 0 && this.handNo > 0 && this.handNo % every === 0 && this.shufDoneFor !== this.handNo && eligible.length >= 2 && !(this.tour && this.tourAlive().length <= 2)) {
      this.beginShuffle(eligible);
      return;
    }
    if (eligible.length < 2) {
      // เหลือคนมีชิปคนเดียว: หยุดรอให้มีคนบายอิน (ไม่มีการเริ่มเกมใหม่/รีเซ็ตชิป)
      this.phase = 'waiting';
      this.result = null;
      this.community = [];
      this.currentBet = 0;
      this.toActIdx = -1;
      this.turnDeadline = null;
      for (const q of this.players) {
        q.bet = 0; q.total = 0; q.hole = []; q.folded = false; q.allIn = false;
        q.inHand = false; q.hasActed = false; q.lastAction = '';
      }
      const w = eligible[0];
      this.soleId = w ? w.id : null;
      this.addLog(w ? `🏆 ${w.name} ครองชิปทั้งโต๊ะ — รอผู้เล่นบายอิน` : 'รอผู้เล่นบายอิน');
      this.touch();
      return;
    }

    this.phase = 'hand';
    this.handNo++;
    if (this.tour) {
      const m = 2 ** Math.floor((this.handNo - 1) / this.tour.every);
      const sb = this.tour.baseSB * m, bb = this.tour.baseBB * m;
      if (sb !== this.settings.sb) this.addLog(`📈 บลายด์เพิ่มเป็น ${fmt(sb)}/${fmt(bb)}`);
      this.settings.sb = sb; this.settings.bb = bb;
    }
    this.result = null;
    this.deck = newDeck();
    this.community = [];
    this.street = 'preflop';
    for (const q of this.players) {
      q.bet = 0; q.total = 0; q.hole = []; q.folded = false; q.allIn = false;
      q.hasActed = false; q.lastAction = ''; q.inHand = q.chips > 0 && !q.out; q.handStartChips = q.chips; q.shown = false; q.pre = null; q.autoShow = false;
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
    if (this.street === 'river') { this.showdown(); return; }

    // ไม่มีใครเดิมพันต่อได้แล้ว (ออลอิน): เปิดไพ่ในมือให้เห็นก่อน แล้วเปิดไพ่กลางทีละใบแบบเว้นจังหวะให้ลุ้น
    if (!this.runout && this.actors().length < 2) {
      this.runout = true;
      this.toActIdx = -1;
      this.markReveal(this.timing.runoutFirstDelay);
      this.touch();
      this.later(this.timing.runoutFirstDelay, () => this.endRound());
      return;
    }

    this.dealStreet();
    this.revealAt = null;
    if (this.runout) {
      // ฟลอป→เทิร์น และ เทิร์น→ริเวอร์ เว้นนานขึ้นให้ลุ้น (คูณจากค่าพื้นฐาน)
      const mul = this.street === 'flop' ? 1.8 : this.street === 'turn' ? 2.4 : 1;
      this.markReveal(this.timing.runoutDelay * mul);
      this.touch();
      this.later(this.timing.runoutDelay * mul, () => this.endRound());
      return;
    }
    this.toActIdx = this.nextActor(this.dealerIdx);
    this.scheduleTurn();
    this.touch();
  }

  // ออลอิน: บอกฝั่งหน้าเว็บว่ากำลังรอเปิดไพ่ใบถัดไปอีกกี่ ms (ใช้ทำหลอดโหลด)
  markReveal(ms) {
    const nx = STREETS[STREETS.indexOf(this.street) + 1];
    if (ms > 0 && nx && this.street !== 'river') { this.revealAt = Date.now() + ms; this.revealMs = ms; this.revealNext = nx; } else this.revealAt = null;
  }

  dealStreet() {
    this.street = STREETS[STREETS.indexOf(this.street) + 1];
    this.deck.pop(); // เผาไพ่
    const k = this.street === 'flop' ? 3 : 1;
    for (let i = 0; i < k; i++) this.community.push(this.deck.pop());
    for (const q of this.players) { q.bet = 0; q.hasActed = false; q.pre = null; if (!q.folded && !q.allIn) q.lastAction = ''; }
    this.currentBet = 0;
    this.minRaise = this.settings.bb;
    const label = { flop: 'ฟลอป', turn: 'เทิร์น', river: 'ริเวอร์' }[this.street];
    this.addLog(`${label}: ${this.community.map(cardText).join(' ')}`);
  }

  // หน่วงเวลาแล้วทำต่อ (ms <= 0 = ทำทันที ใช้ในเทสต์)
  later(ms, fn) {
    clearTimeout(this.runTimer);
    if (ms <= 0) fn(); else this.runTimer = setTimeout(fn, ms);
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
    clearTimeout(this.runTimer);
    this.runout = false;
    this.result = result;
    this.recordKills(result);
    if (this.tour) this.tourAfterHand();
    this.recordHistory();
    this.phase = 'showdown';
    // ผู้เล่นที่ตั้งไว้ว่าจะโชว์ไพ่หลังจบตา (เช่น โฟลด์ไปแล้ว) เปิดไพ่ให้อัตโนมัติ
    for (const q of this.players) {
      if (q.autoShow && !q.shown && q.hole.length) { q.shown = true; this.addLog(`${q.name} โชว์ไพ่ ${q.hole.map(cardText).join(' ')}`); }
    }
    this.toActIdx = -1;
    this.turnDeadline = null;
    clearTimeout(this.nextTimer);
    if (this.tour && this.tour.over) {
      this.nextHandAt = null;
      this.nextTimer = setTimeout(() => this.endTournament(), this.timing.tourEndDelay);
    } else {
      this.nextHandAt = Date.now() + this.timing.nextHandDelay;
      this.nextTimer = setTimeout(() => this.startHand(), this.timing.nextHandDelay);
    }
    this.touch();
  }

  // ---------- สับที่นั่งทุก 15 ตา: ทุกคนจั่วไพ่ A,2,3.. คนละใบ ใบสูงสุด = BB, สูงรองลงมา = SB, ใบ A = D ----------
  beginShuffle(list) {
    clearTimeout(this.nextTimer); clearTimeout(this.turnTimer); clearTimeout(this.runTimer);
    this.phase = 'shuffle';
    this.result = null; this.community = []; this.currentBet = 0; this.toActIdx = -1;
    this.turnDeadline = null; this.nextHandAt = null; this.runout = false; this.soleId = null;
    for (const q of this.players) { q.bet = 0; q.total = 0; q.hole = []; q.folded = false; q.allIn = false; q.inHand = false; q.hasActed = false; q.lastAction = ''; }
    const n = list.length;
    const vals = [...Array(n).keys()].map((i) => i + 1);
    for (let i = n - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [vals[i], vals[j]] = [vals[j], vals[i]]; }
    this.shuf = { n, vals, ids: list.map((q) => q.id), picks: {}, revealed: false, order: null, deadline: Date.now() + this.timing.shufPickTimeout, until: null };
    this.addLog(`🔀 ครบ ${this.handNo} ตา — จั่วไพ่สับที่นั่งใหม่`);
    for (const q of list) if (!q.connected) this.autoPick(q);
    this.nextTimer = setTimeout(() => this.finishShuffle(), this.timing.shufPickTimeout);
    this.touch();
    if (this.shuf.ids.every((id) => id in this.shuf.picks)) this.finishShuffle();
  }

  autoPick(q) {
    const sh = this.shuf;
    const free = [...Array(sh.n).keys()].filter((i) => !Object.values(sh.picks).includes(i));
    if (free.length) sh.picks[q.id] = free[crypto.randomInt(free.length)];
  }

  pickShuffle(p, slot) {
    const sh = this.shuf;
    if (this.phase !== 'shuffle' || !sh || sh.revealed) throw new UserError('ตอนนี้จั่วไพ่ไม่ได้');
    if (!sh.ids.includes(p.id)) throw new UserError('คุณไม่ได้อยู่ในรอบสับที่นั่ง');
    if (p.id in sh.picks) throw new UserError('คุณเลือกไพ่แล้ว');
    slot = Math.floor(Number(slot));
    if (!(slot >= 0 && slot < sh.n)) throw new UserError('เลือกไพ่ไม่ถูกต้อง');
    if (Object.values(sh.picks).includes(slot)) throw new UserError('ใบนี้มีคนเลือกแล้ว');
    sh.picks[p.id] = slot;
    this.touch();
    if (sh.ids.every((id) => id in sh.picks)) this.finishShuffle();
  }

  finishShuffle() {
    const sh = this.shuf;
    if (this.phase !== 'shuffle' || !sh || sh.revealed) return;
    clearTimeout(this.nextTimer);
    for (const id of sh.ids) if (!(id in sh.picks)) this.autoPick(this.playerById(id));
    const val = {}; for (const id of sh.ids) val[id] = sh.vals[sh.picks[id]];
    const asc = [...sh.ids].sort((a, b) => val[a] - val[b]);   // asc[0] = ไพ่ A
    const n = asc.length;
    // ตามเข็มนาฬิกา: D(A), SB(สูงรองสุด), BB(สูงสุด), แล้วที่เหลือไล่จากสูงลงต่ำ
    const order = n === 2 ? [asc[0], asc[1]] : [asc[0], asc[n - 2], asc[n - 1], ...asc.slice(1, n - 2).reverse()];
    sh.revealed = true; sh.order = order; sh.val = val;
    sh.until = Date.now() + this.timing.shufRevealDelay;
    const nm = (id) => this.playerById(id).name;
    this.addLog(`🔀 ผลจั่วไพ่: D=${nm(order[0])}, SB=${nm(order[n === 2 ? 0 : 1])}, BB=${nm(order[n === 2 ? 1 : 2])}`);
    this.touch();
    this.nextTimer = setTimeout(() => this.applyShuffle(), this.timing.shufRevealDelay);
    if (this.timing.shufRevealDelay <= 0) { clearTimeout(this.nextTimer); this.applyShuffle(); }
  }

  applyShuffle() {
    const sh = this.shuf;
    if (!sh || !sh.revealed) return;
    const seated = sh.order.map((id) => this.playerById(id)).filter(Boolean);
    const rest = this.players.filter((q) => !seated.includes(q));
    this.players = [...seated, ...rest];
    this.dealerIdx = this.players.length - 1;   // ตาถัดไปปุ่มจะขยับมาที่ index 0 = คนได้ไพ่ A
    this.shufDoneFor = this.handNo;
    this.shuf = null;
    this.startHand();
  }

  // โชว์ไพ่หลังจบตา (ใครอยากโชว์ก็กดเอง)
  showCards(p) {
    if (this.phase !== 'showdown') throw new UserError('โชว์ไพ่ได้หลังจบตาเท่านั้น');
    if (!p.hole.length || p.shown) throw new UserError('ไม่มีไพ่ให้โชว์');
    p.shown = true;
    this.addLog(`${p.name} โชว์ไพ่ ${p.hole.map(cardText).join(' ')}`);
    this.touch();
  }

  // ระหว่างลุ้นไพ่ (ออลอิน) ใครนำอยู่ตอนนี้
  leaders() {
    const cont = this.players.filter((q) => q.inHand && !q.folded);
    if (cont.length < 2) return [];
    const score = (q) => {
      const cards = [...q.hole, ...this.community];
      if (cards.length >= 5) return evaluate(cards).score;
      const cnt = {}; for (const c of cards) cnt[c % 13] = (cnt[c % 13] || 0) + 1;
      const ranks = Object.keys(cnt).map(Number).sort((a, b) => (cnt[b] - cnt[a]) || (b - a));
      const top = cnt[ranks[0]];
      return top * 1e8 + ranks.reduce((s, r, i) => s + (r + 1) * Math.pow(15, 4 - i), 0);
    };
    const sc = cont.map((q) => [q.id, score(q)]);
    const best = Math.max(...sc.map((x) => x[1]));
    return sc.filter((x) => x[1] === best).map((x) => x[0]);
  }

  // ---------- ทัวร์นาเมนต์ ----------
  totalBuyIns() {
    const m = {};
    for (const f of this.tour.finishers) m[f.id] = f.buyIns;
    for (const q of this.players) m[q.id] = 1 + q.rebuys;
    return Object.values(m).reduce((a, b) => a + b, 0);
  }
  // เงินรางวัล: หัก Bounty Hunter 10% (ขั้นต่ำ 100 บาท) ก่อน แล้วที่เหลือแบ่ง 50/30/20% ปัดหลัก 10 (อันดับ 1 รับส่วนที่เหลือ)
  bountyAmount(pool) {
    const r100 = (x) => Math.round(x / 100) * 100;
    return Math.min(Math.floor(pool / 2 / 10) * 10, Math.max(100, r100(pool * 0.1)));
  }
  prizeTable(pool, n = 3, bounty = 0) {
    const r10 = (x) => Math.round(x / 10) * 10;
    const rem = pool - bounty;
    const p2 = n >= 2 ? r10(rem * 0.3) : 0, p3 = n >= 3 ? r10(rem * 0.2) : 0;
    return [rem - p2 - p3, p2, p3].slice(0, Math.max(1, Math.min(3, n)));
  }
  // ผู้ที่ทำให้คนอื่นชิปหมดมากที่สุด (เท่ากันแบ่งกัน)
  bountyHunters() {
    const m = new Map();
    for (const f of this.tour.finishers) m.set(f.id, { id: f.id, name: f.name, kills: f.kills || 0 });
    for (const q of this.players) m.set(q.id, { id: q.id, name: q.name, kills: q.kills || 0 });
    const all = [...m.values()]; const top = Math.max(0, ...all.map((x) => x.kills));
    return top > 0 ? all.filter((x) => x.kills === top) : [];
  }
  // แจกแจงรางวัลทั้งหมดจากยอดรวม: { bounty(ต่อคน), hunters, prizes }
  payouts(pool, n = 3) {
    const hunters = this.bountyHunters();
    const total = this.bountyAmount(pool);
    const each = hunters.length ? Math.floor(total / hunters.length / 10) * 10 : 0;
    const paid = each * hunters.length;
    return { total, each, hunters, prizes: this.prizeTable(pool, n, paid) };
  }
  tourAlive() { return this.players.filter((q) => !q.left && !q.out); }
  // ผู้เล่นที่ชิปหมดยังนับว่าอยู่ในเกมจนกว่าจะตกรอบ → คนที่หมดชิปเป็นอันดับ 4 ยังบายอินได้ ปิดเมื่อเหลือ 3 คนสุดท้ายจริงๆ
  // ทัวร์นาเมนต์ที่เริ่มแล้ว ยังเปิดให้คนใหม่เข้าร่วมได้ จนกว่าบลายด์จะขึ้นครั้งแรก
  lateOpen() { return !!(this.tour && this.tour.started && !this.tour.over && this.handNo < this.tour.every); }
  rebuyOpen() { return this.tourAlive().length > 3; }

  // ตกรอบ: ได้อันดับเท่าจำนวนคนที่ยังอยู่ (เรียงดีสุดก่อน) แล้วกลายเป็นผู้ชม
  tourEliminate(list, why) {
    const t = this.tour;
    const aliveN = this.tourAlive().length;
    const order = [...list].sort((a, b) => ((b.bustHand ?? this.handNo) - (a.bustHand ?? this.handNo)) || (b.handStartChips - a.handStartChips));
    order.forEach((q, i) => {
      q.out = true;
      q.place = aliveN - order.length + 1 + i;
      q.voice = null; q.muted = false;
      t.finishers.push({ id: q.id, name: q.name, place: q.place, buyIns: 1 + q.rebuys, kills: q.kills, rebuys: q.rebuys });
      this.addLog(`❌ ${q.name} ตกรอบ (${why}) · อันดับ ${q.place}`);
    });
  }

  // จบตา: คนชิปหมดต้องตัดสินว่ารอบายอินเพิ่มหรือตกรอบ
  tourAfterHand() {
    const t = this.tour;
    const bust = this.players.filter((q) => !q.left && !q.out && q.chips === 0);
    if (bust.length) {
      const open = this.rebuyOpen();
      const gone = [];
      for (const q of bust) {
        if (q.bustHand == null) q.bustHand = this.handNo;
        if (!open || q.rebuys >= t.maxRebuys) gone.push(q);
        else if (q.bustHand === this.handNo) this.addLog(`💸 ${q.name} ชิปหมด บายอินเพิ่มได้ภายใน ${t.window} ตา`);
      }
      if (gone.length) this.tourEliminate(gone, open ? 'ใช้สิทธิ์บายอินครบแล้ว' : 'ปิดรับบายอินเพิ่ม');
    }
    this.tourCheckWinner();
  }

  // เริ่มตาใหม่: คนที่ปล่อยเกิน 5 ตาโดยไม่บายอิน = สละสิทธิ์
  tourForfeit() {
    const t = this.tour;
    const gone = this.players.filter((q) => !q.left && !q.out && q.chips === 0 && q.bustHand != null && this.handNo + 1 > q.bustHand + t.window);
    if (gone.length) this.tourEliminate(gone, 'ไม่บายอินภายใน 5 ตา');
  }

  tourCheckWinner() {
    const t = this.tour;
    if (!t || !t.started || t.over) return !!(t && t.over);
    const alive = this.tourAlive();
    if (alive.length > 1) return false;
    t.over = true;
    const w = alive[0];
    if (w) { w.place = 1; t.finishers.push({ id: w.id, name: w.name, place: 1, buyIns: 1 + w.rebuys, kills: w.kills, rebuys: w.rebuys }); this.addLog(`🏆 ${w.name} ชนะทัวร์นาเมนต์!`); }
    clearTimeout(this.turnTimer);
    { clearTimeout(this.nextTimer); this.nextTimer = setTimeout(() => this.endTournament(), this.phase === 'hand' ? 0 : this.phase === 'showdown' ? this.timing.tourEndDelay : 500); }
    return true;
  }

  endTournament() {
    const t = this.tour;
    if (!t || this.phase === 'over') return;
    clearTimeout(this.nextTimer); clearTimeout(this.runTimer); clearTimeout(this.turnTimer);
    const rows = [...t.finishers].sort((a, b) => a.place - b.place);
    const buyIns = rows.reduce((s, r) => s + r.buyIns, 0);
    const pool = buyIns * this.settings.buyIn;
    const po = this.payouts(pool, rows.length), pt = po.prizes;
    const prize = { 1: pt[0], 2: pt[1] || 0, 3: pt[2] || 0 };
    const hid = new Set(po.hunters.map((h) => h.id));
    t.endedAt = Date.now();
    t.result = {
      pool, buyIns, buyInAmount: this.settings.buyIn, chips: this.settings.startChips,
      hands: this.handNo, startedAt: t.startedAt, endedAt: t.endedAt,
      blinds: { sb: t.baseSB, bb: t.baseBB, every: t.every, lastSB: this.settings.sb, lastBB: this.settings.bb },
      bountyTotal: po.each * po.hunters.length,
      rows: rows.map((r) => ({ ...r, prize: prize[r.place] || 0, bounty: hid.has(r.id) ? po.each : 0 })),
    };
    this.phase = 'over';
    this.nextHandAt = null; this.toActIdx = -1; this.runout = false;
    this.addLog('🏁 ทัวร์นาเมนต์จบแล้ว');
    this.touch();
  }

  // ---------- สถิติ ----------
  // ใครชิปเหลือ 0 หลังจบตา = ถูกกำจัด นับ 1 ครั้งให้ผู้ชนะของพ็อตที่เขามีส่วนร่วมแต่แพ้
  recordKills(result) {
    if (!result || !result.showdown) return;
    for (const q of this.players) {
      if (!q.inHand || q.chips > 0) continue;
      const killers = new Set();
      for (const pot of result.pots) {
        if (pot.eligible.includes(q.id) && !pot.winners.includes(q.id)) pot.winners.forEach((id) => killers.add(id));
      }
      for (const id of killers) { const k = this.playerById(id); if (k && k !== q) k.kills++; }
      if (killers.size) this.addLog(`💀 ${q.name} ชิปหมด`);
    }
  }
  // จุดข้อมูลกราฟชิป: บันทึกตอนเริ่มเกมและทุกครั้งที่จบตา
  recordHistory() {
    const c = {};
    for (const q of this.players) { if (q.left) continue; c[q.id] = q.chips; this.histNames[q.id] = q.name; }
    this.history.push({ h: this.handNo, c });
    if (this.history.length > 200) this.history.shift();
  }
  chartView() {
    const ids = Object.keys(this.histNames);
    const pts = this.history.slice(-60).map((pt) => [pt.h, ...ids.map((id) => (id in pt.c ? pt.c[id] : null))]);
    return { ids, names: ids.map((id) => this.histNames[id]), pts };
  }

  // ---------- ไทเมอร์ตาเล่น ----------
  scheduleTurn() {
    clearTimeout(this.turnTimer);
    this.turnDeadline = null;
    const p = this.players[this.toActIdx];
    if (this.phase !== 'hand' || !p) return;
    if (p.pre) { const d = this.timing.preDelay; if (d <= 0) { this.autoPre(p); return; } this.turnTimer = setTimeout(() => this.autoPre(p), d); return; }
    let ms = null;
    if (!p.connected) ms = this.settings.turnTime > 0
      ? Math.min(this.settings.turnTime * 1000, this.timing.offlineDelay)
      : this.timing.offlineDelay;
    else if (this.settings.turnTime > 0) ms = this.settings.turnTime * 1000;
    if (ms == null) return;
    this.turnDeadline = Date.now() + ms;
    this.turnTimer = setTimeout(() => this.autoAct(p), ms);
  }

  // เช็ค/โฟลด์ล่วงหน้า: พอถึงตา ถ้าเช็คได้ก็เช็ค ถ้ามีคนเดิมพันเพิ่มก็โฟลด์ (รีเซ็ตทุกถนน)
  autoPre(p) {
    if (this.phase !== 'hand' || this.players[this.toActIdx] !== p || !p.pre) return;
    p.pre = null;
    this.autoAct(p);
  }
  // ตั้งล่วงหน้าว่าจะโชว์ไพ่หลังจบตา (ใช้ได้ระหว่างตา)
  setAutoShow(p, on) {
    if (this.phase !== 'hand' || !p.inHand) throw new UserError('ตั้งไม่ได้ตอนนี้');
    p.autoShow = !!on;
    this.touch();
  }
  setPre(p, on) {
    if (this.phase !== 'hand' || !p.inHand || p.folded || p.allIn) throw new UserError('ตั้งไม่ได้ตอนนี้');
    if (this.players[this.toActIdx] === p) throw new UserError('ถึงตาคุณแล้ว');
    p.pre = on ? 'checkfold' : null;
    this.touch();
  }

  autoAct(p) {
    if (this.phase !== 'hand' || this.players[this.toActIdx] !== p) return;
    const o = this.optionsFor(p);
    try { this.act(p, { type: o.canCheck ? 'check' : 'fold' }); } catch (e) { /* ignore */ }
  }

  // ---------- มุมมองของผู้เล่นแต่ละคน ----------
  viewFor(token) {
    const me = this.playerByToken(token);
    const spec = me ? null : this.spectatorByToken(token);
    // เปิดไพ่ในมือเมื่อถึง showdown หรือเมื่อออลอินและกำลังเปิดไพ่กลาง (ไม่มีใครเดิมพันต่อได้แล้ว)
    const reveal = (this.phase === 'showdown' && this.result && this.result.showdown) || (this.phase === 'hand' && this.runout);
    const cur = this.players[this.toActIdx];
    const players = this.players.map((q, i) => {
      const shown = q === me || (reveal && q.inHand && !q.folded) || q.shown;
      return {
        id: q.id, name: q.name, chips: q.chips, bet: q.bet, total: q.total,
        folded: q.folded, allIn: q.allIn, inHand: q.inHand, connected: q.connected, left: q.left,
        isDealer: this.phase !== 'lobby' && i === this.dealerIdx,
        isHost: q.id === this.hostId, shown: q.shown,
        isSB: (this.phase === 'hand' || this.phase === 'showdown') && i === this.sbIdx,
        isBB: (this.phase === 'hand' || this.phase === 'showdown') && i === this.bbIdx,
        kills: q.kills, out: q.out, place: q.place,
        rebuysLeft: this.tour ? Math.max(0, this.tour.maxRebuys - q.rebuys) : null,
        rebuyBy: this.tour && q.bustHand != null && !q.out ? q.bustHand + this.tour.window + 1 : null,
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
      runout: this.runout,
      reveal: this.phase === 'hand' && this.runout && this.revealAt ? { left: Math.max(0, this.revealAt - Date.now()), ms: this.revealMs, next: this.revealNext } : null,
      lead: this.phase === 'hand' && this.runout ? this.leaders() : [],
      shuffle: this.shufView(),
      soleId: this.phase === 'waiting' ? this.soleId : null,
      players,
      you: me ? (me.out ? { id: me.id, spectator: true, out: true, place: me.place } : { id: me.id, handName: this.myHandName(me), pre: me.pre, autoShow: !!me.autoShow }) : (spec ? { id: spec.id, spectator: true } : null),
      spectators: this.spectators.map((s) => s.name),
      specList: this.spectators.map((x) => ({ id: x.id, name: x.name, online: x.connected, voice: x.voice, muted: x.muted })),
      voice: [...this.players.filter((q) => !q.left), ...this.spectators]
        .filter((m) => m.voice)
        .map((m) => ({ id: m.id, name: m.name, mode: m.voice, muted: m.muted })),
      chart: this.chartView(),
      tourney: this.tourneyView(),
      result: this.phase === 'showdown' ? this.publicResult() : null,
      log: this.log.slice(-40),
      chat: this.chat.slice(-20),
      serverNow: Date.now(),
    };
    if (me && cur === me && this.phase === 'hand') view.options = this.optionsFor(me);
    return view;
  }

  shufView() {
    const sh = this.shuf;
    if (!sh) return null;
    const taken = {}; for (const [id, slot] of Object.entries(sh.picks)) taken[slot] = id;
    const out = { n: sh.n, ids: sh.ids, taken, revealed: sh.revealed, deadline: sh.deadline, until: sh.until, vals: null, order: null, val: null };
    if (sh.revealed) { out.vals = sh.vals; out.order = sh.order; out.val = sh.val; }
    return out;
  }

  tourneyView() {
    const t = this.tour;
    if (!t) return null;
    const lvl = Math.floor(Math.max(0, this.handNo - 1) / t.every);
    const nextHand = (lvl + 1) * t.every + 1;
    return {
      started: t.started, over: t.over, lateOpen: this.lateOpen(), every: t.every, buyIn: this.settings.buyIn, maxRebuys: t.maxRebuys, window: t.window,
      rebuyOpen: this.rebuyOpen(), nextLevelHand: nextHand, nextSB: t.baseSB * 2 ** (lvl + 1), nextBB: t.baseBB * 2 ** (lvl + 1),
      pool: this.settings.buyIn * this.totalBuyIns(),
      no: t.no, ...(() => { const po = this.payouts(this.settings.buyIn * this.totalBuyIns()); return { prizes: po.prizes, bounty: po.total, bountyEach: po.each, hunters: po.hunters.map((h) => ({ name: h.name, kills: h.kills })) }; })(),
      alive: this.tourAlive().length, result: t.result, startedAt: t.startedAt,
    };
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
    clearTimeout(this.runTimer);
    this.spectators.forEach((s) => clearTimeout(s.dropTimer));
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
