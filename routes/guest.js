const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { createSession, requireGuest, SESSION_COOKIE } = require('../guest-auth');
const { sendGuestLoginLink } = require('../email');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const memberResult = await pool.query('SELECT 1 FROM members WHERE email = $1 LIMIT 1', [email]);

    if (memberResult.rows[0]) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await pool.query(
        'INSERT INTO guest_login_links (token, email, expires_at) VALUES ($1, $2, $3)',
        [token, email, expiresAt]
      );
      const loginUrl = `${process.env.BASE_URL}/api/guest/login/callback?token=${token}`;
      await sendGuestLoginLink({ to: email, loginUrl });
    }

    res.json({ success: true, message: 'If that email has any bookings, a link has been sent.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/login/callback', async (req, res) => {
  try {
    const { token } = req.query;
    const linkResult = await pool.query(
      'SELECT * FROM guest_login_links WHERE token = $1 AND used = false AND expires_at > now()',
      [token]
    );
    const link = linkResult.rows[0];
    if (!link) return res.status(400).send('This login link is invalid or has expired.');

    await pool.query('UPDATE guest_login_links SET used = true WHERE token = $1', [token]);

    const sessionToken = await createSession(link.email);
    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000
    });
    res.redirect('/my-bookings.html');
  } catch (err) { res.status(500).send(err.message); }
});

router.post('/logout', requireGuest, async (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ success: true });
});

router.get('/me', requireGuest, async (req, res) => {
  res.json({ email: req.guestEmail });
});

router.get('/bookings', requireGuest, async (req, res) => {
  try {
    const bookingsResult = await pool.query(
      `SELECT DISTINCT b.* FROM bookings b
       JOIN members m ON m.booking_id = b.id
       WHERE m.email = $1
       ORDER BY b.created_at DESC`,
      [req.guestEmail]
    );
    const bookings = bookingsResult.rows.map(b => ({
      bookingId: b.id,
      propertyName: b.property_name,
      totalAmount: b.total_amount / 100,
      shareAmount: b.share_amount / 100,
      groupSize: b.group_size,
      status: b.status,
      createdAt: b.created_at
    }));
    res.json({ bookings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
