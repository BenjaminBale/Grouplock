require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

const bookings = {};

app.post('/api/booking/create', async (req, res) => {
  try {
    const { propertyName, totalAmount, groupSize, currency = 'gbp' } = req.body;
    const bookingId = uuidv4();
    const shareAmount = Math.round(totalAmount / groupSize);
    const members = Array.from({ length: groupSize }, (_, i) => ({
      memberId: uuidv4(), name: i === 0 ? 'Organiser' : null,
      email: null, paid: false, sessionId: null, paidAt: null
    }));
    bookings[bookingId] = {
      bookingId, propertyName, totalAmount, shareAmount,
      currency, groupSize, status: 'pending', members, paidCount: 0
    };
    console.log(`Created: ${bookingId} - ${propertyName} - ${groupSize} people`);
    res.json({
      success: true, bookingId, shareAmount: shareAmount / 100,
      members: members.map((m, i) => ({ memberId: m.memberId, slot: i + 1 }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/booking/:id', (req, res) => {
  const b = bookings[req.params.id];
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json({
    bookingId: b.bookingId, propertyName: b.propertyName,
    totalAmount: b.totalAmount / 100, shareAmount: b.shareAmount / 100,
    groupSize: b.groupSize, paidCount: b.members.filter(m => m.paid).length,
    status: b.status,
    members: b.members.map(m => ({ memberId: m.memberId, name: m.name, paid: m.paid, paidAt: m.paidAt }))
  });
});

app.post('/api/booking/:bookingId/payment-intent/:memberId', async (req, res) => {
  try {
    const { bookingId, memberId } = req.params;
    const b = bookings[bookingId];
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    const member = b.members.find(m => m.memberId === memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (member.paid) return res.status(400).json({ error: 'Already paid' });

    let intent;
    if (member.paymentIntentId) {
      intent = await stripe.paymentIntents.retrieve(member.paymentIntentId);
      if (intent.status === 'canceled') intent = null;
    }
    if (!intent) {
      intent = await stripe.paymentIntents.create({
        amount: b.shareAmount,
        currency: b.currency,
        automatic_payment_methods: { enabled: true },
        description: `Grouple: ${b.propertyName} — 1 of ${b.groupSize} shares`,
        metadata: { bookingId, memberId }
      });
      member.paymentIntentId = intent.id;
    }

    res.json({
      clientSecret: intent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      amount: b.shareAmount,
      currency: b.currency
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/booking/:bookingId/confirm/:memberId', async (req, res) => {
  try {
    const { bookingId, memberId } = req.params;
    const b = bookings[bookingId];
    if (!b) return res.status(404).json({ error: 'Not found' });
    const member = b.members.find(m => m.memberId === memberId);
    if (!member) return res.status(404).json({ error: 'Not found' });
    if (member.paymentIntentId && !member.paid) {
      const intent = await stripe.paymentIntents.retrieve(member.paymentIntentId, { expand: ['payment_method'] });
      if (intent.status === 'succeeded') {
        member.paid = true;
        member.paidAt = new Date();
        member.name = intent.payment_method?.billing_details?.name || member.name || 'Group member';
        b.paidCount = b.members.filter(m => m.paid).length;
        if (b.paidCount === b.groupSize) { b.status = 'complete'; }
      }
    }
    res.json({ success: true, paidCount: b.paidCount, groupSize: b.groupSize, status: b.status, allPaid: b.paidCount === b.groupSize });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(process.env.PORT, '0.0.0.0', () => {
  console.log('\n  Grouple MVP running\n  Open: http://localhost:3000\n');
});
