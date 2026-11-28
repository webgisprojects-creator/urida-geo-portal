// Runs the real server against a throwaway PostGIS database loaded from fixtures.sql.
// Needs DB_HOST, DB_PORT, DB_USER, DB_PASS and DB_NAME (a name ending in "_test").
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

if (!String(process.env.DB_NAME || '').endsWith('_test')) {
  throw new Error('Refusing to run: DB_NAME must end in "_test" (the tests delete and recreate tables).');
}
Object.assign(process.env, {
  NODE_ENV: 'test',
  NODE_APP_INSTANCE: '1', // no cache warmers or background schedules
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  KMC_WRITE_URL: 'http://127.0.0.1:1',
  KMC_API_KEY: 'test',
  GEOSERVER_PROXY_TARGET: 'http://127.0.0.1:1',
  // fixed here so that a developer's own .env cannot change the results
  SESSION_IDLE_TIMEOUT_MS: String(15 * 60 * 1000),
  FIELD_TASK_SESSION_IDLE_TIMEOUT_MS: String(30 * 60 * 1000),
  SESSION_ABSOLUTE_TIMEOUT_MS: String(30 * 60 * 1000),
  FIELD_TASK_ONLY_USERNAMES: 'chainage',
  MAX_SESSIONS_PER_USER: '50',
  DB_SSL: 'false',
});

const { pool } = await import('../src/config/db.js');
const { default: app } = await import('../src/app.js');
const { peekCaptchaForTest } = await import('../src/controllers/authController.js');
const { runActiveTokensExpiryCheck } = await import('../src/middleware/authMiddleware.js');
const { default: bcrypt } = await import('bcryptjs');

const PASSWORD = `T9!${crypto.randomBytes(12).toString('hex')}`;
let server;
let base;
const cookies = {};

const call = async (path, { as, ...options } = {}) => {
  const headers = { ...(options.headers || {}) };
  if (as) headers.cookie = cookies[as];
  const response = await fetch(base + path, { ...options, headers });
  const body = Buffer.from(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(body.toString()); } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, body, json };
};

const newCaptcha = async () => {
  const response = await call('/api/auth/captcha');
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  return { response, cookie, answer: await peekCaptchaForTest(cookie.split('=')[1]) };
};

const login = async (username, { password = PASSWORD, captchaAs = (a) => a, redirect } = {}) => {
  const { cookie, answer } = await newCaptcha();
  const response = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ username, password, captcha: captchaAs(answer), redirect }),
  });
  const auth = response.headers.getSetCookie().find((c) => c.startsWith('auth_token='));
  if (auth) cookies[username] = auth.split(';')[0];
  return response;
};

before(async () => {
  await pool.query(fs.readFileSync(new URL('./fixtures.sql', import.meta.url), 'utf8'));
  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query(
    `INSERT INTO public.users (username, password, role, city, user_id)
     SELECT u, $1, r, c, u FROM (VALUES ('boss','admin',NULL),('gzb','user','ghaziabad'),('state','state_manager',NULL)) v(u,r,c)`,
    [hash]
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await pool.end();
});

test('the captcha response never contains the answer', async () => {
  const { response, answer } = await newCaptcha();
  assert.equal(answer.length, 5);
  assert.equal(response.body.toString().includes(answer), false);
  assert.equal(response.json.captcha.audioText, undefined);
  assert.match(response.json.captcha.image, /^data:image\/png;base64,/);
});

test('captcha challenges are shared through the database, without a readable answer', async () => {
  const { cookie, answer } = await newCaptcha();
  const id = cookie.split('=')[1];
  const { rows } = await pool.query('SELECT answer_hash, answer_sealed FROM public.captcha_challenges WHERE id = $1', [id]);
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows[0]).includes(answer), false);
  const others = await pool.query(
    `SELECT count(*)::int AS n FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = 'public.captcha_challenges'::regclass AND a.grantee <> c.relowner`
  );
  assert.equal(others.rows[0].n, 0);
});

test('the audio captcha is sound, and only for the holder of the cookie', async () => {
  const { cookie } = await newCaptcha();
  const mine = await call('/api/auth/captcha/audio', { headers: { cookie } });
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('content-type'), 'audio/wav');
  assert.equal(mine.headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/auth/captcha/audio')).status, 404);
});

test('login: correct, wrong password, wrong captcha case', async () => {
  for (const user of ['boss', 'gzb', 'state']) assert.equal((await login(user)).status, 200, user);
  assert.equal((await login('gzb', { password: 'Wrong-password-1!' })).status, 401);
  const swap = (a) => [...a].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
  let refused;
  do { refused = await newCaptcha(); } while (!/[A-Za-z]/.test(refused.answer));
  const response = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: refused.cookie },
    body: JSON.stringify({ username: 'gzb', password: PASSWORD, captcha: swap(refused.answer) }),
  });
  assert.equal(response.status, 400);
});

