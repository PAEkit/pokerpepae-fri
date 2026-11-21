/* ตัวเลือกเพลงพื้นหลัง (สร้างเสียงสดในเครื่อง ไม่ใช้ไฟล์เพลง) — เพิ่มเพลงใหม่ได้โดยเติมรายการในอาร์เรย์นี้
   bpm = จังหวะต่อนาที (1 step = โน้ตเขบ็ต 1 ตัว) · step(n, t, h) เรียกทุก step
   h.note(freq, t, dur, type, vol, attack, lowpass) · h.hat(t, vol) · h.kick(t) · h.mtof(midi) · h.state (เก็บค่าชั่วคราว) */
(function () {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const walk = (h, len, steps) => { h.state.mi = Math.max(0, Math.min(len - 1, (h.state.mi == null ? 3 : h.state.mi) + pick(steps))); return h.state.mi; };

  // 1) บอสซ่า — จังหวะสบายๆ สดใส
  const BCH = [
    { r: 48, t: [60, 64, 67, 71] }, { r: 45, t: [57, 60, 64, 67] }, { r: 50, t: [57, 60, 62, 65] }, { r: 43, t: [59, 62, 65, 67] },
    { r: 41, t: [57, 60, 64, 67] }, { r: 52, t: [55, 59, 62, 67] }, { r: 50, t: [57, 60, 62, 65] }, { r: 43, t: [59, 62, 65, 67] },
  ];
  const BSC = [69, 72, 74, 76, 79, 81, 84, 86];
  const bossa = (n, t, h) => {
    const c = BCH[Math.floor(n / 8) % BCH.length], k = n % 8;
    if (k === 0) { h.note(h.mtof(c.r), t, 0.7, 'sine', 0.26, 0.01, 600); h.kick(t); }
    if (k === 3) h.note(h.mtof(c.r + 7), t, 0.45, 'sine', 0.18, 0.01, 600);
    if (k === 4) h.kick(t);
    if (k === 6) h.note(h.mtof(c.r + 12), t, 0.4, 'sine', 0.12, 0.01, 700);
    if (k === 2 || k === 5 || k === 7) c.t.forEach((m) => h.note(h.mtof(m), t + (k === 5 ? 0.03 : 0), 0.3, 'triangle', 0.05, 0.005, 2400));
    h.hat(t, k % 2 ? 0.05 : 0.03);
    if (Math.random() < (k % 2 ? 0.35 : 0.6)) {
      const i = walk(h, BSC.length, [-2, -1, -1, 0, 1, 1, 2]);
      h.note(h.mtof(BSC[i]), t, 0.5, 'triangle', 0.085, 0.005, 3400);
      if (Math.random() < 0.25) h.note(h.mtof(BSC[i] + 12), t + 0.02, 0.35, 'sine', 0.03, 0.005, 4000);
    }
  };

  // 2) ชิลล์ — ช้าๆ นุ่มๆ ฟังเพลินตอนรอ
  const LCH = [{ r: 41, t: [57, 60, 64, 67] }, { r: 40, t: [55, 59, 62, 67] }, { r: 38, t: [57, 60, 62, 65] }, { r: 36, t: [55, 59, 64, 67] }];
  const LSC = [67, 69, 72, 74, 76, 79, 81];
  const chill = (n, t, h) => {
    const c = LCH[Math.floor(n / 8) % LCH.length], k = n % 8;
    if (k === 0) { c.t.forEach((m) => h.note(h.mtof(m - 12), t, 3.4, 'sine', 0.07, 0.6, 1100)); h.note(h.mtof(c.r), t, 1.2, 'sine', 0.26, 0.02, 500); h.kick(t); }
    if (k === 5) { h.note(h.mtof(c.r + 7), t, 0.8, 'sine', 0.16, 0.02, 500); h.kick(t); }
    if (k === 2 || k === 6) h.hat(t, 0.025);
    if (Math.random() < 0.3) { const i = walk(h, LSC.length, [-2, -1, 0, 1, 2]); h.note(h.mtof(LSC[i]), t, 1.1, 'sine', 0.1, 0.01, 2500); }
  };

  // 3) สนุกสนาน — จังหวะเร็ว คอร์ดสดใส
  const HCH = [{ r: 48, t: [60, 64, 67, 72] }, { r: 43, t: [59, 62, 67, 71] }, { r: 45, t: [57, 60, 64, 69] }, { r: 41, t: [57, 60, 65, 69] }];
  const happy = (n, t, h) => {
    const c = HCH[Math.floor(n / 8) % HCH.length], k = n % 8;
    if (k % 2 === 0) { h.note(h.mtof(c.r + (k % 4 === 0 ? 0 : 12)), t, 0.22, 'triangle', 0.2, 0.005, 800); }
    if (k === 0 || k === 4) h.kick(t);
    h.hat(t, k % 2 ? 0.05 : 0.03);
    const arp = [0, 1, 2, 3, 2, 1, 2, 3][k];
    h.note(h.mtof(c.t[arp] + 12), t, 0.2, 'triangle', 0.07, 0.004, 3200);
    if (k === 6 && Math.random() < 0.5) h.note(h.mtof(c.t[3] + 24), t + 0.04, 0.3, 'sine', 0.04, 0.004, 4000);
  };

  // 4) กล่องดนตรี — เบาๆ ใสๆ ไม่มีกลอง
  const MCH = [[72, 76, 79, 84], [69, 72, 76, 81], [65, 69, 72, 77], [67, 71, 74, 79]];
  const music = (n, t, h) => {
    const c = MCH[Math.floor(n / 8) % MCH.length], k = n % 8;
    if (k === 0) h.note(h.mtof(c[0] - 24), t, 2.2, 'sine', 0.13, 0.02, 600);
    const arp = [0, 1, 2, 3, 2, 1, 3, 2][k];
    if (Math.random() < 0.85) h.note(h.mtof(c[arp]), t, 0.9, 'sine', 0.09, 0.003, 4200);
    if (k === 3 && Math.random() < 0.4) h.note(h.mtof(c[3] + 12), t + 0.05, 0.7, 'sine', 0.04, 0.003, 5000);
  };

  window.BGM_TRACKS = [
    { id: 'bossa', name: 'บอสซ่าสดใส', bpm: 104, step: bossa },
    { id: 'chill', name: 'ชิลล์ ๆ นุ่มๆ', bpm: 76, step: chill },
    { id: 'happy', name: 'สนุกสนาน', bpm: 124, step: happy },
    { id: 'music', name: 'กล่องดนตรี', bpm: 92, step: music },
  ];
})();
