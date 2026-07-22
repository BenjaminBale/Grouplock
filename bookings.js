const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('./db');
const { sendBookingCancelled, sendBookingConfirmed } = require('./email');

const FEE_RATE = 0.015;

async function acceptBooking(bookingId) {
  const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  const booking = bookingResult.rows[0];
  if (!booking) throw new Error('Booking not found');
  if (!booking.merchant_id) throw new Error('Booking has no merchant');

  const merchantResult = await pool.query('SELECT * FROM merchants WHERE id = $1', [booking.merchant_id]);
  const merchant = merchantResult.rows[0];
  if (!merchant || !merchant.stripe_account_id) throw new Error('Merchant not found or not connected to Stripe');

  const payoutAmount = Math.round(booking.total_amount * (1 - FEE_RATE));
  await stripe.transfers.create({
    amount: payoutAmount,
    currency: booking.currency,
    destination: merchant.stripe_account_id,
    description: `Grouple payout: ${booking.property_name}`
  });

  await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', ['complete', bookingId]);

  const membersResult = await pool.query('SELECT * FROM members WHERE booking_id = $1', [bookingId]);
  for (const member of membersResult.rows) {
    if (member.email) {
      sendBookingConfirmed({ to: member.email, propertyName: booking.property_name })
        .catch(err => console.error('Failed to send confirmation email:', err.message));
    }
  }

  return booking;
}

async function cancelBooking(bookingId) {
  const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  const booking = bookingResult.rows[0];
  if (!booking) throw new Error('Booking not found');

  const membersResult = await pool.query('SELECT * FROM members WHERE booking_id = $1', [bookingId]);

  for (const member of membersResult.rows) {
    if (member.paid && member.payment_intent_id) {
      await stripe.refunds.create({ payment_intent: member.payment_intent_id });
    }
  }

  await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', ['cancelled', bookingId]);

  for (const member of membersResult.rows) {
    if (member.email) {
      sendBookingCancelled({ to: member.email, propertyName: booking.property_name, wasPaid: member.paid })
        .catch(err => console.error('Failed to send cancellation email:', err.message));
    }
  }

  return booking;
}

async function sweepExpiredApprovals() {
  const expiredResult = await pool.query(
    `SELECT id FROM bookings
     WHERE status = 'awaiting_merchant_approval'
     AND awaiting_since + (merchant_response_hours || ' hours')::interval < now()`
  );
  for (const row of expiredResult.rows) {
    try {
      console.log(`Auto-refunding expired approval window for booking ${row.id}`);
      await cancelBooking(row.id);
    } catch (err) {
      console.error(`Failed to auto-refund booking ${row.id}:`, err.message);
    }
  }
}

module.exports = { cancelBooking, acceptBooking, sweepExpiredApprovals };
