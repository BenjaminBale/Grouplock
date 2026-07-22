require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { pool, initDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

app.post('/api/booking/create', async (req, res) => {
  try {
    const { propertyName, totalAmount, groupSize, currency = 'gbp' } = req.body;
    const bookingId = uuidv4();
    const shareAmount = Math.round(totalAmount / groupSize);

    await pool.query(
      `INSERT INTO bookings (id, property_name, total_amount, share_amount, currency, group_size, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [bookingId, propertyName, totalAmount, shareAmount, currency, groupSize]
    );

    const members = [];
    for (let i = 0; i < groupSize; i++) {
      const memberId = uuidv4();
      const name = i === 0 ? 'Organiser' : null;
      await pool.query(
        `INSERT INTO members (id, booking_id, slot, name) VALUES ($1, $2, $3, $4)`,
        [memberId, bookingId, i + 1, name]
      );
      members.push({ memberId, slot: i + 1 });
    }

    console.log(`Created: ${bookingId} - ${propertyName} - ${groupSize} people`);
    res.json({ success: true, bookingId, shareAmount: shareAmount / 100, members });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/booking/:id', async (req, res) => {
  try {
    const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    const b = bookingResult.rows[0];
    if (!b) return res.status(404).json({ error: 'Not found' });

    const membersResult = await pool.query(
      'SELECT id AS "memberId", name, paid, paid_at AS "paidAt" FROM members WHERE booking_id = $1 ORDER BY slot',
      [req.params.id]
    );
    const paidCount = membersResult.rows.filter(m => m.paid).length;

    res.json({
      bookingId: b.id, propertyName: b.property_name,
      totalAmount: b.total_amount / 100, shareAmount: b.share_amount / 100,
      groupSize: b.group_size, paidCount, status: b.status,
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
    const { bookingId, memberId } = req.params;
    const memberResult = await pool.query('SELECT * FROM members WHERE id = $1 AND booking_id = $2', [memberId, bookingId]);
    const member = memberResult.rows[0];
    if (!member) return res.status(404).json({ error: 'Not found' });

    if (member.payment_intent_id && !member.paid) {
      const intent = await stripe.paymentIntents.retrieve(member.payment_intent_id, { expand: ['payment_method'] });
      if (intent.status === 'succeeded') {
        const name = intent.payment_method?.billing_details?.name || member.name || 'Group member';
        await pool.query('UPDATE members SET paid = true, paid_at = now(), name = $1 WHERE id = $2', [name, memberId]);
      }
    }

    const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    const b = bookingResult.rows[0];
    const countResult = await pool.query('SELECT count(*) FROM members WHERE booking_id = $1 AND paid = true', [bookingId]);
    const paidCount = parseInt(countResult.rows[0].count, 10);

    let status = b.status;
    if (paidCount === b.group_size && status !== 'complete') {
      status = 'complete';
      await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, bookingId]);
    }

    res.json({ success: true, paidCount, groupSize: b.group_size, status, allPaid: paidCount === b.group_size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

initDb()
  .then(() => {
    app.listen(process.env.PORT, '0.0.0.0', () => {
      console.log('\n  Grouple MVP running\n  Open: http://localhost:3000\n');
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
