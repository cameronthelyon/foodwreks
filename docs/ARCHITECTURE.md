# Architecture

Built to be cheap to run and easy to hand over: one runtime, zero npm dependencies, one process, one database file.

## Principles

1. **Boring and small.** Node.js standard library only: `node:http`, `node:sqlite`, `node:crypto`, `node:test`. Nothing to patch when a transitive dependency breaks. No build step: the browser loads plain ES modules.
2. **One box.** A reservation workload is tiny: a busy restaurant books a few hundred times a day. A single ~$40/month server with SQLite in WAL mode serves thousands of restaurants.
3. **The restaurant's data is portable.** Everything exports as CSV or JSON in one click. Credentials are the only thing withheld from exports (they are the restaurant's own keys and can be re-entered).
4. **Correct under concurrency by construction.** `node:sqlite` is synchronous, so a check-then-write inside one transaction is atomic for the whole process. Two diners cannot get the same table.
5. **Never lose a message.** Notifications are written in the same transaction as the change that caused them (outbox pattern) and delivered with retries.

## Layout

```
server.js                 entry: config, HTTP server, worker, graceful shutdown
lib/
  config.js               environment -> config object (testable, no globals)
  db.js                   SQLite wrapper, migrations (PRAGMA user_version), transactions
  time.js                 timezone math with Intl (service date + minutes model)
  availability.js         PURE engine: slots, pacing, table assignment, repack
  restaurants.js          settings (sanitized), floor, shifts, closures, day context
  reservations.js         the only code that writes reservations
  guests.js               guest matching (phone, then email), derived stats, merge
  waitlist.js             walk-in queue and wait estimates from the live floor
  notify/                 outbox, templates, providers (Postmark, Resend, Twilio)
  integrations/           Square, Clover, Toast (read-only), check matching, Stripe
  google.js               Actions Center booking server (v3), feeds, booking notifications
  portability.js          CSV import with column detection; CSV/JSON export
  reports.js              aggregates; unresolved bookings reported, never guessed
  license.js              trial, lifetime, comped, suspended
  auth.js, security.js    sessions, scrypt, roles, CSRF, rate limits, headers
  events.js               server-sent events for live host-stand updates
  worker.js               background jobs (outbox, reminders, holds, closeout, sync, backups)
  routes/                 pages, public, auth, staff, integrations, google, admin
public/
  *.html                  page templates ({{PLACEHOLDERS}} filled server-side, escaped)
  site/                   marketing site: layout.html plus one content file per page (routes and metadata in lib/routes/site.js)
  assets/js/              vanilla ES modules: booking, manage, waitlist, auth, admin, app/*
  assets/css/             design tokens (light + dark), app, booking, marketing
test/                     node:test suites over real HTTP with a fake clock and fake fetch
```

## Time model

Restaurants think in local wall-clock time, so the system of record is a **service date** (`YYYY-MM-DD`) plus **minutes from local midnight**. A seating at 12:30 AM that belongs to Friday's service is Friday at minute 1470. UTC instants are derived only where a real clock matters (reminders, "too soon to book" checks). DST is handled with `Intl.DateTimeFormat` and tested on both transition days.

**The service day turns over at 4 AM, not midnight** (`serviceNow` in `lib/time.js`, `serviceNowIn` in the browser). At 1:10 AM Saturday the host stand is still on Friday, at minute 1510: walk-ins, waitlist parties and the "now" line all land on Friday's book, and the app moves to the new day by itself at 4 AM. Times typed before 4 AM in staff forms read the same way (12:30 AM is minute 1470 of the date shown). Guests are the exception: the public booking page shows calendar dates, because "Today" at 1 AM Saturday means Saturday to a diner.

## Availability engine (`lib/availability.js`)

Pure functions; everything arrives in a context object, so it is exhaustively unit-tested.

- **Units.** A party sits at a single table or a defined combination (T13+T14 seats 6-8). Tables can be walk-in only (hidden from online booking).
- **Occupancy.** A reservation holds every table in its unit for `[start, start + turn time + buffer)`. Turn times vary by party size. A party still seated past its planned end keeps the table for 15 more minutes (or until marked done). Previous-day seatings that spill past midnight are counted.
- **Pacing.** Optional caps on covers and parties *starting* in each slot, so the kitchen is not slammed at 7:00. Online: a hard limit. Staff: a warning.
- **Best fit.** Tightest table first (least wasted seats), single tables before combinations.
- **Repack.** If nothing is free, the engine re-seats every movable reservation from scratch to fit one more party. Pass 1 keeps parties on their current tables where possible; pass 2 ignores them. Host-pinned tables and parties already in the building never move. Bookings from public channels are only moved onto tables open to online booking, so walk-in inventory stays protected.
- **Channels.** `online` enforces party limits, booking window, notice and pacing on the published grid. `staff` can book any minute, on closed days, and over pacing (with warnings), and can deliberately overbook into "needs a table."

## Data model (SQLite)

`restaurants` (profile, JSON settings, license) · `users`, `memberships` (owner, manager, host), `sessions`, `password_resets` · `tables`, `table_combos`, `shifts`, `closures` · `guests` (per restaurant, never shared) · `reservations` (status lifecycle with timestamps, channel source, tables, card hold state, POS spend) · `waitlist` · `outbox` · `integrations` (AES-256-GCM encrypted credentials) · `pos_checks` (every synced check, matched or not) · `audit_log` · `idempotency` (Google CreateBooking/UpdateBooking replays) · `kv`.

