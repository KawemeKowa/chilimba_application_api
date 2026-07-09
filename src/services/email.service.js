const nodemailer = require('nodemailer');
const logger = require('../config/logger');

// ─── Transport ───────────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host:   process.env.MAIL_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.MAIL_PORT) || 587,
  secure: process.env.MAIL_SECURE === 'true',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

const FROM = process.env.MAIL_FROM || 'Chilimba <noreply@chilimba.app>';
const APP_URL = (process.env.FRONTEND_URL || 'http://localhost:3001').split(',')[0].trim();

// ─── Base layout ─────────────────────────────────────────────────────────────

function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background:#1e1b4b;border-radius:12px 12px 0 0;padding:32px 40px;text-align:center;">
            <div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
              🌀 Chilimba
            </div>
            <div style="font-size:13px;color:#a5b4fc;margin-top:4px;">
              Digital Village Banking
            </div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#ffffff;padding:40px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
            ${bodyHtml}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:0 0 12px 12px;
                     padding:24px 40px;text-align:center;">
            <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
              You're receiving this email because you have a Chilimba account.
            </p>
            <p style="margin:0;font-size:12px;color:#9ca3af;">
              © ${new Date().getFullYear()} Chilimba · Digital Village Banking
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Shared components ────────────────────────────────────────────────────────

const h1 = (text) =>
  `<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1e1b4b;">${text}</h1>`;

const p = (text) =>
  `<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">${text}</p>`;

const divider = () =>
  `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>`;

const badge = (label, color = '#1e1b4b') =>
  `<span style="display:inline-block;background:${color};color:#fff;font-size:12px;
    font-weight:600;padding:3px 10px;border-radius:99px;">${label}</span>`;

