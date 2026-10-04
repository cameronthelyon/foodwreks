# Brand

## Recommendation

**Name: Freehold.** Tagline: **Own the book.** Value line: **Pay once. No cover fees. No rent.**

*Freehold* earns its place three ways at once, all on message:

- **Freehold** is property you own outright, the opposite of a leasehold you rent forever. That is the whole pitch against SaaS rent.
- **Hold** is what a reservation *is*. "We'll hold the table for you."
- **Free** is what a cover costs.

"Own the book" is the hedgehog in four syllables. Restaurant staff call the reservation system "the book," and owning it is the point.

The name lives in one environment variable (`BRAND_NAME`). Changing it changes every page, email and message.

## Risks, checked October 2026

| Risk | Detail | Mitigation |
|---|---|---|
| Search noise | Freehold, New Jersey (two towns) floods results | Always pair it in search and ads: "Freehold Reservations," "Freehold for restaurants" |
| Same-name venue | Freehold Brooklyn, a bar and event space since 2015 | Different class (restaurant services vs software); still run a USPTO search |
| Existing mark | FREEHOLD (apparel) | Different class |
| Domains | freehold.com/.org/.app registered (parked); get-/use-/join-freehold.com registered | See the domain plan below |

Domain status came from DNS lookups, not registrar checks (RDAP was blocked). Confirm at a registrar before relying on it.

## Domain plan

freehold.com is taken and parked. Do not chase it: buying a parked premium name costs real money and buys nothing a diner will notice, because diners reach restaurants through the restaurant's own page and Google, not by typing our domain.

1. **freehold.coop as the home.** .coop is open only to real cooperatives (the registry verifies), so the domain itself says "owned by its members." It is the brand and the structure in one address. Register it as soon as the cooperative exists; check with the registry whether a co-op in formation qualifies earlier.
2. **freeholdtables.com now, as a holding .com.** Buy it today, use it until .coop is live, then redirect it there forever. People who guess ".com" still land somewhere.
3. **Optional defensive names:** freehold.restaurant, freeholdreservations.com.

All of these had no DNS records on October 4, 2026. No DNS usually means unregistered but not always; confirm at a registrar before relying on it.

## Alternatives, ranked

1. **Own the Book.** The plainest statement of what we are. A verb-phrase nonprofit brand has strong precedent: Let's Encrypt broke a paid-certificate toll the same way. .org/.app/.co appear open. Not yet conflict-searched.
2. **Bookhold.** Coined from two restaurant words, echoes "freehold" without the New Jersey noise. .org/.co appear open.
3. **Covers Co-op.** Strong and honest, but only usable if the entity is legally a cooperative (many states restrict "co-op" in names).

## Names to avoid

- **No Cover.** An iOS app, COVR, already sells reservations to independents "without the per-cover fees": same pitch, near-same name. Worse, to an operator "no covers" means an empty dining room. Keep "no cover fees" as copy, not as the name.
- **Free House.** UK term for a pub not tied to a brewery (perfect metaphor, unknown in the US). Registered restaurant trademarks exist, and "free" undercuts a $1,000 price.
- **Common Table.** Existing restaurant trademarks, and too close an echo of OpenTable.

## Positioning statement

For independent restaurant owners tired of renting their own regulars back, Freehold is the reservation book you own outright. Pay once, no cover fees, and your guests and data stay yours. OpenTable, Resy and SevenRooms belong to companies that make money from your diners (Booking Holdings, American Express, DoorDash). Freehold is run for, and ideally owned by, the restaurants that use it.

## Message hierarchy

1. **Own the book.**
2. Pay once. No cover fees. No rent.
3. Your guests stay yours: export everything, any day.
4. Built to last: open source, run as community infrastructure.

Proof points, in the product: the payback calculator on the landing page, and the "fees avoided" figure in every restaurant's reports.

## Voice

- **Operator-literate:** covers, turns, the book, the stand, pacing, no-shows. Never "seamless dining experiences."
- **Plain and warm:** short sentences, the way a good general manager talks.
- **Honest to a fault:** the FAQ admits what we cannot do ("Some, possibly" to the question of losing marketplace diners). Skeptical owners have been oversold. Candor is the differentiator.
- **Never:** "revolutionize," "disrupt," exclamation points in product copy, or a claim about a competitor without a source and a date.

## Visual identity

- **Mark:** a bookmark ribbon on a ledger-green square. A ribbon holds your place in a book: the literal metaphor of a reservation. It is in `public/assets/favicon.svg` and drawn inline in the header.
- **Color:** ledger green `#1F4D3F` (UI accent), paper `#F6F2EA`, ink `#1C1A17`. Charts use a separate green, `#2E8B6A` (dark mode `#34A57F`). The UI green fails the data-viz lightness and chroma checks; the chart green passes them.
- **Type:** serif headings (Iowan Old Style, Palatino, Georgia stack) for the feel of a book; system sans for the interface; sans for every number. System fonts only: zero web-font requests, faster pages, nothing to license.
- **Dark mode** is designed, not inverted. Host stands sit in dim dining rooms at night.
- **Restaurants come first on their own pages.** Booking pages use the restaurant's accent color and name. Ours is one small footer line.

## Growth loop

Every confirmation email and booking page ends with "Booked with Freehold, reservations restaurants own." Diners include restaurant owners, and this footer is the cheapest channel we will ever have. Keep it one line and never louder.

## Before launch (checklist)

- [ ] USPTO search for Freehold, Own the Book and Bookhold in Classes 9, 35, 42 and 43 (attorney review recommended)
- [ ] Buy freeholdtables.com now; register freehold.coop when the cooperative is formed
- [x] License decided: AGPL-3.0 (LICENSE file, source link on every page)
- [ ] Make the repository public (or a public mirror) before launch, so the AGPL source link works
- [ ] Re-verify every competitor price on the landing page against vendor pages, with the date
- [ ] Set `BRAND_NAME` and `SUPPORT_EMAIL` in production
