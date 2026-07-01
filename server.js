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
      email: null, paid: false, paymentIntentId: null, paidAt: null
    }));
    bookings[bookingId] = {
      bookingId, propertyName, totalAmount, shareAmount,
      currency, groupSize, status: 'pending', members, paidCount: 0
    };
    console.log(`Created: ${bookingId} - ${propertyName} - ${groupSize} people - £${totalAmount/100}`);
    res.json({
      success: true, bookingId,
      shareAmount: shareAmount / 100,
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
    members: b.members.map(m => ({
      memberId: m.memberId, name: m.name, paid: m.paid, paidAt: m.paidAt
    }))
  });
});

// Payment Element route - creates a PaymentIntent
app.post('/api/booking/:bookingId/pay/:memberId', async (req, res) => {
  try {
    const { bookingId, memberId } = req.params;
    const { name, email } = req.body;
    const b = bookings[bookingId];
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.status !== 'pending') return res.status(400).json({ error: `Booking is ${b.status}` });
    const member = b.members.find(m => m.memberId === memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (member.paid) return res.status(400).json({ error: 'Already paid' });

    member.name = name || 'Group member';
    member.email = email;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: b.shareAmount,
      currency: b.currency,
      automatic_payment_methods: { enabled: true },
      metadata: { bookingId, memberId, propertyName: b.propertyName }
    });

    member.paymentIntentId = paymentIntent.id;
    console.log(`PaymentIntent created: ${paymentIntent.id} for ${member.name}`);

    res.json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      amount: b.shareAmount / 100,
      currency: b.currency,
      propertyName: b.propertyName,
      groupSize: b.groupSize
    });
  } catch (err) {
    console.error('Pay error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Confirm payment after Payment Element succeeds
app.post('/api/booking/:bookingId/confirm/:memberId', async (req, res) => {
  try {
    const { bookingId, memberId } = req.params;
    const b = bookings[bookingId];
    if (!b) return res.status(404).json({ error: 'Not found' });
    const member = b.members.find(m => m.memberId === memberId);
    if (!member) return res.status(404).json({ error: 'Not found' });

    if (member.paymentIntentId && !member.paid) {
      const pi = await stripe.paymentIntents.retrieve(member.paymentIntentId);
      if (pi.status === 'succeeded') {
        member.paid = true;
        member.paidAt = new Date();
        b.paidCount = b.members.filter(m => m.paid).length;
        console.log(`Confirmed: ${member.name} - ${b.paidCount}/${b.groupSize}`);
        if (b.paidCount === b.groupSize) {
          b.status = 'complete';
          console.log(`ALL PAID: ${bookingId} - release £${b.totalAmount/100} to hotel`);
        }
      }
    }

    res.json({
      success: true, paidCount: b.paidCount,
      groupSize: b.groupSize, status: b.status,
      allPaid: b.paidCount === b.groupSize
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(process.env.PORT, '0.0.0.0', () => {
  console.log('\n  Grouple MVP running\n  Open: http://localhost:3000\n');
});
