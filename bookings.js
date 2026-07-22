const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('./db');
const { sendBookingCancelled } = require('./email');

async function cancelBooking(bookingId) {
  const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  const booking = bookingResult.rows[0];
  if (!booking) throw new Error('Booking not found');

  const membersResult = await pool.query('SELECT * FROM members WHERE booking_id = $1', [bookingId]);
  const hasMerchant = !!booking.merchant_id;

  for (const member of membersResult.rows) {
    if (member.paid && member.payment_intent_id) {
      const refundParams = { payment_intent: member.payment_intent_id };
      if (hasMerchant) {
        refundParams.reverse_transfer = true;
        refundParams.refund_application_fee = true;
      }
      await stripe.refunds.create(refundParams);
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

module.exports = { cancelBooking };
