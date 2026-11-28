// Draws a CAPTCHA as a PNG. The text exists only as pixels: nothing in the
// image or the response contains the characters. No dependencies and no system
// fonts, so it renders the same on a server without internet or fonts.
import crypto from 'crypto';
import zlib from 'zlib';

// 5 x 7 glyphs, one string per row, for exactly the characters the CAPTCHA uses.
const GLYPHS = {
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110', D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001',
  J: '00111 00010 00010 00010 00010 10010 01100', K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111', M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 11001 11001 10101 10011 10011 10001', P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110', V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 10101 01010', X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
  a: '00000 00000 01110 00001 01111 10001 01111', b: '10000 10000 10110 11001 10001 10001 11110',
  d: '00001 00001 01101 10011 10001 10001 01111', e: '00000 00000 01110 10001 11111 10000 01110',
  f: '00110 01001 01000 11100 01000 01000 01000', g: '00000 01111 10001 10001 01111 00001 01110',
  h: '10000 10000 10110 11001 10001 10001 10001', j: '00010 00000 00110 00010 00010 10010 01100',
  m: '00000 00000 11010 10101 10101 10101 10101', n: '00000 00000 10110 11001 10001 10001 10001',
  q: '00000 01101 10011 10001 01111 00001 00001', r: '00000 00000 10110 11001 10000 10000 10000',
  t: '01000 01000 11100 01000 01000 01001 00110', y: '00000 10001 10001 10001 01111 00001 01110',
  2: '01110 10001 00001 00010 00100 01000 11111', 3: '11111 00010 00100 00010 00001 10001 01110',
  4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110', 9: '01110 10001 10001 01111 00001 00010 01100',
};

export const CAPTCHA_CHARS = Object.keys(GLYPHS).join('');

const WIDTH = 240;
const HEIGHT = 74;
const random = (min, max) => min + crypto.randomInt(Math.round((max - min) * 1000) + 1) / 1000;

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = 0xffffffff;
  for (const byte of body) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, body.length + 4);
  return out;
};
const encodePng = (rgb) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bit RGB
  const rows = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) rgb.copy(rows, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// Strokes joining neighbouring cells of a glyph, so letters come out as smooth
// lines and not as blocks. A diagonal is used only where no corner joins the cells.
const strokes = (rows) => {
  const on = (x, y) => x >= 0 && x < 5 && y >= 0 && y < 7 && rows[y][x] === '1';
  const out = [];
  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      if (!on(x, y)) continue;
      out.push([x, y, x, y]);
      if (on(x + 1, y)) out.push([x, y, x + 1, y]);
      if (on(x, y + 1)) out.push([x, y, x, y + 1]);
      if (on(x + 1, y + 1) && !on(x + 1, y) && !on(x, y + 1)) out.push([x, y, x + 1, y + 1]);
      if (on(x - 1, y + 1) && !on(x - 1, y) && !on(x, y + 1)) out.push([x, y, x - 1, y + 1]);
    }
  }
  return out;
};

const distance = (px, py, [x1, y1, x2, y2]) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
};

export const renderCaptchaPng = (text) => {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let i = 0; i < rgb.length; i += 3) rgb.set([247, 248, 252], i);
  const paint = (x, y, colour, strength = 1) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT) return;
    const at = (py * WIDTH + px) * 3;
    for (let c = 0; c < 3; c += 1) rgb[at + c] = Math.round(rgb[at + c] + (colour[c] - rgb[at + c]) * strength);
  };
  const phase = random(0, Math.PI * 2);
  const wave = (x) => Math.sin(x / 26 + phase) * 1.6;

  [...text].forEach((char, index) => {
    const rows = GLYPHS[char]?.split(' ');
    if (!rows) throw new Error('unsupported CAPTCHA character');
    const lines = strokes(rows);
    const scaleX = random(6.2, 6.8);
    const scaleY = random(6, 6.6);
    const angle = random(-0.16, 0.16);
    const cx = 28 + index * 46 + random(-2, 2);
    const cy = HEIGHT / 2 + random(-4, 4);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // walk the output area and measure back into the glyph, so rotation leaves no holes
    for (let dy = -30; dy <= 30; dy += 1) {
      for (let dx = -24; dx <= 24; dx += 1) {
        const gx = (dx * cos + dy * sin) / scaleX + 2;
        const gy = (-dx * sin + dy * cos) / scaleY + 3;
        if (gx < -1 || gx > 5 || gy < -1 || gy > 7) continue;
        const d = Math.min(...lines.map((l) => distance(gx, gy, l)));
        const strength = Math.max(0, Math.min(1, (0.43 - d) * scaleX + 0.5));
        if (strength > 0) paint(cx + dx, cy + dy + wave(cx + dx), [38, 66, 150], strength);
      }
    }
  });

  for (let line = 0; line < 2; line += 1) {
    const base = random(14, HEIGHT - 14);
    const height = random(6, 16);
    const period = random(18, 40);
    const shift = random(0, 6);
    for (let x = 0; x < WIDTH; x += 1) {
      const y = base + Math.sin(x / period + shift) * height;
      paint(x, y, [96, 128, 214]);
      paint(x, y + 1, [96, 128, 214], 0.5);
    }
  }
  for (let dot = 0; dot < 300; dot += 1) paint(crypto.randomInt(WIDTH), crypto.randomInt(HEIGHT), [88, 120, 205]);
  return encodePng(rgb);
};
