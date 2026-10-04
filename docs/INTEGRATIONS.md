# Integrations

Every integration is optional. A restaurant can run on the booking page, host stand and email alone.

## Validation status (read this first)

| Integration | Built | Tested with faked APIs | Run against a live sandbox | What it needs |
|---|---|---|---|---|
| Google Business Profile link | Yes | n/a (it is a link) | n/a | Nothing: paste the link |
| Toast (read-only) | Yes | Yes | **No** | Restaurant creates Standard API access credentials |
| Square (read-only) | Yes | Yes | **No** | Platform registers a Square app; webhook subscription |
| Clover (read-only) | Yes | Yes | **No** | Approved Clover App Market app for production |
| Stripe card holds (restaurant's account) | Yes | Yes | **No** | Restaurant's restricted key |
| Stripe license payments (platform) | Yes | Yes | **No** | Platform Stripe account and webhook |
| Google Actions Center end-to-end | Yes | Yes | **No** | Partner approval, sandbox review, SFTP feeds, service account |
| Email (Postmark or Resend) | Yes | Yes | **No** | Account and verified sending domain |
| Text messages (Twilio) | Yes | Yes | **No** | Account plus per-restaurant 10DLC or toll-free verification |

"Tested with faked APIs" means request shapes, auth, signatures, pagination and error handling are asserted against the published documentation. None of it has met a real sandbox. Budget a day per integration for sandbox validation before a pilot depends on it. Field names marked UNVERIFIED below are the likeliest to need fixes.

---

## POS systems (read-only by design)

**What we read:** closed checks, with close time, total, table, guest count (Toast only) and customer contact. **What we do with it:** attach spend to the reservation and guest profile, and mark a seated party "done" when its check closes, freeing the table on the timeline. **What we never do:** write anything to the POS.

**Matching** (`lib/integrations/matching.js`) is conservative. First by customer phone or email within the check's window. Then by the table the party was seated at (names normalized, so "Table 12," "TBL #12" and "12" match; set "POS name" on a table if your POS calls it something else). When in doubt there is no match: an unmatched check costs nothing, a wrong one pollutes a guest's history.

Sync runs every 5 minutes, and on webhook where available, with a 15-minute overlap so late-closing checks are not missed. The first sync covers the last 2 days.

### Toast

- **Access:** "Standard API access," which the restaurant provisions itself: Toast Web → Integrations → Toast API access → Manage credentials. Needs an employee with the Manage Integrations permission and RMS Essentials or higher. Read-only.
- **Scopes:** `orders:read`, `config:read`, and `guest.pi:read` (without it, checks have no customer details and matching falls back to tables).
- **Paste into Settings → POS & Google:** client ID, client secret, restaurant GUID, and the API hostname Toast shows with the credentials.
- **Calls:** `POST /authentication/v1/authentication/login` (`userAccessType: TOAST_MACHINE_CLIENT`), `GET /orders/v2/ordersBulk` with the `Toast-Restaurant-External-ID` header (filters on *modified* time), `GET /config/v2/tables/{guid}` for table names (cached).
- **Rate limits:** 20 requests/second overall; ordersBulk 5/second per location.
- **UNVERIFIED:** default hostnames (`ws-api.toasttab.com`, sandbox `ws-sandbox-api.eng.toasttab.com`); whether `totalAmount` includes tip.

### Square

- **Platform setup:** create an app in the Square Developer Dashboard. Set `SQUARE_CLIENT_ID`, `SQUARE_CLIENT_SECRET`, `SQUARE_ENV=production`. OAuth redirect URL: `{BASE_URL}/oauth/square/callback`.
- **Webhooks:** subscribe `order.updated` and `payment.updated` to `{BASE_URL}/webhooks/square`; put the subscription's signature key in `SQUARE_WEBHOOK_SIGNATURE_KEY`. Verified as base64 HMAC-SHA256 over notification URL + raw body.
- **Scopes:** `ORDERS_READ CUSTOMERS_READ MERCHANT_PROFILE_READ PAYMENTS_READ`. Access tokens last 30 days and are refreshed automatically; code-flow refresh tokens do not expire.
- **Calls:** `POST /v2/orders/search` (COMPLETED orders by `closed_at`), `GET /v2/customers/{id}`, `GET /v2/locations`. Header `Square-Version: 2026-09-16`.
- **Limitation:** Square orders carry no table or guest count. `ticket_name` is the only table hint (Square for Restaurants often uses "Table 12"), so customer matching does most of the work.

### Clover

- **Platform setup:** a Clover app; production installs require **App Market approval**. Set `CLOVER_APP_ID`, `CLOVER_APP_SECRET`, `CLOVER_ENV`, `CLOVER_REGION` (`us`, `ca`, `eu`, `la`). Redirect URL: `{BASE_URL}/oauth/clover/callback`.
- **Webhooks:** point the app's webhook at `{BASE_URL}/webhooks/clover`. Clover first posts a verification code (logged by the server) to paste into its dashboard; after that, every delivery carries the auth code in `X-Clover-Auth`, which goes in `CLOVER_WEBHOOK_AUTH_CODE`.
- **Calls:** OAuth v2 with expiring tokens (`/oauth/v2/token`, `/oauth/v2/refresh`; refresh tokens are single-use), `GET /v3/merchants/{mId}/orders?filter=modifiedTime>=…&expand=customers`.
- **Limitation:** no close time (modified time approximates it) and no guest count. The order title is the usual table hint in Clover Dining.
- **UNVERIFIED:** token expiration field names (`access_token_expiration`, `refresh_token_expiration`); exact filter operator syntax and paging; webhook payload shape.

### Not built (and why)

Lightspeed K-Series has a solid closed-sales API (`/f/v2/business-location/{id}/sales`, with `nbCovers` and `tableName`) behind Lightspeed-issued credentials. SpotOn, TouchBistro, Revel, NCR Aloha and Oracle Simphony are gated partner programs. Each integration is a permanent maintenance bill; add the next one when paying members ask for it, not before.

---

## Stripe

### Card holds and no-show fees (the restaurant's own account)

- The restaurant creates a **restricted key** in Stripe (Developers → API keys) with: Customers write, Checkout Sessions write, SetupIntents write, PaymentIntents write, PaymentMethods read. Paste it in Settings → No-show protection. It is stored encrypted (AES-256-GCM).
- **Flow:** a party at or above the card threshold books → the reservation is "pending" and holds the table → the diner saves a card on a Stripe-hosted Checkout page (setup mode, nothing charged) → on return we confirm the session with Stripe and the booking becomes "booked" (confirmation sent). Unfinished holds release after 20 minutes.
- **No-show fee:** a manager marks the no-show, then presses Charge. One off-session PaymentIntent with an idempotency key, so a double click cannot double-charge.
- **Money goes to the restaurant's Stripe account. We take nothing.** (OpenTable takes a 2% service fee on these since 2025.)
- No webhook setup is needed for card holds: the return page verifies with Stripe directly.

### License payments (the platform's account)

- Set `PLATFORM_STRIPE_SECRET_KEY` and `PLATFORM_STRIPE_WEBHOOK_SECRET`. Add a webhook endpoint at `{BASE_URL}/webhooks/stripe` for `checkout.session.completed`.
- Owners click "Pay $1,000 and activate" → Stripe Checkout → the webhook activates the lifetime license. Without Stripe configured, platform admins mark licenses paid at `/admin` (checks, invoices).

---

## Google

### Day one: the Business Profile reservation link

Each restaurant pastes its link, `{BASE_URL}/r/{slug}?ref=google`, as the reservation link on its Google Business Profile (Edit profile → Bookings). Google shows it as a booking button. No partnership, no fees. Bookings are tagged "Google" in reports. Google's Place Actions API (`placeActionLinks`, type `DINING_RESERVATION`, provider type `MERCHANT`) can set the same link programmatically for restaurants that authorize it.

Booking pages also carry schema.org `Restaurant` + `ReserveAction` structured data.

### Later: Actions Center "Reservations end-to-end" (booking inside Google)

- **Status:** the booking server (`lib/google.js`, mounted at `{BASE_URL}/google`) and feed generators are built and tested against the v3 docs. Going live requires Google's partner approval, a sandbox phase and a production review (up to 7 business days, restarting after any fix).
- **Google's requirements (from its docs):** a direct contract with every merchant in the feed, real-time availability (answers under 1 second), comprehensive inventory, 30+ days of availability, online cancellation. No minimum merchant count appears in the docs.
- **Endpoints:** `GET /v3/HealthCheck`, `POST /v3/BatchAvailabilityLookup`, `/v3/CreateBooking`, `/v3/UpdateBooking`, `/v3/GetBookingStatus`, `/v3/ListBookings`. HTTP Basic auth (`GOOGLE_BOOKING_USER`, `GOOGLE_BOOKING_PASSWORD`; Google expires partner passwords every 6 months). CreateBooking and UpdateBooking are idempotent on `idempotency_token`. Business failures return HTTP 200 with `booking_failure.cause`.
- **Feeds:** `GET /google/feeds/{merchants,services,availability}.json` (Basic auth). Google wants full feeds daily over SFTP (`partnerupload.google.com:19321`, SSH key). Fetch them with curl on a daily cron and upload with `sftp`.
- **Booking notifications:** when the restaurant cancels or marks a no-show on a Google booking, the server PATCHes the Maps Booking API (`GOOGLE_PARTNER_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`). No-op until configured.
- **Restaurants opt in** with Settings → POS & Google → "Offer my tables for booking directly inside Google." Parties that require a card hold are not offered to Google.
- **Lighter routes worth asking Google about first:** "Reservations Redirect" and "Business Link" use the merchant feed plus link templates and no booking server.
- **UNVERIFIED:** the `ListBookings` response field name (`bookings`); the service feed's type field for dining (omitted); availability real-time updates (not implemented; daily feeds plus live lookups instead).

### Watch: AI agents

Google's AI Mode books restaurants through named partners (OpenTable, Resy, Tock). How a new provider joins is not documented. The defensive move is an open, documented booking API so any agent can book member restaurants: see [API.md](API.md). An MCP server wrapping it is the next step.

---

## Email and text messages

| Provider | Setting | Cost (Oct 2026) |
|---|---|---|
| Postmark | `EMAIL_PROVIDER=postmark`, `POSTMARK_TOKEN` | ~$1.50 per 1,000 |
| Resend | `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` | ~$0.40 per 1,000 |
| Console (dev) | `EMAIL_PROVIDER=console` | Prints instead of sending |
| Twilio | `SMS_PROVIDER=twilio`, SID, token, `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | $0.0083/segment + carrier fees ≈ $0.0126 |

Verify a sending domain (SPF, DKIM, DMARC) before going live, or confirmations land in spam.

**Text message compliance is the hard part.** US carriers require application-to-person registration:

- **10DLC:** each restaurant (legal name + EIN) registers as its own brand under the platform as an ISV ($4.50 brand, $15 campaign vetting, $1.50 to $10/month per campaign; review up to ~5 business days, longer in backlogs).
- **Toll-free:** one verified toll-free number per restaurant; verification is free and takes ~3 to 5 business days; an EIN has been required since February 2026. Simpler for most restaurants.

Texting is off by default and passed through at cost. The lifetime license does not cover carrier fees, and the landing page says so.
