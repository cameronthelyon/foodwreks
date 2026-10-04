// AI agent server: the Model Context Protocol over HTTP ("Streamable HTTP",
// stateless, JSON responses) at POST /mcp. It lets any MCP-capable
// assistant find a member restaurant, check open times and book, change or
// cancel a table, through exactly the same rules as the booking page
// (lib/public-booking.js). Free, and never a per-booking fee: agent bookings
// belong to the restaurant like any other.

import { readFileSync } from 'node:fs';
import { cancelByGuest, modifyByGuest } from './reservations.js';
import { bookOnline, byCode, bySlug, canTakeOnlineBookings, manageInfo, publicAvailability, publicProfile, restaurantSettings } from './public-booking.js';
import { fmtHHMM, isValidDate, localDate, parseHHMM } from './time.js';
import { HttpError, sendJson } from './http.js';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const INSTRUCTIONS = `Book tables at independent restaurants that run their own reservations on this service.
Ground rules:
- Confirm the restaurant, date, time and party size with the person before calling book_table.
- Never invent contact details. Use the person's real name and phone or email; the restaurant uses them to reach the guest.
- If the restaurant has a policy, show it to the person and only set policy_accepted after they agree.
- Always give the person the manage_url after booking: it is their only way to change or cancel online. Treat it as private.
- Book only what the person asked for. Do not hold tables speculatively; one active booking per person per restaurant per day is enforced.
- If check_availability shows nothing open, offer the dates in "next", or the restaurant's phone number.`;

// ---- Tool definitions ----------------------------------------------------------------

const restaurantArg = { type: 'string', description: 'The restaurant id ("slug") from search_restaurants, for example "juniper-rye".' };
const manageArg = { type: 'string', description: 'The manage_url returned by book_table (also in the guest confirmation email).' };

