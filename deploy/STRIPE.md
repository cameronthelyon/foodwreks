# Setting up Stripe

One Stripe account (yours, the platform's) does two jobs:

1. **License payments.** Owners pay the $1,000 license by card; a webhook activates it.
2. **Stripe Connect.** Restaurants link their own Stripe accounts with one click, so card holds and no-show fees run on *their* account. Money goes straight to them. We set no fee of our own, and with Standard accounts Stripe charges the platform nothing for Connect.

Do everything in **test mode** first. Stripe dashboard labels move around; if a menu name below differs, search the dashboard for it.

## 0. Before you start

- [ ] **Decide whose account this is.** Stripe needs a legal business (with its tax ID) and a bank account for payouts. The cooperative does not exist yet. Until it does, either collect license payments under an existing entity you control, or hold off on taking payments and mark early licenses paid by hand at `/admin`. Ask counsel, since licenses are planned to become co-op member shares.
- [ ] A password manager entry for each key and secret below.

## 1. API key

- [ ] Developers → API keys: copy the **secret key** (`sk_test_…`).
- [ ] This is `PLATFORM_STRIPE_SECRET_KEY`. Treat it like a bank password: it can act on every connected restaurant's account.

## 2. Webhook for license payments

- [ ] Developers → Webhooks → Add endpoint. Listen to events on **your account**.
  - URL: `https://freeheld.io/webhooks/stripe`
  - Event: `checkout.session.completed`
- [ ] Copy its signing secret (`whsec_…`). This is `PLATFORM_STRIPE_WEBHOOK_SECRET`.

## 3. Stripe Connect

- [ ] Settings → Connect: get started, and fill in the platform profile (what Freeheld does: reservation software; restaurants accept card holds and no-show fees on their own Stripe accounts).
- [ ] Connect → Onboarding options (or Settings → Connect → OAuth): **enable OAuth for Standard accounts**.
- [ ] Add the redirect URI: `https://freeheld.io/oauth/stripe/callback`
- [ ] Copy the **client ID** (`ca_…`). This is `STRIPE_CONNECT_CLIENT_ID`. Test mode and live mode have different client IDs.
- [ ] Developers → Webhooks → Add endpoint. Listen to events on **connected accounts**.
  - URL: `https://freeheld.io/webhooks/stripe` (the same address is fine)
  - Event: `account.application.deauthorized` (a restaurant revoking access from its own Stripe dashboard)
- [ ] Copy that endpoint's signing secret. This is `STRIPE_CONNECT_WEBHOOK_SECRET`.

## 4. Put the values on the server

```bash
nano /etc/freeheld/freeheld.env
```

Add (or uncomment) these four lines with your values, save, then restart:

```
PLATFORM_STRIPE_SECRET_KEY=sk_test_...
PLATFORM_STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CONNECT_CLIENT_ID=ca_...
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...
```

```bash
systemctl restart freeheld
```

## 5. Test it (test mode, nothing real is charged)

**Connect and card holds**, as the Test Kitchen owner:
- [ ] Settings → No-show protection shows **Connect with Stripe**
- [ ] Click it, then create or choose a test account on Stripe's page (test mode offers a shortcut). You land back on Freeheld with "Stripe connected" and a "Test mode" badge
- [ ] Set "Require a card for parties of" to 2, and a fee of $25 per guest
- [ ] On the booking page, book a party of 2. Stripe's card page opens: use card `4242 4242 4242 4242`, any future date, any CVC
- [ ] The booking shows as Booked, with a card on file
- [ ] In the host stand, mark it No-show, then press Charge. The $50 appears as a payment **in the test restaurant's Stripe account**, not yours
- [ ] Disconnect from Settings: the connection disappears on both sides

**License payment:**
- [ ] Settings → License → Pay $1,000 and activate. Pay with `4242 4242 4242 4242`
- [ ] Back in Freeheld, the license shows Lifetime within seconds (that is the webhook working)
- [ ] At `/admin`, set Test Kitchen back to trial

If a step fails: `journalctl -u freeheld -n 50`, and Developers → Webhooks → the endpoint's recent deliveries in Stripe.

## 6. Go live

- [ ] Activate your Stripe account for live payments (business and bank details)
- [ ] In **live mode**, repeat steps 1 to 3. Live mode has its own secret key, its own client ID, and its own webhook endpoints and signing secrets
- [ ] Replace the four values on the server with the live ones; restart
- [ ] Restaurants that connected in test mode connect again (test connections do not carry over)

## What restaurants pay, and what you pay

- **Restaurants:** Stripe's standard card processing on their own no-show charges, paid to Stripe. Nothing to Freeheld.
- **You:** Stripe's standard card processing on each license payment (about 3% of $1,000). No Connect fees for Standard accounts.
