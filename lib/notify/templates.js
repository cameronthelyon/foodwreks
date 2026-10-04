// Message copy. Every template returns { subject, text, html, sms } and
// escapes every value that came from a diner or a restaurant.

import { fmt12, fmtDateLong, weekdayOf } from '../time.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortWhen(date, minutes) {
  const [, m, d] = date.split('-').map(Number);
  return `${DAYS[weekdayOf(date)]} ${MONTHS[m - 1]} ${d}, ${fmt12(minutes)}`;
}

const guests = (n) => `${n} ${n === 1 ? 'guest' : 'guests'}`;
const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || 'there';

function layout({ preheader, heading, paragraphs, actions = [], restaurant, brand, accent = '#9C2F22' }) {
  const p = paragraphs
    .filter(Boolean)
    .map((t) => `<p style="margin:0 0 14px;line-height:1.5">${esc(t).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const buttons = actions
    .map(
      (a) =>
        `<a href="${esc(a.href)}" style="display:inline-block;margin:4px 8px 4px 0;padding:10px 16px;border-radius:6px;` +
        `background:${a.primary ? esc(accent) : '#ffffff'};color:${a.primary ? '#ffffff' : esc(accent)};` +
        `border:1px solid ${esc(accent)};text-decoration:none;font-weight:600">${esc(a.label)}</a>`,
    )
    .join('');
  const contact = [restaurant.address, restaurant.phone].filter(Boolean).map(esc).join(' &middot; ');
  return `<!doctype html><html><body style="margin:0;background:#f6f3ee;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f1b16">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:10px;border:1px solid #e7e0d5">
<tr><td style="padding:22px 24px 6px;border-bottom:3px solid ${esc(accent)}">
<div style="font-family:Georgia,serif;font-size:20px;font-weight:700">${esc(restaurant.name)}</div></td></tr>
<tr><td style="padding:20px 24px 8px">
<h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 14px">${esc(heading)}</h1>
${p}${buttons ? `<div style="margin:6px 0 10px">${buttons}</div>` : ''}
</td></tr>
<tr><td style="padding:12px 24px 20px;font-size:12px;color:#6b6257">${contact}</td></tr>
</table>
<div style="font-size:11px;color:#8a8175;padding:12px">Booked with ${esc(brand)}, reservations restaurants own.</div>
</td></tr></table></body></html>`;
}

function details(row) {
  const lines = [`${guests(row.party_size)}, ${fmtDateLong(row.date)} at ${fmt12(row.start_min)}`];
  if (row.occasion) lines.push(`Occasion: ${row.occasion}`);
  if (row.guest_notes) lines.push(`Your note: ${row.guest_notes}`);
  return lines.join('\n');
}

export function reservationTemplate(kind, { restaurant, row, settings, links, brand, extra = {} }) {
  const when = shortWhen(row.date, row.start_min);
  const hi = `Hi ${firstName(row.guest_name)},`;
  const accent = settings.brandColor;
  const base = { restaurant, brand, accent };
  const manage = links.manage ? [{ label: 'View or change', href: links.manage, primary: true }] : [];
  const calendar = links.calendar ? [{ label: 'Add to calendar', href: links.calendar }] : [];
  const policy = settings.policyText ? `Policy: ${settings.policyText}` : '';
  const fee =
    row.card_status === 'on_file' && row.no_show_fee_cents
      ? `Your card is on file. A no-show fee of $${(row.no_show_fee_cents / 100).toFixed(2)} applies if you miss this reservation without cancelling.`
      : '';

  switch (kind) {
    case 'confirmation': {
      const subject = `You're booked at ${restaurant.name}: ${when}`;
      const paragraphs = [hi, `Your table is booked.`, details(row), settings.confirmationMessage, fee, policy];
      return {
        subject,
        text: [...paragraphs, links.manage && `View or change: ${links.manage}`].filter(Boolean).join('\n\n'),
        html: layout({ ...base, preheader: `${guests(row.party_size)}, ${when}`, heading: "You're booked", paragraphs, actions: [...manage, ...calendar] }),
        sms: `${restaurant.name}: you're booked for ${guests(row.party_size)} on ${when}. Change or cancel: ${links.manage} Reply STOP to opt out.`,
      };
    }
    case 'reminder': {
      const subject = `Reminder: ${restaurant.name}, ${when}`;
      const paragraphs = [hi, `Looking forward to seeing you.`, details(row), 'If your plans changed, please let us know so we can offer the table to someone else.', fee];
      return {
        subject,
        text: [...paragraphs, links.manage && `View or change: ${links.manage}`].filter(Boolean).join('\n\n'),
        html: layout({ ...base, preheader: `See you ${when}`, heading: 'See you soon', paragraphs, actions: manage }),
        sms: `${restaurant.name}: reminder for ${guests(row.party_size)} on ${when}. Plans changed? ${links.manage}`,
      };
    }
    case 'modified': {
      const subject = `Updated: ${restaurant.name}, ${when}`;
      const paragraphs = [hi, 'Your reservation has been updated. Here are the new details:', details(row)];
      return {
        subject,
        text: [...paragraphs, links.manage && `View or change: ${links.manage}`].filter(Boolean).join('\n\n'),
        html: layout({ ...base, preheader: `Now ${when}`, heading: 'Reservation updated', paragraphs, actions: [...manage, ...calendar] }),
        sms: `${restaurant.name}: your reservation is now ${guests(row.party_size)} on ${when}. ${links.manage}`,
      };
    }
    case 'cancelled': {
      const subject = `Cancelled: ${restaurant.name}, ${when}`;
      const paragraphs = [
        hi,
        `Your reservation for ${guests(row.party_size)} on ${when} has been cancelled by the restaurant.`,
        extra.reason,
        restaurant.phone ? `Questions? Call ${restaurant.phone}.` : '',
      ];
      return {
        subject,
        text: paragraphs.filter(Boolean).join('\n\n'),
        html: layout({ ...base, preheader: 'Your reservation was cancelled', heading: 'Reservation cancelled', paragraphs }),
        sms: `${restaurant.name}: your reservation on ${when} was cancelled.${restaurant.phone ? ` Questions? ${restaurant.phone}` : ''}`,
      };
    }
    case 'cancelled_by_guest': {
      const subject = `Cancellation confirmed: ${restaurant.name}`;
      const paragraphs = [hi, `Your reservation for ${guests(row.party_size)} on ${when} is cancelled. Thanks for letting us know.`];
      const book = links.book ? [{ label: 'Book another time', href: links.book, primary: true }] : [];
      return {
        subject,
        text: [...paragraphs, links.book && `Book another time: ${links.book}`].filter(Boolean).join('\n\n'),
        html: layout({ ...base, preheader: 'Cancellation confirmed', heading: 'Cancellation confirmed', paragraphs, actions: book }),
        sms: `${restaurant.name}: your reservation on ${when} is cancelled. Thanks for letting us know.`,
      };
    }
    default:
      throw new Error(`Unknown reservation template: ${kind}`);
  }
}

