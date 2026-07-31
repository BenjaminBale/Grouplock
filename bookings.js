const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('./db');
const { sendBookingCancelled, sendBookingConfirmed, sendMerchantApprovalNeeded } = require('./email');

const FEE_RATE = 0.05;

// Authoritative source of truth for "did this member's payment succeed".
// Called both by the client's post-payment confirm request (fast path, for
// immediate UI feedback) and by the payment_intent.succeeded webhook
// (reliable path, fires from Stripe's servers even if the guest's browser
// never makes it back). Safe to call more than once for the same payment.
async function confirmMemberPayment(bookingId, memberId) {
  const memberResult = await pool.query('SELECT * FROM members WHERE id = $1 AND booking_id = $2', [memberId, bookingId]);
  const member = memberResult.rows[0];
  if (!member) throw new Error('Not found');

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
  if (paidCount === b.group_size && status === 'pending') {
    if (b.merchant_id) {
      status = 'awaiting_merchant_approval';
      const awaitingSince = new Date();
      await pool.query('UPDATE bookings SET status = $1, awaiting_since = $2 WHERE id = $3', [status, awaitingSince, bookingId]);

      const merchantResult = await pool.query('SELECT * FROM merchants WHERE id = $1', [b.merchant_id]);
      const merchant = merchantResult.rows[0];
      if (merchant) {
        const deadline = new Date(awaitingSince.getTime() + b.merchant_response_hours * 60 * 60 * 1000);
        sendMerchantApprovalNeeded({
          to: merchant.email, propertyName: b.property_name,
          totalAmount: b.total_amount, currency: b.currency,
          deadline: deadline.toUTCString(),
          dashboardUrl: `${process.env.BASE_URL}/merchant/dashboard.html`
        }).catch(err => console.error('Failed to send merchant approval email:', err.message));
      }
    } else {
      status = 'complete';
      await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, bookingId]);

      const emailedResult = await pool.query('SELECT email FROM members WHERE booking_id = $1 AND email IS NOT NULL', [bookingId]);
      for (const row of emailedResult.rows) {
        sendBookingConfirmed({ to: row.email, propertyName: b.property_name })
          .catch(err => console.error('Failed to send confirmation email:', err.message));
      }
    }
  }

  return { paidCount, groupSize: b.group_size, status, allPaid: paidCount === b.group_size };
}

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

module.exports = { cancelBooking, acceptBooking, sweepExpiredApprovals, confirmMemberPayment };
