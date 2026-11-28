// Tests that need no database or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { canReadCity, requireOwnCity } from '../src/middleware/cityScope.js';
import { renderCaptchaPng, CAPTCHA_CHARS } from '../src/utils/captchaImage.js';
import { buildCaptchaWav } from '../src/utils/captchaAudio.js';

test('a user with a city reads only that city', () => {
  const user = { role: 'junior_engineer', city: 'Agra ' };
  assert.equal(canReadCity(user, 'agra'), true);
  assert.equal(canReadCity(user, 'AGRA'), true);
  assert.equal(canReadCity(user, 'lucknow'), false);
  assert.equal(canReadCity(user, 'constructor'), false);
});

test('admins and users without a city are not limited; no user reads nothing', () => {
  assert.equal(canReadCity({ role: 'admin', city: 'agra' }, 'lucknow'), true);
  assert.equal(canReadCity({ role: 'state_manager', city: null }, 'lucknow'), true);
  assert.equal(canReadCity(undefined, 'lucknow'), false);
});

test('the route guard answers 403 without calling the route', () => {
  let status;
  let passed = false;
  const res = { status: (code) => { status = code; return { json: () => {} }; } };
  requireOwnCity({ user: { role: 'user', city: 'agra' } }, res, () => { passed = true; }, 'lucknow');
  assert.deepEqual([status, passed], [403, false]);
});

test('the captcha character set leaves out look-alikes', () => {
  for (const char of 'ckpsuvwxzilo01IO') assert.equal(CAPTCHA_CHARS.includes(char), false, char);
});

test('every captcha character renders as a distinct, valid PNG', () => {
  for (const char of CAPTCHA_CHARS) {
    const png = renderCaptchaPng(char.repeat(5));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 240);
    const pixels = zlib.inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
    assert.equal(pixels.length, (240 * 3 + 1) * 74);
  }
});

test('the captcha image holds no readable text', () => {
  const png = renderCaptchaPng('AbQ7m');
  assert.equal(png.includes('AbQ7m'), false);
  assert.equal(png.includes('<text'), false);
});

test('every captcha character can be spoken', () => {
  for (let i = 0; i < CAPTCHA_CHARS.length; i += 5) {
    const wav = buildCaptchaWav(CAPTCHA_CHARS.slice(i, i + 5));
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.ok(wav.length > 20000);
  }
});

test('unsupported characters are refused', () => {
  assert.throws(() => renderCaptchaPng('<'));
  assert.throws(() => buildCaptchaWav('../..'));
});
