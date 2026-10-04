# Freehold

**Own the book.** A reservation system for independent restaurants. Pay $1,000 once per location. No cover fees, no monthly rent, and your guests and data stay yours.

Zero dependencies: Node.js 22.13+ and nothing to `npm install`.

## Try it

```bash
npm run demo
```

Open http://localhost:3000. A demo restaurant (Juniper & Rye) loads with a month of history and two weeks of bookings.

| What | Where |
|---|---|
| Marketing page | http://localhost:3000 |
| Diner booking page | http://localhost:3000/r/juniper-rye |
| Host stand | http://localhost:3000/login as `demo@freehold.test` / `freehold-demo` |
| Host-only account | `host@freehold.test` / `freehold-demo` |
| Platform admin | http://localhost:3000/admin (the demo owner is an admin) |

Emails print to the terminal in demo mode instead of sending.

## What restaurants get

- **Booking page and website widget.** Mobile first, embeddable, deep links for Google and Instagram, schema.org reservation markup. Bookings are tagged by channel.
- **Smart seating.** Best-fit table assignment, table combinations, turn times by party size, pacing per slot, buffers, walk-in-only tables, and automatic re-seating to fit one more party. Two diners can never get the same table.
- **Host stand.** Today's book grouped by time with one-tap Arrived, Seat and Done; a floor timeline with drag-to-move and tap-to-book; live sync across every device; walk-ins; keyboard shortcuts; dark mode.
- **Waitlist.** Quotes estimated from the live floor, "table ready" texts, a guest status page, optional online join.
- **Guest book.** Profiles, tags, allergies, notes, visit, no-show and spend history, duplicate merge.
- **Fewer no-shows.** Confirmations, reminders, self-service change and cancel links, calendar files, and optional card holds on the restaurant's own Stripe account (fees go straight to the restaurant).
- **POS connections, read-only.** Toast, Square and Clover: spend per guest, and tables free up when checks close.
- **Google.** The reservation link for a Google Business Profile on day one; an Actions Center booking server for booking inside Google once approved.
- **Reports.** Covers, no-show rate, channels, returning guests, party sizes, and an honest "fees avoided" estimate.
- **Portability.** CSV import from OpenTable, Resy, Tock or a spreadsheet with automatic column mapping. Export everything as CSV or JSON, any day.
- **Licensing built in.** 30-day trial, one-time license via Stripe Checkout, or offline payment marked by an admin. An expired trial pauses the public booking page only: staff never lose access to their data.

## Run it for real

```bash
cp .env.example .env    # set BASE_URL, APP_SECRET, email provider, ...
npm start
```

Production deployment, backups, restore drills, onboarding and cutover checklists: **[docs/OPERATIONS.md](docs/OPERATIONS.md)**. A `Dockerfile` is included.

## Docs

| Doc | For |
|---|---|
| [STRATEGY.md](docs/STRATEGY.md) | The honest case: brutal facts, the bottleneck, endowment math, structure, 90-day rocks |
| [BRAND.md](docs/BRAND.md) | Name, positioning, voice, visual identity, pre-launch checklist |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works: time model, availability engine, security, jobs |
| [INTEGRATIONS.md](docs/INTEGRATIONS.md) | POS, Stripe, Google, email and texting setup, plus validation status |
| [OPERATIONS.md](docs/OPERATIONS.md) | READ-DO checklists for running the service |
| [API.md](docs/API.md) | The public booking API for websites, partners and AI agents |

## Status: what is and is not proven

- **Proven by tests:** the availability engine, every booking and host-stand flow, roles and tenant isolation, imports and exports, reports, notifications, and the integration request shapes. `npm test` runs 87 tests in under 4 seconds.
- **Driven in a real browser:** booking, manage, host stand, floor drag-and-drop, waitlist, guests, settings, import.
- **Not yet proven:** no integration has run against a live sandbox (Toast, Square, Clover, Stripe, Google, Postmark, Twilio). Budget a day each before a pilot depends on one. Google booking-inside-Google needs Google's partner approval.
- **Decisions that are yours:** the license (the landing page promises open source; AGPL-3.0 is recommended), the operating entity (cooperative recommended; see STRATEGY.md), and the name (see BRAND.md).

## Develop

```bash
npm test          # node:test, fake clock, no network
npm run dev       # restarts on file changes
npm run seed      # load the demo restaurant into the configured database
```

Code layout and conventions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
