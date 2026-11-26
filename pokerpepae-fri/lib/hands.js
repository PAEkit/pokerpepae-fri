'use strict';
// ตัวประเมินมือไพ่โป๊กเกอร์
// ไพ่แต่ละใบเป็นเลข 0..51 : rank = (c % 13) + 2  (2..14, 14 = A), suit = floor(c / 13) (0=♠ 1=♥ 2=♦ 3=♣)

const CATEGORY_NAMES = [
  'ไฮการ์ด',        // 0
  'หนึ่งคู่',         // 1
  'สองคู่',          // 2
  'ตอง',            // 3  three of a kind
  'สเตรท',          // 4
  'ฟลัช',           // 5
  'ฟูลเฮ้าส์',       // 6
  'โฟร์การ์ด',       // 7
  'สเตรทฟลัช',      // 8
];

const rankOf = (c) => (c % 13) + 2;
const suitOf = (c) => Math.floor(c / 13);

// คืนคะแนนของไพ่ 5 ใบ (ตัวเลขยิ่งมากยิ่งชนะ) และหมวดของมือ
function score5(cards) {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));

  let straightHigh = 0;
  if (new Set(ranks).size === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5 && ranks[4] === 2) straightHigh = 5; // A-2-3-4-5
  }

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, n]) => [Number(r), n])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let cat;
  let tiebreak;
  if (straightHigh && flush) { cat = 8; tiebreak = [straightHigh]; }
  else if (groups[0][1] === 4) { cat = 7; tiebreak = groups.map((g) => g[0]); }
  else if (groups[0][1] === 3 && groups[1][1] === 2) { cat = 6; tiebreak = groups.map((g) => g[0]); }
  else if (flush) { cat = 5; tiebreak = ranks; }
  else if (straightHigh) { cat = 4; tiebreak = [straightHigh]; }
  else if (groups[0][1] === 3) { cat = 3; tiebreak = groups.map((g) => g[0]); }
  else if (groups[0][1] === 2 && groups[1][1] === 2) { cat = 2; tiebreak = groups.map((g) => g[0]); }
  else if (groups[0][1] === 2) { cat = 1; tiebreak = groups.map((g) => g[0]); }
  else { cat = 0; tiebreak = ranks; }

  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (tiebreak[i] || 0);
  return { score, cat, high: tiebreak[0] };
}

// เลือก 5 ใบที่ดีที่สุดจาก 5-7 ใบ
function evaluate(cards) {
  const n = cards.length;
  let best = null;
  const pick = [];
  (function rec(start) {
    if (pick.length === 5) {
      const s = score5(pick);
      if (!best || s.score > best.score) best = { ...s, best: pick.slice() };
      return;
    }
    for (let i = start; i < n; i++) {
      pick.push(cards[i]);
      rec(i + 1);
      pick.pop();
    }
  })(0);
  best.name = best.cat === 8 && best.high === 14 ? 'รอยัลฟลัช' : CATEGORY_NAMES[best.cat];
  return best;
}

module.exports = { evaluate, score5, rankOf, suitOf, CATEGORY_NAMES };
