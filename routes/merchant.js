const express = require('express');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { createSession, requireMerchant, SESSION_COOKIE } = require('../merchant-auth');
const { sendMerchantLoginLink } = require('../email');
const { cancelBooking } = require('../bookings');

const router = express.Router();

router.post('/signup', async (req, res) => {
  try {
    const { businessName, email } = req.body;
    if (!businessName || !email) return res.status(400).json({ error: 'businessName and email are required' });

    const merchantId = uuidv4();
    const embedKey = crypto.randomBytes(16).toString('hex');

    const account = await stripe.accounts.create({
      type: 'express',
      email,
      business_profile: { name: businessName }
    });

    await pool.query(
      `INSERT INTO merchants (id, business_name, email, embed_key, stripe_account_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [merchantId, businessName, email, embedKey, account.id]
    );

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${process.env.BASE_URL}/merchant/signup.html`,
      return_url: `${process.env.BASE_URL}/api/merchant/stripe/return?merchantId=${merchantId}`,
      type: 'account_onboarding'
    });

    res.json({ success: true, onboardingUrl: accountLink.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/stripe/connect', requireMerchant, async (req, res) => {
  try {
    const accountLink = await stripe.accountLinks.create({
      account: req.merchant.stripe_account_id,
      refresh_url: `${process.env.BASE_URL}/merchant/dashboard.html`,
      return_url: `${process.env.BASE_URL}/api/merchant/stripe/return?merchantId=${req.merchant.id}`,
      type: 'account_onboarding'
    });
    res.json({ onboardingUrl: accountLink.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/stripe/return', async (req, res) => {
  try {
    const { merchantId } = req.query;
    const merchantResult = await pool.query('SELECT * FROM merchants WHERE id = $1', [merchantId]);
    const merchant = merchantResult.rows[0];
    if (!merchant) return res.status(404).send('Merchant not found');

    const account = await stripe.accounts.retrieve(merchant.stripe_account_id);
    if (account.charges_enabled) {
      await pool.query('UPDATE merchants SET stripe_onboarding_complete = true WHERE id = $1', [merchantId]);
    }

    res.redirect('/merchant/dashboard.html');
  } catch (err) { res.status(500).send(err.message); }
});

router.post('/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const merchantResult = await pool.query('SELECT * FROM merchants WHERE email = $1', [email]);
    const merchant = merchantResult.rows[0];

    if (merchant) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await pool.query(
        'INSERT INTO merchant_login_links (token, merchant_id, expires_at) VALUES ($1, $2, $3)',
        [token, merchant.id, expiresAt]
      );
      const loginUrl = `${process.env.BASE_URL}/api/merchant/login/callback?token=${token}`;
      await sendMerchantLoginLink({ to: email, loginUrl });
    }

    res.json({ success: true, message: 'If that email has an account, a login link has been sent.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/login/callback', async (req, res) => {
  try {
    const { token } = req.query;
    const linkResult = await pool.query(
      'SELECT * FROM merchant_login_links WHERE token = $1 AND used = false AND expires_at > now()',
      [token]
    );
    const link = linkResult.rows[0];
    if (!link) return res.status(400).send('This login link is invalid or has expired.');

    await pool.query('UPDATE merchant_login_links SET used = true WHERE token = $1', [token]);

    const sessionToken = await createSession(link.merchant_id);
    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000
    });
    res.redirect('/merchant/dashboard.html');
  } catch (err) { res.status(500).send(err.message); }
});

router.post('/logout', requireMerchant, async (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ success: true });
});

router.get('/me', requireMerchant, async (req, res) => {
  res.json({
    businessName: req.merchant.business_name,
    email: req.merchant.email,
    embedKey: req.merchant.embed_key,
    stripeOnboardingComplete: req.merchant.stripe_onboarding_complete
  });
});

router.get('/bookings', requireMerchant, async (req, res) => {
  try {
    const bookingsResult = await pool.query(
      'SELECT * FROM bookings WHERE merchant_id = $1 ORDER BY created_at DESC',
      [req.merchant.id]
    );
    const bookings = [];
    for (const b of bookingsResult.rows) {
      const countResult = await pool.query('SELECT count(*) FROM members WHERE booking_id = $1 AND paid = true', [b.id]);
      bookings.push({
        bookingId: b.id,
        propertyName: b.property_name,
        totalAmount: b.total_amount / 100,
        shareAmount: b.share_amount / 100,
        groupSize: b.group_size,
        paidCount: parseInt(countResult.rows[0].count, 10),
        status: b.status,
        createdAt: b.created_at
      });
    }
    res.json({ bookings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/bookings/:bookingId/mark-unavailable', requireMerchant, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1 AND merchant_id = $2', [bookingId, req.merchant.id]);
    if (!bookingResult.rows[0]) return res.status(404).json({ error: 'Booking not found' });
    if (bookingResult.rows[0].status !== 'pending') return res.status(400).json({ error: 'Booking is not pending' });

    await cancelBooking(bookingId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
