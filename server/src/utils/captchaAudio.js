// Builds the spoken CAPTCHA on the server from recorded clips (one per
// character, 8 kHz 16-bit mono), with pauses and a little noise. The browser
// receives sound only, never the text.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'captcha-audio');
const RATE = 8000;
const cache = new Map();

const clipName = (char) => {
  if (/^[A-Z]$/.test(char)) return `upper_${char}.wav`;
  if (/^[a-z]$/.test(char)) return `lower_${char}.wav`;
  if (/^[0-9]$/.test(char)) return `digit_${char}.wav`;
  throw new Error('unsupported CAPTCHA character');
};

const samples = (char) => {
  const name = clipName(char);
  if (!cache.has(name)) {
    const wav = fs.readFileSync(path.join(folder, name));
    let at = 12; // walk the RIFF chunks to the sample data
    while (at + 8 <= wav.length && wav.toString('ascii', at, at + 4) !== 'data') {
      at += 8 + wav.readUInt32LE(at + 4) + (wav.readUInt32LE(at + 4) % 2);
    }
    if (at + 8 > wav.length) throw new Error(`no sample data in ${name}`);
    cache.set(name, wav.subarray(at + 8, at + 8 + wav.readUInt32LE(at + 4)));
  }
  return cache.get(name);
};

export const buildCaptchaWav = (text) => {
  const pause = () => Buffer.alloc((RATE / 1000) * (250 + crypto.randomInt(250)) * 2);
  const parts = [pause()];
  for (const char of text) parts.push(samples(char), pause());
  const data = Buffer.concat(parts);
  for (let i = 0; i + 1 < data.length; i += 2) {
    const noisy = data.readInt16LE(i) + crypto.randomInt(-220, 221);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, noisy)), i);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};
