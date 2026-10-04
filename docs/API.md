# Public booking API

The same JSON endpoints the booking page uses, documented so that partners, websites and AI agents can book any member restaurant directly, with no toll and no partnership agreement. Every booking made through it belongs to the restaurant, exactly like one made on its own page.

Base URL: the server's `BASE_URL`. All bodies are JSON. Mutations must send `Content-Type: application/json`; browsers must also be same-origin (server-to-server callers send no `Origin` header). Rate limits apply per IP (availability: 240/min; bookings: 12 per 10 minutes).

## 1. Restaurant profile

`GET /api/public/r/{slug}`

```json
{
  "restaurant": {
    "slug": "juniper-rye", "name": "Juniper & Rye", "timezone": "America/Los_Angeles",
    "phone": "(510) 555-0142", "address": "1200 Alder Street", "city": "Oakland",
    "minPartySize": 1, "maxPartySize": 8, "bookingWindowDays": 45,
    "requirePhone": true, "requireEmail": false, "policyText": "Plans change…",
    "cardRequiredMinParty": 0, "noShowFeeCents": 2500, "waitlistOnline": true
  },
  "onlineBooking": true,
  "today": "2026-10-04",
  "cardHolds": false
}
```

`onlineBooking: false` means the restaurant is not taking online bookings right now (call instead). If `cardHolds` is true, parties of `cardRequiredMinParty` or more must save a card on a hosted Stripe page; an agent should hand that step to the person.

## 2. Availability

`GET /api/public/r/{slug}/availability?date=YYYY-MM-DD&party=N`

```json
{
  "date": "2026-10-10", "partySize": 2, "closed": false, "message": "", "largeParty": false,
  "slots": [
    { "time": 1050, "label": "5:30 PM", "available": true, "group": "Dinner" },
    { "time": 1065, "label": "5:45 PM", "available": false, "group": "Dinner" }
  ],
  "next": []
}
```

- `time` is minutes from local midnight on the service date, in the restaurant's timezone (1050 = 5:30 PM). Late seatings that run past midnight keep their service date (1470 = 12:30 AM).
- When nothing is open, `next` lists up to three later dates with open times.
- `largeParty: true` means the party is over the online limit; `message` says what to do (usually call).

## 3. Book

`POST /api/public/r/{slug}/reservations`

```json
{
  "date": "2026-10-10", "time": 1050, "partySize": 2,
  "firstName": "Ada", "lastName": "Lovelace",
  "phone": "+14155550100", "email": "ada@example.com",
  "notes": "Window if possible", "occasion": "Anniversary",
  "marketingOptIn": false, "policyAccepted": true,
  "source": "online"
}
```

- `source`: `online` (default), `website`, `google` or `instagram`. Use `online` for agents.
- `policyAccepted` is required when the restaurant has a policy; show the person `policyText` first.
- Phone numbers: US/Canada numbers in any format, otherwise `+` international.

**Responses**

- `200` booked: `{ "code": "UHD5MWS2", "status": "booked", "manageUrl": "https://…/m/UHD5MWS2?t=…", "reservation": { … } }`. Give the person the `manageUrl`: it is their only way to change or cancel online.
- `200` card required: `{ "code": "…", "status": "pending", "checkoutUrl": "https://checkout.stripe.com/…" }`. The table is held for 20 minutes while the person saves a card.
- `409` the slot is gone (`unavailable`), or the person already holds an active booking at this restaurant that day (`duplicate`; checked only after everything else passes, and the reply never says when the other booking is). Re-check availability, or use the existing booking's manage link.
- `400` validation (`invalid`), `403` online booking unavailable (`booking_unavailable`), `429` rate limited.

Errors always look like `{ "error": { "code": "unavailable", "message": "That time just filled up. Please pick another." } }`. The message is written for people; show it as is.

## 4. Manage (holder of the manage link only)

The manage link's `t` parameter is the credential. Without it these return 404.

| Call | Endpoint |
|---|---|
| View | `GET /api/public/m/{code}?t={token}` |
| Change date, time, party, notes | `POST /api/public/m/{code}/modify?t={token}` with `{ "date", "time", "partySize", "notes" }` |
| Cancel | `POST /api/public/m/{code}/cancel?t={token}` |
| Calendar file | `GET /m/{code}/calendar.ics?t={token}` |
| Availability excluding this booking | add `&code={code}&t={token}` to the availability call |

Changes and cancellations close at the restaurant's cutoff (`409 too_late`); after that, the person must call.

## 5. Waitlist (restaurants with online waitlist on)

`POST /api/public/r/{slug}/waitlist` with `{ "name", "partySize", "phone" }` returns `{ "id", "statusUrl", "quotedMin" }`. `GET /api/public/w/{id}?t={token}` returns position and status.

## 6. AI agents (MCP)

The same booking rules are available as a Model Context Protocol server, so any MCP-capable assistant (Claude, ChatGPT, or an agent framework) can book member restaurants.

- **Endpoint:** `POST {BASE_URL}/mcp`, Streamable HTTP transport, stateless, JSON responses. No sign-in: it exposes only what the public booking page already does.
- **Tools:** `search_restaurants`, `get_restaurant`, `check_availability`, `book_table`, `get_booking`, `change_booking`, `cancel_booking`. A booking returns a private `manage_url`; changing and cancelling require it, exactly like the guest's confirmation link.
- **Same rules as the booking page:** party limits, notice, pacing, one active booking per person per restaurant per day, card holds (the agent gets a `checkout_url` to hand to the person), rate limits (bookings: 12 per 10 minutes per IP).
- **Reports:** agent bookings are tagged "AI assistant," so each restaurant sees the channel.
- **Free.** There is no fee per agent booking, ever: that would be a per-cover toll under another name.
- **Add it to Claude:** Settings → Connectors → Add custom connector → `https://freeheld.io/mcp`. Other clients: point their remote MCP server setting at the same address.

## Discovery

Every booking page (`/r/{slug}`) carries schema.org `Restaurant` data with a `ReserveAction`, so crawlers and agents can find the booking entry point from the restaurant's page.

## Ground rules for agents

- Book only what the person asked for, and confirm date, time and party size with them first.
- Never invent contact details. The restaurant uses them to reach the guest.
- Pass the `manageUrl` back to the person.
- Do not hold tables speculatively. The one-booking-per-person-per-day rule exists to stop hoarding.
