/* ตัวเลือกเสียงเปิดไพ่ — เพิ่มแบบใหม่ได้โดยเติมรายการในอาร์เรย์นี้
   play(h): h.tone(freq, dur, {type, vol, slide, delay}) และ h.noiseHit(dur, {freq, q, vol}) */
window.CARD_SOUNDS = [
  { id: 'classic', name: 'คลาสสิก', play: (h) => { h.noiseHit(0.11, { freq: 4200, vol: 0.32 }); h.tone(190, 0.07, { vol: 0.08, slide: -60 }); } },
  { id: 'thud', name: 'ปึ้บ (วางไพ่นุ่มๆ)', play: (h) => { h.noiseHit(0.08, { freq: 900, q: 0.7, vol: 0.4 }); h.tone(110, 0.12, { vol: 0.3, slide: -40 }); } },
  { id: 'slide', name: 'รูด (ไพ่ลื่น)', play: (h) => { h.noiseHit(0.3, { freq: 2600, q: 0.5, vol: 0.28 }); h.tone(260, 0.2, { type: 'triangle', vol: 0.05, slide: -120 }); } },
  { id: 'bell', name: 'ติ๊ง (ระฆังเล็ก)', play: (h) => { h.tone(1568, 0.35, { vol: 0.18 }); h.tone(2093, 0.3, { vol: 0.12, delay: 0.06 }); h.noiseHit(0.05, { freq: 5000, vol: 0.15 }); } },
  { id: 'off', name: 'ปิดเสียงเปิดไพ่', play: () => {} },
];
