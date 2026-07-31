require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { pool, initDb } = require('./db');
const { sendOrganiserWelcome, sendMemberInvite } = require('./email');
const { sweepExpiredApprovals, confirmMemberPayment } = require('./bookings');
const merchantRoutes = require('./routes/merchant');
const guestRoutes = require('./routes/guest');

const app = express();
app.use(cors());
app.use(express.static('public'));

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const { bookingId, memberId } = intent.metadata || {};
    if (bookingId && memberId) {
      try {
        await confirmMemberPayment(bookingId, memberId);
      } catch (err) {
        console.error(`Webhook failed to confirm payment for ${bookingId}/${memberId}:`, err.message);
      }
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(cookieParser());
app.use('/api/merchant', merchantRoutes);
app.use('/api/guest', guestRoutes);

app.post('/api/booking/create', async (req, res) => {
  try {
    const { propertyName, totalAmount, groupSize, currency = 'gbp', organiserEmail, merchantKey, merchantResponseHours = 48 } = req.body;
    const bookingId = uuidv4();
    const shareAmount = Math.round(totalAmount / groupSize);

    let merchantId = null;
    if (merchantKey) {
      const merchantResult = await pool.query('SELECT id FROM merchants WHERE embed_key = $1', [merchantKey]);
      merchantId = merchantResult.rows[0]?.id || null;
    }

    await pool.query(
      `INSERT INTO bookings (id, property_name, total_amount, share_amount, currency, group_size, status, merchant_id, merchant_response_hours)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
      [bookingId, propertyName, totalAmount, shareAmount, currency, groupSize, merchantId, merchantResponseHours]
    );

    const members = [];
    for (let i = 0; i < groupSize; i++) {
      const memberId = uuidv4();
      const name = i === 0 ? 'Organiser' : null;
      const email = i === 0 ? (organiserEmail || null) : null;
      await pool.query(
        `INSERT INTO members (id, booking_id, slot, name, email) VALUES ($1, $2, $3, $4, $5)`,
        [memberId, bookingId, i + 1, name, email]
      );
      members.push({ memberId, slot: i + 1 });
    }

    console.log(`Created: ${bookingId} - ${propertyName} - ${groupSize} people`);
    res.json({ success: true, bookingId, shareAmount: shareAmount / 100, members });

    if (organiserEmail) {
      sendOrganiserWelcome({
        to: organiserEmail, propertyName,
        dashboardUrl: `${process.env.BASE_URL}/?booking=${bookingId}`,
        groupSize, shareAmount, currency
      }).catch(err => console.error('Failed to send organiser welcome email:', err.message));
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/booking/:bookingId/members/:memberId/invite', async (req, res) => {
  try {
    const { bookingId, memberId } = req.params;
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    const b = bookingResult.rows[0];
    if (!b) return res.status(404).json({ error: 'Booking not found' });

    const memberResult = await pool.query('SELECT * FROM members WHERE id = $1 AND booking_id = $2', [memberId, bookingId]);
    const member = memberResult.rows[0];
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (member.paid) return res.status(400).json({ error: 'Already paid' });

    await pool.query('UPDATE members SET email = $1 WHERE id = $2', [email, memberId]);

    await sendMemberInvite({
      to: email, propertyName: b.property_name,
      payUrl: `${process.env.BASE_URL}/pay.html?booking=${bookingId}&member=${memberId}`,
      shareAmount: b.share_amount, currency: b.currency
    });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/booking/:id', async (req, res) => {
  try {
    const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    const b = bookingResult.rows[0];
    if (!b) return res.status(404).json({ error: 'Not found' });

    const membersResult = await pool.query(
      'SELECT id AS "memberId", name, email, paid, paid_at AS "paidAt" FROM members WHERE booking_id = $1 ORDER BY slot',
      [req.params.id]
    );
    const paidCount = membersResult.rows.filter(m => m.paid).length;

    res.json({
      bookingId: b.id, propertyName: b.property_name,
      totalAmount: b.total_amount / 100, shareAmount: b.share_amount / 100,
      groupSize: b.group_size, paidCount, status: b.status,
      awaitingSince: b.awaiting_since, merchantResponseHours: b.merchant_response_hours,
      members: membersResult.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/booking/:bookingId/payment-intent/:memberId', async (req, res) => {
  try {
    const { bookingId, memberId } = req.params;
    const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    const b = bookingResult.rows[0];
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.status !== 'pending') return res.status(400).json({ error: 'This booking is no longer available' });

    const memberResult = await pool.query('SELECT * FROM members WHERE id = $1 AND booking_id = $2', [memberId, bookingId]);
    const member = memberResult.rows[0];
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (member.paid) return res.status(400).json({ error: 'Already paid' });

    let intent;
    if (member.payment_intent_id) {
      intent = await stripe.paymentIntents.retrieve(member.payment_intent_id);
      if (intent.status === 'canceled') intent = null;
    }
    if (!intent) {
      intent = await stripe.paymentIntents.create({
        amount: b.share_amount,
        currency: b.currency,
        automatic_payment_methods: { enabled: true },
        description: `Grouple: ${b.property_name} — 1 of ${b.group_size} shares`,
        metadata: { bookingId, memberId }
      });
      await pool.query('UPDATE members SET payment_intent_id = $1 WHERE id = $2', [intent.id, memberId]);
    }

    res.json({
      clientSecret: intent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      amount: b.share_amount,
      currency: b.currency
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/booking/:bookingId/confirm/:memberId', async (req, res) => {
  try {
    const result = await confirmMemberPayment(req.params.bookingId, req.params.memberId);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

initDb()
  .then(() => {
    app.listen(process.env.PORT, '0.0.0.0', () => {
      console.log('\n  Grouple MVP running\n  Open: http://localhost:3000\n');
    });
    setInterval(() => {
      sweepExpiredApprovals().catch(err => console.error('Sweep failed:', err.message));
    }, 15 * 60 * 1000);
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