const infoBox = (rows) => {
  const cells = rows.map(([k, v]) =>
    `<tr>
      <td style="padding:8px 12px;font-size:13px;color:#6b7280;width:45%;border-bottom:1px solid #f3f4f6;">${k}</td>
      <td style="padding:8px 12px;font-size:13px;color:#111827;font-weight:600;border-bottom:1px solid #f3f4f6;">${v}</td>
    </tr>`
  ).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0"
    style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin:20px 0;">
    ${cells}
  </table>`;
};

const btn = (text, url, color = '#4f46e5') =>
  `<div style="text-align:center;margin:28px 0;">
    <a href="${url}" style="display:inline-block;background:${color};color:#ffffff;
      font-size:15px;font-weight:600;text-decoration:none;padding:13px 32px;
      border-radius:8px;">${text}</a>
  </div>`;

// ─── Send helper — fire-and-forget, never throws ──────────────────────────────

async function send(to, subject, html) {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS ||
      process.env.MAIL_USER === 'your@gmail.com') {
    logger.warn(`[email] SMTP not configured — skipping email to ${to}`);
    return;
  }
  try {
    await transporter.sendMail({ from: FROM, to, subject, html });
    logger.info(`[email] Sent "${subject}" → ${to}`);
  } catch (err) {
    logger.error(`[email] Failed to send "${subject}" → ${to}: ${err.message}`);
  }
}

// ─── 1. Welcome ───────────────────────────────────────────────────────────────

async function sendWelcome(user) {
  const html = layout('Welcome to Chilimba', `
    ${h1(`Welcome, ${user.first_name}! 🎉`)}
    ${p('Your Chilimba account is ready. You\'re now part of a community built on trust, savings, and mutual support.')}
    ${infoBox([
      ['Name',   `${user.first_name} ${user.last_name}`],
      ['Email',  user.email],
      ['Status', 'Pending KYC verification'],
    ])}
    ${p('To start contributing and joining groups, complete your KYC verification by visiting your profile.')}
    ${btn('Go to Dashboard', `${APP_URL}/dashboard`)}
    ${divider()}
    ${p('<small style="color:#6b7280;">If you didn\'t create this account, please ignore this email.</small>')}
  `);
  await send(user.email, 'Welcome to Chilimba 🌀', html);
}

// ─── 2. Password changed ──────────────────────────────────────────────────────

async function sendPasswordChanged(user) {
  const html = layout('Password Changed', `
    ${h1('Password Updated 🔐')}
    ${p(`Hi ${user.first_name}, your Chilimba account password was just changed.`)}
    ${p('All existing sessions have been logged out for your security.')}
    ${infoBox([
      ['Account', user.email],
      ['Changed', new Date().toUTCString()],
    ])}
    ${p('<strong>If you did not do this</strong>, your account may be compromised. Contact support immediately.')}
    ${btn('Secure My Account', `${APP_URL}/login`, '#dc2626')}
  `);
  await send(user.email, 'Your Chilimba password was changed', html);
}

// ─── 3. Group created ─────────────────────────────────────────────────────────

async function sendGroupCreated(user, group) {
  const html = layout('Group Created', `
    ${h1('Your group is live! 🚀')}
    ${p(`Hi ${user.first_name}, you've successfully created a new Chilimba group.`)}
    ${infoBox([
      ['Group',        group.name],
      ['Monthly Due',  `ZMW ${group.monthly_amount}`],
      ['Payout Day',   `${group.payout_day}th of each month`],
      ['Max Members',  group.max_members],
      ['Invite Code',  group.invite_code],
    ])}
    ${p('Share your invite code with members. It\'s unique to your group and can be rotated at any time.')}
    ${btn('View My Group', `${APP_URL}/groups/${group.id}`)}
  `);
  await send(user.email, `Group "${group.name}" created successfully`, html);
}

// ─── 4. Member joined ─────────────────────────────────────────────────────────

async function sendMemberJoined(adminEmail, adminName, joiner, group) {
  const html = layout('New Member Joined', `
    ${h1('New member joined your group 👥')}
    ${p(`Hi ${adminName}, a new member has joined <strong>${group.name}</strong>.`)}
    ${infoBox([
      ['Member',  `${joiner.first_name} ${joiner.last_name}`],
      ['Email',   joiner.email],
      ['Group',   group.name],
      ['Joined',  new Date().toUTCString()],
    ])}
    ${btn('View Group', `${APP_URL}/groups/${group.id}`)}
  `);
  await send(adminEmail, `New member joined ${group.name}`, html);
}

// ─── 5. Joined confirmation (to the joiner) ───────────────────────────────────

async function sendJoinedGroup(user, group) {
  const html = layout('You joined a group', `
    ${h1(`You're in! 🎊`)}
    ${p(`Hi ${user.first_name}, you've successfully joined <strong>${group.name}</strong>.`)}
    ${infoBox([
      ['Group',       group.name],
      ['Monthly Due', `ZMW ${group.monthly_amount}`],
      ['Due Date',    `${group.contribution_day}${ordinal(group.contribution_day)} of each month`],
      ['Payout Day',  `${group.payout_day}${ordinal(group.payout_day)} of each month`],
    ])}
    ${p('Make sure you contribute on time every month to keep your rotation spot.')}
    ${btn('View Group', `${APP_URL}/groups/${group.id}`)}
  `);
  await send(user.email, `You joined ${group.name}`, html);
}

// ─── 6. Member removed ────────────────────────────────────────────────────────

async function sendMemberRemoved(user, group) {
  const html = layout('Removed from Group', `
    ${h1('You\'ve been removed from a group')}
    ${p(`Hi ${user.first_name}, you have been removed from the Chilimba group <strong>${group.name}</strong>.`)}
    ${infoBox([
      ['Group',   group.name],
      ['Date',    new Date().toUTCString()],
    ])}
    ${p('If you believe this was a mistake, please contact your group admin.')}
    ${btn('View My Groups', `${APP_URL}/groups`)}
  `);
  await send(user.email, `You were removed from ${group.name}`, html);
}

// ─── 7. Contribution paid ─────────────────────────────────────────────────────

async function sendContributionPaid(user, contribution, group) {
  const html = layout('Contribution Confirmed', `
    ${h1('Contribution received ✅')}
    ${p(`Hi ${user.first_name}, your contribution for <strong>${group.name}</strong> has been recorded.`)}
    ${infoBox([
      ['Group',      group.name],
      ['Cycle',      `Cycle ${contribution.cycle_number} · Round ${contribution.round_number}`],
      ['Amount',     `ZMW ${contribution.amount_due}`],
      ['Fee',        `ZMW ${contribution.fee_charged || '0.00'}`],
      ['Reference',  contribution.reference || '—'],
      ['Date',       new Date().toUTCString()],
    ])}
    ${p('Your contribution has been added to your group\'s wallet. Keep it up!')}
    ${btn('View Contributions', `${APP_URL}/contributions`)}
  `);
  await send(user.email, `Contribution confirmed — ${group.name}`, html);
}

// ─── 8. Withdrawal requested — alert members to vote ─────────────────────────

async function sendWithdrawalRequested(memberEmail, memberName, requester, withdrawal, group) {
  const html = layout('Withdrawal Vote Needed', `
    ${h1('Your vote is needed 🗳️')}
    ${p(`Hi ${memberName}, <strong>${requester.first_name} ${requester.last_name}</strong> has requested a withdrawal from <strong>${group.name}</strong>.`)}
    ${infoBox([
      ['Group',     group.name],
      ['Amount',    `ZMW ${withdrawal.amount}`],
      ['Reason',    withdrawal.reason],
      ['Expires',   new Date(withdrawal.expires_at).toUTCString()],
      ['Approvals', `${withdrawal.approvals_needed} needed`],
    ])}
    ${p('Log in to approve or reject this request before it expires.')}
    ${btn('Vote Now', `${APP_URL}/groups/${group.id}/withdrawals`)}
  `);
  await send(memberEmail, `Vote needed: ZMW ${withdrawal.amount} withdrawal in ${group.name}`, html);
}

// ─── 9. Withdrawal outcome — notify requester ─────────────────────────────────

async function sendWithdrawalOutcome(user, withdrawal, outcome, group) {
  const approved = outcome === 'approved';
  const html = layout(`Withdrawal ${approved ? 'Approved' : 'Rejected'}`, `
    ${h1(approved ? 'Withdrawal Approved ✅' : 'Withdrawal Rejected ❌')}
    ${p(`Hi ${user.first_name}, your withdrawal request in <strong>${group.name}</strong> has been <strong>${outcome}</strong>.`)}
    ${infoBox([
      ['Group',   group.name],
      ['Amount',  `ZMW ${withdrawal.amount}`],
      ['Reason',  withdrawal.reason],
      ['Status',  badge(outcome.toUpperCase(), approved ? '#16a34a' : '#dc2626')],
      ['Date',    new Date().toUTCString()],
    ])}
    ${approved
      ? p('The funds will be processed and disbursed by the platform admin shortly.')
      : p('You may submit a new withdrawal request once the current one is resolved.')}
    ${btn('View Withdrawals', `${APP_URL}/groups/${group.id}/withdrawals`)}
  `);
  await send(
    user.email,
    `Withdrawal ${outcome} — ${group.name}`,
    html
  );
}

// ─── 10. Payout disbursed ────────────────────────────────────────────────────

async function sendPayoutDisbursed(user, payout, group) {
  const html = layout('Payout Disbursed', `
    ${h1('Your payout has arrived! 💰')}
    ${p(`Hi ${user.first_name}, your Chilimba payout from <strong>${group.name}</strong> has been disbursed.`)}
    ${infoBox([
      ['Group',   group.name],
      ['Cycle',   `Cycle ${payout.cycle_number}`],
      ['Amount',  `ZMW ${payout.actual_amount || payout.expected_amount}`],
      ['Date',    new Date().toUTCString()],
    ])}
    ${p('The funds have been credited to your Chilimba wallet. Well done on keeping up with contributions!')}
    ${btn('View Wallet', `${APP_URL}/wallet`)}
  `);
  await send(user.email, `Payout disbursed — ZMW ${payout.actual_amount || payout.expected_amount} from ${group.name}`, html);
}

// ─── 11. KYC verified ────────────────────────────────────────────────────────

async function sendAccountVerified(user) {
  const html = layout('Account Verified', `
    ${h1('Your account is verified! 🎉')}
    ${p(`Hi ${user.first_name}, your identity has been verified and your Chilimba account is now fully active.`)}
    ${infoBox([
      ['Name',   `${user.first_name} ${user.last_name}`],
      ['Email',  user.email],
      ['Status', badge('VERIFIED', '#16a34a')],
    ])}
    ${p('You can now join groups, make contributions, and participate in committee pools.')}
    ${btn('Go to Dashboard', `${APP_URL}/dashboard`)}
  `);
  await send(user.email, 'Your Chilimba account is verified ✅', html);
}

// ─── 12. Account status change (suspended / banned) ──────────────────────────

async function sendAccountStatusChanged(user, status, reason) {
  const suspended = status === 'suspended';
  const html = layout(`Account ${suspended ? 'Suspended' : 'Banned'}`, `
    ${h1(`Account ${suspended ? 'Suspended' : 'Banned'} ⚠️`)}
    ${p(`Hi ${user.first_name}, your Chilimba account has been <strong>${status}</strong>.`)}
    ${infoBox([
      ['Account', user.email],
      ['Status',  badge(status.toUpperCase(), '#dc2626')],
      ['Reason',  reason || 'Policy violation'],
      ['Date',    new Date().toUTCString()],
    ])}
    ${suspended
      ? p('Your account has been temporarily suspended. Contact support to appeal this decision.')
      : p('Your account has been permanently banned. If you believe this is an error, contact support.')}
  `);
  await send(user.email, `Your Chilimba account has been ${status}`, html);
}

// ─── 13. Committee pool created — alert group members ────────────────────────

async function sendCommitteePoolCreated(memberEmail, memberName, pool, group, creator) {
  const html = layout('New Committee Pool', `
    ${h1('New campaign in your group 🤝')}
    ${p(`Hi ${memberName}, <strong>${creator.first_name} ${creator.last_name}</strong> has started a new committee pool in <strong>${group.name}</strong>.`)}
    ${infoBox([
      ['Title',       pool.title],
      ['Category',    badge(pool.category.toUpperCase(), categoryColor(pool.category))],
      ['Goal',        pool.target_amount ? `ZMW ${pool.target_amount}` : 'Open-ended'],
      ['Beneficiary', pool.beneficiary || '—'],
      ['Closes',      pool.closes_at ? new Date(pool.closes_at).toUTCString() : 'Until closed'],
    ])}
    ${p(pool.description)}
    ${btn('Contribute Now', `${APP_URL}/groups/${group.id}/committees/${pool.id}`)}
  `);
  await send(memberEmail, `New committee pool: "${pool.title}" in ${group.name}`, html);
}

// ─── 14. Password reset ───────────────────────────────────────────────────────

async function sendPasswordReset(user, token) {
  const resetLink = `${APP_URL}/auth/reset-password/${token}`;
  const html = layout('Reset Your Password', `
    ${h1('Reset your password 🔑')}
    ${p(`Hi ${user.first_name}, we received a request to reset your Chilimba account password.`)}
    ${p('Click the button below. The link expires in <strong>1 hour</strong>.')}
    ${btn('Reset Password', resetLink)}
    ${divider()}
    ${p('If you didn\'t request a password reset, you can safely ignore this email — your password will not change.')}
    ${p(`<small style="color:#9ca3af">Or copy this link into your browser:<br/>${resetLink}</small>`)}
  `);
  await send(user.email, 'Reset your Chilimba password', html);
}

// ─── 15. Group email invitation ───────────────────────────────────────────────

async function sendGroupInvitation(inviterUser, inviteeEmail, group, inviteToken) {
  const acceptLink = `${APP_URL}/invitations/${inviteToken}`;
  const html = layout('You\'ve been invited to join a Chilimba group', `
    ${h1('You\'re invited to join a savings group 🎉')}
    ${p(`<strong>${inviterUser.first_name} ${inviterUser.last_name}</strong> has invited you to join their Chilimba savings group.`)}
    ${infoBox([
      ['Group',          group.name],
      ['Monthly Amount', `ZMW ${group.monthly_amount}`],
      ['Max Members',    group.max_members],
      ['Payout Day',     `${group.payout_day}th of each month`],
    ])}
    ${group.description ? p(group.description) : ''}
    ${btn('Accept Invitation', acceptLink)}
    ${p('This invitation expires in <strong>7 days</strong>. If you did not expect this email you can safely ignore it.')}
    ${p(`<small style="color:#9ca3af">Or copy this link: ${acceptLink}</small>`)}
  `);
  await send(inviteeEmail, `${inviterUser.first_name} invited you to join "${group.name}" on Chilimba`, html);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function categoryColor(cat) {
  const map = { funeral: '#6b7280', wedding: '#db2777', emergency: '#dc2626', other: '#4f46e5' };
  return map[cat] || '#4f46e5';
}

module.exports = {
  sendWelcome,
  sendPasswordReset,
  sendPasswordChanged,
  sendGroupCreated,
  sendMemberJoined,
  sendJoinedGroup,
  sendMemberRemoved,
  sendContributionPaid,
  sendWithdrawalRequested,
  sendWithdrawalOutcome,
  sendPayoutDisbursed,
  sendAccountVerified,
  sendAccountStatusChanged,
  sendCommitteePoolCreated,
  sendGroupInvitation,
};
