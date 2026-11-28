// CAPTCHA challenges live in the database, not in process memory: the app runs as
// several processes, and the one that receives a login is often not the one that
// issued its CAPTCHA.
import { pool } from '../config/db.js';

let tableReady = null;

const createTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.captcha_challenges (
      id text PRIMARY KEY,
      answer_hash text NOT NULL,
      expires_at timestamptz NOT NULL
    )
  `);
  // only the application needs it; do not inherit the schema's public read access
  await pool.query('REVOKE ALL ON public.captcha_challenges FROM PUBLIC');
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

export const saveCaptcha = async (id, answerHash, ttlMs) => {
  await ensureCaptchaTable();
  await pool.query('DELETE FROM public.captcha_challenges WHERE expires_at < now()');
  await pool.query(
    `INSERT INTO public.captcha_challenges (id, answer_hash, expires_at)
     VALUES ($1, $2, now() + $3 * interval '1 millisecond')`,
    [id, answerHash, ttlMs]
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