const TOOLS = [
  {
    name: 'search_restaurants',
    title: 'Find restaurants',
    description: 'Find member restaurants taking online reservations, by name, city or cuisine. Returns each restaurant id needed by the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match against name, city or cuisine. Leave out to list all.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_restaurant',
    title: 'Restaurant details',
    description: 'Address, phone, party size limits, how far ahead it books, its reservation policy, and whether a card is needed to hold a table.',
    inputSchema: { type: 'object', properties: { restaurant: restaurantArg }, required: ['restaurant'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'check_availability',
    title: 'Check open times',
    description: 'Open reservation times for a party on a date, in the restaurant\'s local time. Pass a returned "time" value unchanged to book_table.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurant: restaurantArg,
        date: { type: 'string', description: 'Date as YYYY-MM-DD, in the restaurant\'s local calendar.' },
        party_size: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['restaurant', 'date', 'party_size'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'book_table',
    title: 'Book a table',
    description: 'Books a table for the person. Confirm details with them first. Returns a confirmation code and the private manage_url, or, when the restaurant requires a card, a checkout_url the person must open to save a card within 20 minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurant: restaurantArg,
        date: { type: 'string', description: 'YYYY-MM-DD.' },
        time: { type: 'string', description: 'A "time" value exactly as returned by check_availability, for example "19:30" (or "24:30" for 12:30 AM after that day\'s service).' },
        party_size: { type: 'integer', minimum: 1, maximum: 100 },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        phone: { type: 'string', description: 'Mobile number. US/Canada in any format, otherwise +international. Required by many restaurants.' },
        email: { type: 'string', description: 'For the confirmation email.' },
        notes: { type: 'string', description: 'Allergies, accessibility needs, a high chair. Only what the person asked to pass on.' },
        occasion: { type: 'string', description: 'Birthday, Anniversary, Date night, Business or Celebration.' },
        policy_accepted: { type: 'boolean', description: 'True only after the person has seen and agreed to the restaurant\'s policy (get_restaurant).' },
      },
      required: ['restaurant', 'date', 'time', 'party_size', 'first_name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'get_booking',
    title: 'Look up a booking',
    description: 'Current status and details of a booking, and whether it can still be changed or cancelled online.',
    inputSchema: { type: 'object', properties: { manage_url: manageArg }, required: ['manage_url'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'change_booking',
    title: 'Change a booking',
    description: 'Moves a booking to another date or time, changes the party size, or updates notes. Check availability first. Changes close at the restaurant\'s cutoff.',
    inputSchema: {
      type: 'object',
      properties: {
        manage_url: manageArg,
        date: { type: 'string', description: 'New date, YYYY-MM-DD.' },
        time: { type: 'string', description: 'New time, exactly as returned by check_availability.' },
        party_size: { type: 'integer', minimum: 1, maximum: 100 },
        notes: { type: 'string' },
      },
      required: ['manage_url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'cancel_booking',
    title: 'Cancel a booking',
    description: 'Cancels the booking and gives the table back. Confirm with the person first. Cancellations close at the restaurant\'s cutoff; after that they must call.',
    inputSchema: { type: 'object', properties: { manage_url: manageArg }, required: ['manage_url'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
];

// ---- Helpers ---------------------------------------------------------------------------

class ToolError extends Error {}

function slotTime(value) {
  const minutes = typeof value === 'number' ? value : parseHHMM(String(value ?? ''));
  if (minutes === null || !Number.isInteger(minutes)) throw new ToolError('time must be a value from check_availability, like "19:30".');
  return minutes;
}

function fromManageUrl(app, url) {
  let parsed;
  try {
    parsed = new URL(String(url), app.config.baseUrl);
  } catch {
    throw new ToolError('That is not a manage link.');
  }
  const code = /^\/m\/([A-Za-z0-9]+)$/.exec(parsed.pathname)?.[1];
  const token = parsed.searchParams.get('t');
  if (!code || !token) throw new ToolError('That is not a manage link. It looks like https://…/m/CODE?t=….');
  return byCode(app, code, token);
}

function bookingSummary(app, info) {
  const v = info.reservation;
  return {
    code: v.code,
    status: v.status,
    restaurant: info.restaurant.name,
    date: v.displayDate || v.date,
    time: v.timeLabel,
    party_size: v.partySize,
    can_change_online: info.canChange,
    can_cancel_online: info.canCancel,
    restaurant_phone: info.restaurant.phone || null,
  };
}

function limit(app, ip, name, max, windowMs) {
  app.limiter.check(`mcp-${name}:${ip}`, max, windowMs, 'Too many requests. Please wait a few minutes and try again.');
}

// ---- Tool implementations -----------------------------------------------------------------

const HANDLERS = {
  search_restaurants(app, args) {
    const q = String(args.query ?? '').trim().toLowerCase();
    const max = Math.min(50, Math.max(1, Number(args.limit) || 20));
    const words = q.split(/\s+/).filter(Boolean);
    const rows = app.db
      .all('SELECT * FROM restaurants ORDER BY name')
      .filter((r) => canTakeOnlineBookings(r, app.now()))
      .filter((r) => {
        const hay = `${r.name} ${r.city} ${r.region} ${r.cuisine}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, max);
    const restaurants = rows.map((r) => ({
      restaurant: r.slug,
      name: r.name,
      cuisine: r.cuisine || null,
      city: [r.city, r.region].filter(Boolean).join(', ') || null,
      booking_page: `${app.config.baseUrl}/r/${r.slug}`,
    }));
    return { restaurants, text: restaurants.length ? restaurants.map((r) => `${r.name}${r.city ? ` (${r.city})` : ''}: id "${r.restaurant}"`).join('\n') : 'No member restaurants match.' };
  },

  get_restaurant(app, args) {
    const r = bySlug(app, args.restaurant);
    const p = publicProfile(r);
    const settings = restaurantSettings(r);
    const cardHolds = settings.cardRequiredMinParty > 0 && Boolean(app.integrations.stripeKey(r.id));
    const out = {
      restaurant: r.slug,
      name: p.name,
      timezone: p.timezone,
      today: localDate(app.now(), r.timezone),
      address: [p.address, p.city].filter(Boolean).join(', ') || null,
      phone: p.phone || null,
      taking_online_bookings: canTakeOnlineBookings(r, app.now()),
      party_size: { min: p.minPartySize, max: p.maxPartySize },
      books_days_ahead: p.bookingWindowDays,
      requires_phone: p.requirePhone,
      requires_email: p.requireEmail,
      policy: p.policyText || null,
      card_required_from_party_size: cardHolds ? settings.cardRequiredMinParty : null,
      no_show_fee_per_guest_cents: cardHolds ? p.noShowFeeCents : null,
      booking_page: `${app.config.baseUrl}/r/${r.slug}`,
    };
    return { ...out, text: `${out.name}, ${out.address || 'address not listed'}. Parties of ${out.party_size.min} to ${out.party_size.max} online.${out.policy ? ` Policy: ${out.policy}` : ''}` };
  },

  check_availability(app, args, ctx) {
    limit(app, ctx.ip, 'availability', 240, 60_000);
    const r = bySlug(app, args.restaurant);
    if (!isValidDate(args.date)) throw new ToolError('date must be YYYY-MM-DD.');
    const result = publicAvailability(app, r, { date: args.date, partySize: Number(args.party_size) });
    const open = result.slots.filter((s) => s.available).map((s) => ({ time: fmtHHMM(s.time), label: s.label, group: s.group || null }));
    const next = result.next.map((n) => ({ date: n.date, times: n.times.map((t) => ({ time: fmtHHMM(t.time), label: t.label })) }));
    const out = { restaurant: r.slug, date: result.date, party_size: result.partySize, closed: result.closed, message: result.message || null, large_party: result.largeParty, open, next };
    const text = open.length
      ? `Open for ${out.party_size} on ${out.date}: ${open.map((s) => s.label).join(', ')}.`
      : `${out.message || 'Nothing open for that party size.'}${next.length ? ` Next open: ${next.map((n) => `${n.date} (${n.times.map((t) => t.label).join(', ')})`).join('; ')}.` : ''}`;
    return { ...out, text };
  },

  async book_table(app, args, ctx) {
    limit(app, ctx.ip, 'book', 12, 10 * 60_000);
    const r = bySlug(app, args.restaurant);
    const res = await bookOnline(
      app,
      r,
      {
        date: args.date,
        time: slotTime(args.time),
        partySize: args.party_size,
        firstName: args.first_name,
        lastName: args.last_name,
        phone: args.phone,
        email: args.email,
        notes: args.notes,
        occasion: args.occasion,
        policyAccepted: args.policy_accepted === true,
      },
      { source: 'agent' },
    );
    if (res.status === 'pending') {
      return {
        code: res.code,
        status: 'pending',
        checkout_url: res.checkoutUrl,
        text: `The restaurant holds tables for this party size with a card. Give the person this link to save a card (nothing is charged now); the table is held for 20 minutes: ${res.checkoutUrl}`,
      };
    }
    const v = res.reservation;
    return {
      code: res.code,
      status: res.status,
      restaurant: r.name,
      date: v.displayDate || v.date,
      time: v.timeLabel,
      party_size: v.partySize,
      manage_url: res.manageUrl,
      text: `Booked: ${r.name}, ${v.displayDate || v.date} at ${v.timeLabel}, party of ${v.partySize}. Confirmation ${res.code}. Give the person this private link to change or cancel: ${res.manageUrl}`,
    };
  },

  get_booking(app, args) {
    const { row, restaurant } = fromManageUrl(app, args.manage_url);
    const out = bookingSummary(app, manageInfo(app, restaurant, row));
    return { ...out, text: `${out.restaurant}, ${out.date} at ${out.time}, party of ${out.party_size}: ${out.status}.` };
  },

  change_booking(app, args, ctx) {
    limit(app, ctx.ip, 'manage', 30, 10 * 60_000);
    const { row, restaurant } = fromManageUrl(app, args.manage_url);
    const patch = {};
    if (args.date !== undefined) patch.date = args.date;
    if (args.time !== undefined) patch.time = slotTime(args.time);
    if (args.party_size !== undefined) patch.partySize = Number(args.party_size);
    if (args.notes !== undefined) patch.notes = String(args.notes);
    if (!Object.keys(patch).length) throw new ToolError('Nothing to change: pass a new date, time, party_size or notes.');
    const out = bookingSummary(app, manageInfo(app, restaurant, modifyByGuest(app, restaurant, row, patch)));
    return { ...out, text: `Changed: ${out.restaurant}, ${out.date} at ${out.time}, party of ${out.party_size}.` };
  },

  cancel_booking(app, args, ctx) {
    limit(app, ctx.ip, 'manage', 30, 10 * 60_000);
    const { row, restaurant } = fromManageUrl(app, args.manage_url);
    const out = bookingSummary(app, manageInfo(app, restaurant, cancelByGuest(app, restaurant, row)));
    return { ...out, text: `Cancelled: ${out.restaurant}, ${out.date} at ${out.time}.` };
  },
};

// ---- JSON-RPC over HTTP ----------------------------------------------------------------------

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function callTool(app, ctx, params) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) return { error: [-32602, `Unknown tool: ${params?.name}`] };
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  for (const key of tool.inputSchema.required || []) {
    if (args[key] === undefined || args[key] === '') return { result: toolFailure(`Missing ${key}.`) };
  }
  try {
    const { text, ...structured } = await HANDLERS[tool.name](app, args, ctx);
    return { result: { content: [{ type: 'text', text }], structuredContent: structured } };
  } catch (err) {
    // Business outcomes (slot gone, too late, not found) go back to the
    // model as a readable failure it can act on, not as a protocol error.
    if (err instanceof ToolError || err instanceof HttpError) return { result: toolFailure(err.message, err.code) };
    app.log.error?.(`mcp ${tool.name} failed:`, err);
    return { result: toolFailure('Something went wrong on our side. Please try again.') };
  }
}

const toolFailure = (message, code) => ({ content: [{ type: 'text', text: message }], structuredContent: { error: code || 'invalid', message }, isError: true });

export function registerMcp(router, app) {
  const allowedOrigin = new URL(app.config.baseUrl).origin;

  router.post('/mcp', async (ctx) => {
    // DNS-rebinding guard (MCP spec): browsers send Origin; other clients don't.
    const origin = ctx.req.headers.origin;
    if (origin && origin !== allowedOrigin) return sendJson(ctx.res, 403, rpcError(null, -32600, 'Origin not allowed.'));
    const asked = ctx.req.headers['mcp-protocol-version'];
    if (asked && !PROTOCOL_VERSIONS.includes(asked)) return sendJson(ctx.res, 400, rpcError(null, -32600, `Unsupported protocol version ${asked}.`));

    let msg;
    try {
      msg = JSON.parse(ctx.rawBody.toString('utf8') || 'null');
    } catch {
      return sendJson(ctx.res, 400, rpcError(null, -32700, 'Parse error.'));
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
      return sendJson(ctx.res, 400, rpcError(msg?.id, -32600, 'Expected one JSON-RPC 2.0 message.'));
    }
    // Notifications and responses: accepted, nothing to say.
    if (msg.id === undefined || msg.method === undefined) {
      ctx.res.writeHead(202);
      return ctx.res.end();
    }

    const reply = (result) => sendJson(ctx.res, 200, { jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize': {
        const wanted = msg.params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'freeheld', title: `${app.config.brand.name} reservations`, version: VERSION, websiteUrl: app.config.baseUrl },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const out = await callTool(app, ctx, msg.params);
        if (out.error) return sendJson(ctx.res, 200, rpcError(msg.id, ...out.error));
        return reply(out.result);
      }
      default:
        return sendJson(ctx.res, 200, rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
    }
  });

  // No server-initiated streams and no sessions: say so plainly.
  for (const method of ['get', 'delete']) {
    router[method]('/mcp', (ctx) => {
      ctx.res.writeHead(405, { Allow: 'POST' });
      ctx.res.end();
    });
  }
}

export { TOOLS as MCP_TOOLS };
