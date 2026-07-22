const sgMail = require('@sendgrid/mail');

const apiKey = process.env.SENDGRID_API_KEY;
const fromEmail = process.env.SENDGRID_FROM_EMAIL;
const fromName = process.env.SENDGRID_FROM_NAME || 'Grouple';

if (apiKey) sgMail.setApiKey(apiKey);

async function send({ to, subject, html }) {
  if (!apiKey || !fromEmail) {
    console.log(`\n[email:dev-mode] Would send to ${to}\nSubject: ${subject}\n${html}\n`);
    return;
  }
  await sgMail.send({ to, from: { email: fromEmail, name: fromName }, subject, html });
}

function wrap(bodyHtml) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;padding:24px;">
    <div style="max-width:480px;margin:0 auto;background:white;border-radius:14px;overflow:hidden;border:1px solid #e0e0e0;">
      <div style="background:#1D9E75;padding:20px 24px;color:white;">
        <div style="font-size:16px;font-weight:600;">Grouple</div>
      </div>
      <div style="padding:22px 24px;color:#222;font-size:14px;line-height:1.6;">
        ${bodyHtml}
      </div>
    </div>
  </div>`;
}

async function sendOrganiserWelcome({ to, propertyName, dashboardUrl, groupSize, shareAmount, currency }) {
  const amount = (shareAmount / 100).toFixed(2);
  await send({
    to,
    subject: `Your Grouple booking for ${propertyName} is set up`,
    html: wrap(`
      <p>Your group booking for <strong>${propertyName}</strong> is ready.</p>
      <p>Each of your ${groupSize} guests pays their own share of ${currency.toUpperCase()} ${amount}. The booking confirms automatically once everyone has paid.</p>
      <p><a href="${dashboardUrl}" style="display:inline-block;background:#1D9E75;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;">View your dashboard</a></p>
      <p style="color:#888;font-size:12px;">Use the dashboard to send each guest their personal payment link.</p>
    `)
  });
}

async function sendMemberInvite({ to, propertyName, payUrl, shareAmount, currency }) {
  const amount = (shareAmount / 100).toFixed(2);
  await send({
    to,
    subject: `You're invited to pay your share for ${propertyName}`,
    html: wrap(`
      <p>You've been invited to a group booking for <strong>${propertyName}</strong>.</p>
      <p>Your share is ${currency.toUpperCase()} ${amount}. Payment is held securely and refunded automatically if the group doesn't complete.</p>
      <p><a href="${payUrl}" style="display:inline-block;background:#1D9E75;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;">Pay your share</a></p>
    `)
  });
}

async function sendBookingConfirmed({ to, propertyName }) {
  await send({
    to,
    subject: `Booking confirmed — ${propertyName}`,
    html: wrap(`
      <p>Good news — everyone in your group has paid.</p>
      <p><strong>${propertyName}</strong> is now booked and confirmed.</p>
    `)
  });
}

async function sendBookingCancelled({ to, propertyName, wasPaid }) {
  await send({
    to,
    subject: `Booking cancelled — ${propertyName}`,
    html: wrap(`
      <p><strong>${propertyName}</strong> is no longer available, so this group booking has been cancelled.</p>
      ${wasPaid ? '<p>Your payment has been refunded automatically — it should appear back on your card within a few business days.</p>' : '<p>No payment was taken from you.</p>'}
    `)
  });
}

async function sendMerchantApprovalNeeded({ to, propertyName, totalAmount, currency, deadline, dashboardUrl }) {
  const amount = (totalAmount / 100).toFixed(2);
  await send({
    to,
    subject: `Action needed: confirm availability for ${propertyName}`,
    html: wrap(`
      <p>Everyone in the group has paid for <strong>${propertyName}</strong> — ${currency.toUpperCase()} ${amount} collected.</p>
      <p>Please confirm whether this property is still available. If you accept, the funds transfer to your account. If you deny, guests are refunded automatically.</p>
      <p><a href="${dashboardUrl}" style="display:inline-block;background:#1D9E75;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;">Review and respond</a></p>
      <p style="color:#888;font-size:12px;">If we don't hear back by ${deadline}, guests will be refunded automatically.</p>
    `)
  });
}

async function sendMerchantLoginLink({ to, loginUrl }) {
  await send({
    to,
    subject: 'Your Grouple dashboard login link',
    html: wrap(`
      <p>Click below to log in to your Grouple merchant dashboard.</p>
      <p><a href="${loginUrl}" style="display:inline-block;background:#1D9E75;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;">Log in to Grouple</a></p>
      <p style="color:#888;font-size:12px;">This link expires in 15 minutes. If you didn't request it, you can ignore this email.</p>
    `)
  });
}

module.exports = { sendOrganiserWelcome, sendMemberInvite, sendBookingConfirmed, sendBookingCancelled, sendMerchantLoginLink, sendMerchantApprovalNeeded };
