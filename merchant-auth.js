const crypto = require('crypto');
const { pool } = require('./db');

const SESSION_COOKIE = 'grouple_merchant_session';
const SESSION_DAYS = 30;

async function createSession(merchantId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO merchant_sessions (token, merchant_id, expires_at) VALUES ($1, $2, $3)',
    [token, merchantId, expiresAt]
  );
  return token;
}

async function requireMerchant(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const result = await pool.query(
    `SELECT m.* FROM merchant_sessions s
     JOIN merchants m ON m.id = s.merchant_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  const merchant = result.rows[0];
  if (!merchant) return res.status(401).json({ error: 'Session expired' });

  req.merchant = merchant;
  next();
}

module.exports = { createSession, requireMerchant, SESSION_COOKIE };