Guest counters (visits, no-shows, late cancels, spend) are **recomputed** from reservations on every change, never incremented, so undoing a no-show cannot drift them.

## Security

- **Passwords:** scrypt (N=16384, r=8, p=1), minimum 10 characters. **Sessions:** random 256-bit token in an HttpOnly, SameSite=Lax cookie (Secure on https); the database stores only its SHA-256. Sliding 30-day expiry.
- **Tenant isolation:** every staff route resolves the restaurant through the caller's membership. A restaurant you are not on returns 404, not 403, so ids cannot be probed. Roles: host < manager < owner.
- **CSRF:** API mutations require a JSON content type (forces a CORS preflight we never grant) and a same-origin `Origin` header when present. The one exception is a `DELETE` with no body, which needs no content type: browsers cannot send `DELETE` cross-site without a preflight, and forms cannot send it at all. It still must be same-origin.
- **Headers:** strict CSP (no inline script), `frame-ancestors 'none'` everywhere except booking, manage and waitlist pages (embeddable by design), nosniff, referrer policy, HSTS on https.
- **Manage links** are `HMAC(secret, code + per-booking salt)`. A database leak alone reveals none, reminders can rebuild them days later, and rotating the salt revokes one link.
- **Webhooks:** Square HMAC-SHA256 over URL + body; Stripe timestamped signatures with a 5-minute tolerance; Clover auth code; Google HTTP Basic.
- **Abuse:** per-IP rate limits on every public endpoint, a honeypot field, one active booking per phone/email per restaurant per day, and login throttling per IP and per account. The one-booking rule is checked only after a request is otherwise valid and bookable, and its error never reveals the other booking's time, so it cannot be used to look up someone's plans. Behind `TRUST_PROXY=1`, the client IP is the last `X-Forwarded-For` entry (the one the proxy appended).
- **Input boundaries:** the public booking endpoint copies an explicit list of fields; source tags from links never grant anything, and external references, statuses and staff notes are server-side only. Shifts and special hours are range-checked on save and clamped again inside the engine, so no stored row can make slot generation run long.
- **Outbound calls:** Toast API hosts must be `https://*.toasttab.com`, and access tokens are cached per host, client id and secret, so credentials one restaurant enters can never cause another restaurant's token to be sent anywhere.
- **Exports** neutralize spreadsheet formulas (cells starting with `= + - @`) while keeping phone numbers readable.

## Background jobs (`lib/worker.js`)

All idempotent and safe to run late or twice.

| Job | Every | What |
|---|---|---|
| Outbox | 5 s | Deliver due messages; claim by bumping attempts; backoff 1m, 5m, 30m, 2h; give up after 5 or on permanent errors (bad address, STOP) |
| Reminders | 1 min | Queue due reminders once; skip bookings made inside the reminder window |
| Card holds | 1 min | Release tables held for diners who never finished adding a card (20 min) |
| Closeout | 15 min | Complete parties left "seated" 4 hours past their planned end |
| POS sync | 5 min | Pull closed checks since the cursor (15-minute overlap), match, advance |
| Cleanup | 1 h | Expired sessions, used reset tokens, old idempotency rows, delivered messages after 90 days |
| Backup | configurable (24 h) | `VACUUM INTO` a consistent snapshot; keep N |

## Scaling and cost

- One process handles the expected load for years. SQLite on local SSD does tens of thousands of simple writes per second; the whole platform at 2,000 restaurants is a few writes per second at peak.
- **Durability:** daily snapshots are the floor. Copy them off the box (see OPERATIONS.md), or run [Litestream](https://litestream.io) for continuous replication to object storage.
- **When to change the architecture:** if one process cannot keep up (not soon), shard by restaurant across processes before reaching for a database server. Each restaurant's data is self-contained.

## Testing

`npm test` runs 94 tests in under 4 seconds: the availability engine (DST, overlap, pacing, combos, repack, spillover), every HTTP flow (booking, manage, staff, roles, isolation, CSRF), imports and exports, reports, notifications (providers, retries, reminders), integrations (Stripe, Toast, Square, Clover, Google) with every outbound call faked, and page rendering. Tests use a fake clock, an in-memory database, and a recorded fake `fetch`. No test touches the network. `test/regressions.test.js` holds one test per bug found in review, each shown to fail before its fix.

## Known limits

- `node:sqlite` is marked experimental in Node 22 (the warning is silenced in npm scripts). The API used here is the basic, stable surface; track Node release notes and prefer the current LTS.
- English only. Phone normalization defaults to US/Canada formats; other countries need `+` international numbers.
- The service day turns over at 4 AM for every restaurant. A venue that seats past 4 AM (rare) would need that boundary as a setting.
- After midnight, online guests cannot book into the previous night's late seatings (the public page has moved to the new calendar day). Staff can.
- One location per restaurant record. Groups run each location separately (each needs its own license anyway).
- No floor-plan drawing: tables are a list with sections. The timeline is the spatial view.
- Integrations are unit-tested against documented APIs, not yet against live sandboxes. See INTEGRATIONS.md.
