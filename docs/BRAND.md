# Brand

## Decision

**Name: Freeheld.** Domain: **freeheld.io**. Tagline: **Own the book.** Value line: **Pay once. No cover fees. No rent.**

- **Held** is what a reservation is, already done: your table, held. **Free** is what each cover costs.
- It keeps the sound and rhythm of "freehold" (property you own outright) without the New Jersey search noise, and the .com problem is moot because discovery runs through search and links, not typing.
- What it gives up: "freehold" carried the ownership argument by itself; "Freeheld" does not. **The tagline does that work now, so "Own the book." goes everywhere the name goes.**

The name lives in one environment variable (`BRAND_NAME`). Changing it changes every page, email and message.

## Risks, checked October 2026

| Risk | Detail | Mitigation |
|---|---|---|
| Search noise | *Freeheld* (2015 film, Julianne Moore) and the 2007 Oscar-winning documentary short | Pair the name in search, ads and page titles: "Freeheld reservations," "Freeheld for restaurants." Restaurant pages rank on the restaurant's name, not ours |
| Trademark | A film title sits in a different class (entertainment) from restaurant software | USPTO search in Classes 9, 35, 42 and 43 before launch |
| .com | freeheld.com is not available | Discovery is search and backlinks, not typing. Do not buy it at a premium |
| Mishearing | Some will hear "freehold" | Spell it on the phone once: "free-HELD." Never mix the two names in materials |

## Domain plan

1. **freeheld.io** is the home: brand site, restaurant booking pages, and the domain that sends email and texts. Google treats .io like any generic domain for ranking, and mail from .io delivers normally.
2. **freeheld.coop** once the cooperative is formed (the registry only allows real co-ops), redirecting to freeheld.io. A trust mark more than an address.
3. Optional: a short diner-link domain later (for example yourtable.is) if text-message length starts to cost real money.

## How search and links do the work

The growth engine is every member restaurant's booking page on freeheld.io, plus the restaurants linking to it. What the product does for that:

- **Each booking page is a real, indexable page**: the restaurant's name, address and phone are in the HTML itself, with schema.org `Restaurant` and `ReserveAction` data, a canonical URL, and a title like "Book a table at Juniper & Rye." These rank for "[restaurant] reservations."
- **A sitemap** (`/sitemap.xml`, announced in `robots.txt`) lists every restaurant currently taking online bookings.
- **The website snippet is a real link.** It is `<a href=".../r/slug">Reserve a table at Juniper & Rye</a>` plus a script that turns it into a pop-up button. Search engines follow the link (an iframe or a script-only button would give nothing), and the link still works if scripts are blocked. It points to the restaurant's own booking page with the restaurant's name as the text: a link the restaurant chose to place, which is what search engines reward. **Never add hidden or keyword-stuffed credit links to the widget**: Google treats widget link schemes as spam, and it would hurt every member.
- **Ask every restaurant for three links at onboarding:** the website button, the Google Business Profile reservation link, and the Instagram bio link (OPERATIONS.md, onboarding checklist).

## Alternatives considered

**Freehold** was the original pick: the strongest meaning (property you own outright), but freehold.com and the other good domains are taken, and Freehold, NJ floods search. The others, ranked:

1. **Own the Book.** The plainest statement of what we are. A verb-phrase nonprofit brand has strong precedent: Let's Encrypt broke a paid-certificate toll the same way. .org/.app/.co appear open. Not yet conflict-searched.
2. **Bookhold.** Coined from two restaurant words, echoes "freehold" without its New Jersey noise. .org/.co appear open.
3. **Covers Co-op.** Strong and honest, but only usable if the entity is legally a cooperative (many states restrict "co-op" in names).

## Names to avoid

- **No Cover.** An iOS app, COVR, already sells reservations to independents "without the per-cover fees": same pitch, near-same name. Worse, to an operator "no covers" means an empty dining room. Keep "no cover fees" as copy, not as the name.
- **Free House.** UK term for a pub not tied to a brewery (perfect metaphor, unknown in the US). Registered restaurant trademarks exist, and "free" undercuts a $1,000 price.
- **Common Table.** Existing restaurant trademarks, and too close an echo of OpenTable.

## Positioning statement

For independent restaurant owners tired of renting their own regulars back, Freeheld is the reservation book you own outright. Pay once, no cover fees, and your guests and data stay yours. OpenTable, Resy and SevenRooms belong to companies that make money from your diners (Booking Holdings, American Express, DoorDash). Freeheld is run for, and ideally owned by, the restaurants that use it.

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

Every confirmation email and booking page ends with "Booked with Freeheld, reservations restaurants own." Diners include restaurant owners, and this footer is the cheapest channel we will ever have. Keep it one line and never louder.

## Before launch (checklist)

- [ ] USPTO search for Freeheld and Own the Book in Classes 9, 35, 42 and 43 (attorney review recommended)
- [ ] Buy freeheld.io; register freeheld.coop when the cooperative is formed
- [x] License decided: AGPL-3.0 (LICENSE file, source link on every page)
- [ ] Make the repository public (or a public mirror) before launch, so the AGPL source link works
- [ ] Re-verify every competitor price on the landing page against vendor pages, with the date
- [ ] Set `BRAND_NAME` and `SUPPORT_EMAIL` in production