test('data needs a login', async () => {
  for (const path of ['/api/road-networks/ghaziabad/dss/streetLight/rows', '/api/ghaziabad/amenities']) {
    assert.equal((await call(path)).status, 401, path);
  }
});

test('a city user is refused other cities on every kind of data route', async () => {
  const paths = [
    '/api/road-networks/agra', '/api/road-networks/AGRA/details', '/api/road-networks/agra/dss/encroachment/rows',
    '/api/road-networks/agra/encroachment-analysis/summary', '/api/agra/amenities', '/api/agra/zone-summary',
    '/api/agra/roads/above10m/geojson',
  ];
  for (const path of paths) assert.equal((await call(path, { as: 'gzb' })).status, 403, path);
  assert.equal((await call('/api/road-networks/agra/amenities-count', { as: 'gzb', method: 'POST' })).status, 403);
  assert.equal((await call('/api/road-networks/ghaziabad/dss/streetLight/rows', { as: 'gzb' })).status, 200);
  for (const user of ['boss', 'state']) {
    assert.equal((await call('/api/road-networks/agra/dss/encroachment/rows', { as: user })).status, 200, user);
  }
});

test('decision support table: totals, paging, legend counts, filters', async () => {
  const root = '/api/road-networks/ghaziabad/dss/streetLight';
  const first = await call(`${root}/rows?includeTotal=1&limit=10`, { as: 'gzb' });
  assert.equal(first.json.total, 30);
  assert.equal(first.json.data.length, 10);
  assert.equal('geom' in first.json.data[0], false);
  const second = await call(`${root}/rows?limit=10&page=2`, { as: 'gzb' });
  assert.notDeepEqual(second.json.data, first.json.data);
  assert.equal((await call(`${root}/rows?limit=0`, { as: 'gzb' })).json.data.length, 30);
  const counts = await call(`${root}/counts/street_light`, { as: 'gzb' });
  assert.equal(counts.json.reduce((sum, row) => sum + row.count, 0), 30);
  const filtered = await call(`${root}/rows?includeTotal=1&filters=${encodeURIComponent('{"ward_no":["10"]}')}`, { as: 'gzb' });
  assert.equal(filtered.json.total, 10);
});

test('hostile table input is refused or harmless, never a server error', async () => {
  const root = '/api/road-networks/ghaziabad/dss/streetLight';
  const filters = (value) => `${root}/rows?filters=${encodeURIComponent(JSON.stringify(value))}`;
  const paths = [
    filters({ 'ward_no") OR 1=1 --': ['1'] }), filters({ ward_no: ["1' OR '1'='1"] }),
    filters({ length_km: { type: 'op', op: '; drop', value: '1' } }), `${root}/rows?filters=not-json`,
    `${root}/rows?page=99999999999999999999`, `${root}/counts/${encodeURIComponent('x" FROM pg_user --')}`,
    '/api/road-networks/ghaziabad/dss/constructor/rows', '/api/ghaziabad/amenities?zone=1&zone=2',
  ];
  for (const path of paths) {
    const response = await call(path, { as: 'boss' });
    assert.ok(response.status < 500, `${response.status} ${decodeURIComponent(path)}`);
    assert.doesNotMatch(response.body.toString(), /pg_user|syntax error/i);
  }
});

test('amenity counts follow the zone and ward filter', async () => {
  assert.equal((await call('/api/ghaziabad/amenities', { as: 'gzb' })).json.atm_bank, 3);
  assert.equal((await call('/api/ghaziabad/amenities?zone=1', { as: 'gzb' })).json.atm_bank, 2);
  assert.equal((await call('/api/ghaziabad/amenities?zone=1&ward=11', { as: 'gzb' })).json.atm_bank, 1);
});

test('encroachment summary gives one row per zone with a percentage', async () => {
  const response = await call('/api/road-networks/agra/encroachment-analysis/summary', { as: 'boss' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.zones.map((z) => [z.zone_no, z.total_roads, z.encroached_roads, z.encroachment_percentage]),
    [['1', 8, 2, 25], ['2', 5, 0, 0]]);
});

test('session sweep closes only sessions that are really over', async () => {
  await pool.query('DELETE FROM active_tokens');
  await pool.query(`
    INSERT INTO active_tokens (token_hash, user_id, issued_at, expires_at, last_activity_time, status) VALUES
      ('fresh',     'gzb',      now() - interval '5 min',  now() + interval '1 hour', now(),                       'active'),
      ('quiet20',   'chainage', now() - interval '25 min', now() + interval '1 hour', now() - interval '20 min',   'active'),
      ('abandoned', 'gzb',      now() - interval '29 min', now() + interval '1 hour', now() - interval '31 min',   'active'),
      ('too_old',   'gzb',      now() - interval '40 min', now() + interval '1 hour', now(),                       'active')`);
  await runActiveTokensExpiryCheck();
  const { rows } = await pool.query('SELECT token_hash, status FROM active_tokens ORDER BY token_hash');
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.token_hash, r.status])),
    { abandoned: 'inactivated', fresh: 'active', quiet20: 'active', too_old: 'session_expired' });
});
