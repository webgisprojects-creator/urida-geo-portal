// CAPTCHA challenges live in the database, not in process memory: the app runs as
// several processes, and the one that receives a login is often not the one that
// issued its CAPTCHA.
import crypto from 'crypto';
import { pool } from '../config/db.js';

// The answer is also needed to speak it. It is stored encrypted, with a key that
// every app process derives from the same secret and the database never sees.
const key = () => crypto.createHash('sha256').update(`captcha:${process.env.JWT_SECRET}`).digest();

const seal = (text) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
};

const unseal = (sealed) => {
  const data = Buffer.from(sealed, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
};

let tableReady = null;

const createTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.captcha_challenges (
      id text PRIMARY KEY,
      answer_hash text NOT NULL,
      expires_at timestamptz NOT NULL
    )
  `);
  await pool.query('ALTER TABLE public.captcha_challenges ADD COLUMN IF NOT EXISTS answer_sealed text');
  // Only the application needs this table. Remove everything inherited from the
  // schema's default grants, to the public and to any other role.
  await pool.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT DISTINCT a.grantee FROM pg_class c, aclexplode(c.relacl) a
                WHERE c.oid = 'public.captcha_challenges'::regclass AND a.grantee <> c.relowner LOOP
        EXECUTE format('REVOKE ALL ON public.captcha_challenges FROM %s',
                       CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END);
      END LOOP;
    END $$`);
};

export const ensureCaptchaTable = () => {
  if (!tableReady) {
    tableReady = createTable()
      // Two processes starting together can both try to create it; the loser's
      // second attempt finds it there.
      .catch(createTable)
      .catch((err) => {
        tableReady = null;
        throw err;
      });
  }
  return tableReady;
};

export const saveCaptcha = async (id, answerHash, answer, ttlMs) => {
  await ensureCaptchaTable();
  await pool.query('DELETE FROM public.captcha_challenges WHERE expires_at < now()');
  await pool.query(
    `INSERT INTO public.captcha_challenges (id, answer_hash, answer_sealed, expires_at)
     VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')`,
    [id, answerHash, seal(answer), ttlMs]
  );
};

// Removes the challenge and returns it, in one statement, so that each CAPTCHA
// can be tried only once even if two logins arrive together.
export const takeCaptcha = async (id) => {
  await ensureCaptchaTable();
  const { rows } = await pool.query(
    `DELETE FROM public.captcha_challenges WHERE id = $1
     RETURNING answer_hash, expires_at > now() AS live`,
    [id]
  );
  return rows[0] ? { answerHash: rows[0].answer_hash, expired: !rows[0].live } : null;
};

// For the audio option: the answer of a challenge that is still open, or null.
export const readCaptchaAnswer = async (id) => {
  if (!id) return null;
  await ensureCaptchaTable();
  const { rows } = await pool.query(
    'SELECT answer_sealed FROM public.captcha_challenges WHERE id = $1 AND expires_at > now()',
    [id]
  );
  return rows[0]?.answer_sealed ? unseal(rows[0].answer_sealed) : null;
};