export function staffAlertTemplate({ restaurant, row, links, brand }) {
  const when = shortWhen(row.date, row.start_min);
  const lines = [
    `${row.guest_name}, ${guests(row.party_size)}, ${when}`,
    row.guest_phone && `Phone: ${row.guest_phone}`,
    row.guest_email && `Email: ${row.guest_email}`,
    row.occasion && `Occasion: ${row.occasion}`,
    row.guest_notes && `Note: ${row.guest_notes}`,
    `Source: ${row.source}`,
  ].filter(Boolean);
  return {
    subject: `New booking: ${row.guest_name}, ${guests(row.party_size)}, ${when}`,
    text: [...lines, links.app && `Open the book: ${links.app}`].filter(Boolean).join('\n'),
    html: layout({
      restaurant,
      brand,
      preheader: lines[0],
      heading: 'New online booking',
      paragraphs: lines,
      actions: links.app ? [{ label: 'Open the book', href: links.app, primary: true }] : [],
    }),
  };
}

export function waitlistTemplate(kind, { restaurant, entry, links }) {
  if (kind === 'waitlist_added') {
    const wait = entry.quoted_min ? ` Estimated wait: about ${entry.quoted_min} min.` : '';
    return {
      sms: `${restaurant.name}: you're on the waitlist, party of ${entry.party_size}.${wait} We'll text you when your table is ready.${links.status ? ` Your place in line: ${links.status}` : ''} Reply STOP to opt out.`,
    };
  }
  if (kind === 'waitlist_ready') {
    return { sms: `${restaurant.name}: your table is ready! Please head to the host stand.` };
  }
  throw new Error(`Unknown waitlist template: ${kind}`);
}

export function accountTemplate(kind, { brand, link, restaurantName, inviter, existing = false }) {
  const restaurant = { name: brand, address: '', phone: '' };
  if (kind === 'password_reset') {
    const paragraphs = ['Someone asked to reset the password for this account. If it was you, use the link below. It expires in one hour.', 'If it was not you, ignore this email.'];
    return {
      subject: `Reset your ${brand} password`,
      text: [...paragraphs, link].join('\n\n'),
      html: layout({ restaurant, brand, preheader: 'Password reset', heading: 'Reset your password', paragraphs, actions: [{ label: 'Choose a new password', href: link, primary: true }] }),
    };
  }
  if (kind === 'staff_invite') {
    const paragraphs = [
      `${inviter || 'A teammate'} added you to ${restaurantName} on ${brand}.`,
      existing ? 'Log in with your existing account to see it.' : 'Set a password to get started. The link expires in 7 days.',
    ];
    const label = existing ? 'Log in' : 'Set your password';
    return {
      subject: `You've been added to ${restaurantName}`,
      text: [...paragraphs, link].join('\n\n'),
      html: layout({ restaurant, brand, preheader: `Join ${restaurantName}`, heading: `Join ${restaurantName}`, paragraphs, actions: [{ label, href: link, primary: true }] }),
    };
  }
  throw new Error(`Unknown account template: ${kind}`);
}
