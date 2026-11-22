/* ตัวเลือกเสียงเปิดไพ่ — เพิ่มแบบใหม่ได้โดยเติมรายการในอาร์เรย์นี้
   play(h): h.tone(freq, dur, {type, vol, slide, delay}) และ h.noiseHit(dur, {freq, q, vol}) */
window.CARD_SOUNDS = [
  { id: 'classic', name: 'คลาสสิก', play: (h) => { h.noiseHit(0.11, { freq: 4200, vol: 0.32 }); h.tone(190, 0.07, { vol: 0.08, slide: -60 }); } },
];
