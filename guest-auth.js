const crypto = require('crypto');
const { pool } = require('./db');

const SESSION_COOKIE = 'grouple_guest_session';
const SESSION_DAYS = 30;

async function createSession(email) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO guest_sessions (token, email, expires_at) VALUES ($1, $2, $3)',
    [token, email, expiresAt]
  );
  return token;
}

async function requireGuest(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const result = await pool.query(
    'SELECT * FROM guest_sessions WHERE token = $1 AND expires_at > now()',
    [token]
  );
  const session = result.rows[0];
  if (!session) return res.status(401).json({ error: 'Session expired' });

  req.guestEmail = session.email;
  next();
}

module.exports = { createSession, requireGuest, SESSION_COOKIE };
