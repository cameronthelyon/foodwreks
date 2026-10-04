# Strategy

The plan for a pay-once reservation system for independent restaurants, run through the operating system: hedgehog and fox, three circles, E-Myth, Obvious Adams, Traction, and the bottleneck.

Figures are from vendor pages and filings as surfaced in October 2026 research. Several came from search extracts because the research proxy blocked direct page loads; those are marked. **Verify every competitor number before it appears in public marketing.**

---

## The one-paragraph version

The software is the easy part, and it is built (this repo). The fight is over **demand and trust**, not features. Per-cover tolls are real but narrower than "everyone takes a cut": OpenTable tolls covers, while Resy, Yelp, SevenRooms and Tock charge rent. Restaurants pay OpenTable for diners they believe they would not otherwise get. So the product must plug restaurants straight into where diners actually look (Google first, AI agents next) at zero marginal cost, make leaving the incumbent painless, and make "lifetime" credible: open source, export everything, and run by an organization that cannot be flipped. The $1,000 price works as a wedge (payback in weeks against OpenTable). It only works as a business if support is designed out and texting is passed through at cost.

---

## Brutal facts

**1. The "vig" is real, but only one incumbent charges it.**

| Platform | Monthly | Per cover | Source |
|---|---|---|---|
| OpenTable Basic | $149 | $1.50 network; website $0.25 (or $49/mo flat) | opentable.com/restaurant-solutions/plans |
| OpenTable Core | $299 | $1.00 network; website free | same |
| OpenTable Pro | $499 | $1.00 network (Pro rate from third parties) | same, G2, Eat App |
| Resy Platform / 360 | $289 / $459 | none | resy.com/resyos/plans-and-pricing |
| Tock (folding into Resy, 2026) | $289 / $459 | none; 2-3% of prepayments | exploretock.com/join/pricing |
| Yelp Guest Manager | $159 / $349 | none (Basic capped at 500 covers) | business.yelp.com |
| SevenRooms | quote only | none; setup fee; fee on pre-sales | sevenrooms.com/pricing |

The detail that matters most: **OpenTable bills Google-sourced bookings at its network rate** (OpenTable help article on cover reports). Restaurants pay a toll on diners who found them on Google Maps. That is the vig worth attacking, and it is attackable.

OpenTable also added a 2% service fee on no-show charges, deposits and prepaid experiences in H2 2025 (Philadelphia Inquirer, Jan 2026). Its 2026 terms reportedly require it to be the restaurant's "system of record" with all inventory on its marketplace; a Seattle business chamber asked the Washington AG to review them (Washington State Standard, Apr 2026). Lock-in is tightening. That is our opening.

**2. Booking software is a commodity. The network is the moat.**
resOS has a free tier (25 bookings/mo). Eat App is free up to 100 covers. A WordPress plugin is free. Toast sells its own Tables add-on. Nobody pays $3,000 to $25,000 a year for a widget; they pay for diners. OpenTable claims 33 million diners a month and 65,000 to 70,000 restaurants. We will not out-network that, and should not try.

**3. The reservation layer is being bought by companies that monetize the diner.**
American Express owns Resy and bought Tock ($400M, 2024; merging into Resy in 2026). DoorDash bought SevenRooms (~$1.2B, closed June 2025) and launched "Going Out," letting diners book SevenRooms restaurants in the DoorDash app with zero cover fees. Booking Holdings owns OpenTable. In every case the restaurant is inventory and the diner is the customer. A restaurant-owned alternative has a story none of them can tell.

**4. Direct demand is bigger than the incumbents imply.**
Toast's 2025 survey says 65% of diners book directly on the restaurant's website. That is a vendor survey; treat it as directional, not proof. OpenTable's counter-claim (c. 2021): its diners are about twice as likely to return and 40% less likely to no-show than search-engine bookers. Both are marketing. **Our reports measure each restaurant's actual channel mix, so the argument gets settled with its own data.**

**5. "Lifetime" is a liability that compounds.**
One payment, perpetual cost. The math is below. The short version: the license covers software forever; it does not cover humans forever.

**6. Every POS integration is a perpetual maintenance bill.**
Toast (~180,000 locations at 6/30/2026) lets restaurants self-provision read-only "Standard API access." Square is fully open. Clover needs App Market approval. SpotOn, TouchBistro, Revel, Aloha and Simphony are gated partner programs. Only Toast exposes table and guest count on orders. POS integration is a nice-to-have for reservations, not a requirement; most OpenTable restaurants run without one.

**7. AI agents are becoming the next demand aggregator.**
Google's AI Mode now books tables "agentically" through named partners (OpenTable, Resy, Tock). OpenTable claims 17x year-over-year growth in seated diners from AI chat tools (Aug 2026). A booking system that agents cannot reach becomes invisible.

---

## Hedgehog: what we are

**Restaurants own their book.**

The reservation book is infrastructure the restaurant owns, like its lease and its recipes, not a service it rents from a company that monetizes its diners. Every product, pricing and partnership decision runs through one test: *does this keep the guest relationship with the restaurant?*

**Three circles**

| Circle | Answer |
|---|---|
| Best in the world at | The cheapest-to-operate, most portable reservation system for independent restaurants. Not the biggest network, not the fanciest CRM. |
| Economic engine | One-time license per location, treated as an endowment (see math), plus optional paid onboarding and support, plus grants for small-business programs. Measure: licenses sold per year against cost to serve. |
| Deep passion | Independent restaurants keeping their margins and their regulars. |

## Fox: how we get there

Methods are flexible. The identity is not.

- **Open source (AGPL-3.0, decided) plus one-click export.** This is what makes "lifetime" believable: even if the organization fails, the book keeps working. AGPL specifically stops a funded company from forking the code into a closed competitor: anyone who runs a modified copy as a service must publish their changes.
- **Google first.** Day one: every restaurant puts its booking link (tagged `?ref=google`) on its Google Business Profile. No partnership needed. Next: Google Actions Center "Reservations Redirect" or "Business Link" (feeds only). Then "Reservations end-to-end" (booking inside Google). Google lists no minimum merchant count in the docs; it requires a contract with every merchant, real-time availability, and 30+ days of inventory. The booking server and feeds are already built (`lib/google.js`) and need partner approval plus sandbox review.
- **Agent-ready.** Booking pages carry schema.org `ReserveAction` data, and the public availability and booking API is plain JSON, documented in [API.md](API.md) so any AI agent can book any member restaurant without a toll. Next step: an MCP server wrapping the same calls.
- **Three POS integrations, read-only, then stop.** Toast, Square, Clover. A fourth only when paying members ask for it.
- **Distribution through institutions that already serve small business.** Restaurant associations, POS resellers, Small Business Development Centers, culinary programs, and restaurant-owner peer groups. Each member restaurant is also a recruiter: owners trust owners.

---

## Obvious Adams: what is plainly in front of us

1. **Diners search Google Maps.** The highest-leverage feature is a Reserve button on Google that costs nothing per cover. It ships day one (it is just a link).
2. **Restaurants already export their guest lists.** The switching cost is a CSV. The importer maps OpenTable, Resy and spreadsheet columns automatically and never messages guests.
3. **Owners trust other owners, not ads.** Every confirmation email carries a small "Booked with Freeheld" footer, and diners include restaurant owners.
4. **The money argument settles itself.** The landing page has a payback calculator. The reports page shows each restaurant the covers it got from Google and Instagram, the ones OpenTable would have tolled.

---

## The bottleneck (Goldratt)

**For a restaurant deciding to switch, the constraints in order:**

| Constraint | Fix | Status |
|---|---|---|
| Fear of losing marketplace diners | Google link day one; per-channel reporting; parallel-run cutover checklist | Built |
| Migration pain (guests, future bookings) | CSV import with auto-mapping, duplicate detection, no guest messages | Built |
| Host stand retraining | List, timeline and waitlist with one-tap actions; 15-minute training | Built |
| Trust: "will you exist in ten years?" | Open source (AGPL), full export, cooperative structure | Decided; co-op not yet formed |
| Card holds and no-show protection | Restaurant's own Stripe account; we never touch the money | Built |

**For the venture, the bottleneck is distribution and support, not software.** The software exists. The constraint is getting the first 25 restaurants to cut over and keeping support load low enough that the endowment survives. Fix that constraint before adding any feature.

**Bet on the bottleneck, not the beneficiary.** In reservations, the bottleneck is demand aggregation: Google Maps today, AI agents tomorrow. Booking software is the beneficiary, and a commodity one. So do not compete on software features. Own the cheapest, most portable pipe between restaurants and the aggregators, and let restaurants keep what flows through it.

---

## Endowment math: can $1,000 really mean lifetime?

**What $1,000 sustains** (endowment draw rates per NACUBO/Commonfund; private foundations must pay out 5%):

| Draw rate | Per restaurant per year |
|---|---|
| 3.5% (conservative) | $35 |
| 4% | $40 |
| 5% | $50 |

**What a restaurant costs to serve per year** (assumptions: 3,000 bookings/yr, 3 emails each):

| Item | Cost | Covered by license? |
|---|---|---|
| Hosting: one ~$40/mo server serves thousands of restaurants (SQLite, one process) | under $1 | Yes |
| Email: ~9,000/yr. SES $0.10-0.16 per 1,000; Resend ~$0.40; Postmark ~$1.50 | $1 to $14 | Yes |
| Card processing on the license itself (Stripe ~2.9% + 30¢) | $29.30 once | Yes, once |
| Texting: Twilio $0.0083/segment + carrier fees (AT&T $0.0035, T-Mobile $0.0045, Verizon $0.0050 since Oct 1, 2026) ≈ **$0.0126/segment** | ~$150/yr at 1,000 texts/mo | **No: pass through at cost** |
| Texting compliance: each restaurant is its own 10DLC brand ($4.50 brand + $15 campaign vetting + $1.50-10/mo) or a verified toll-free number (free, EIN required since Feb 2026) | $20 to $140/yr | **No: pass through** |
| Human support: one $85k loaded FTE handling 750 restaurants | **~$113/yr** | **No, and this decides survival** |

**Conclusion.** The license pays for the software forever. It does not pay for people forever: support at $113/yr is roughly three times the endowment yield. Three non-negotiables follow:

1. **Design support out.** Self-serve onboarding (the in-app checklist), documented processes (OPERATIONS.md), community office hours instead of a phone line.
2. **Sell humans separately.** Optional paid onboarding ($250-500) and an optional support plan (~$150/yr). Software stays pay-once; people cost money.
3. **Bank the license.** Put a fixed share (suggest 60%) of every license into a reserve fund on day one. If all $1,000 goes to acquisition, there is no endowment, just a lifetime promise with nothing behind it.

**Payback for the restaurant** (published prices, 400 network-rate covers/month): OpenTable Core costs $8,388/yr, so $1,000 pays back in **44 days**. Resy Platform ($3,468/yr): about 105 days. Yelp Guest Manager Basic ($1,908/yr): about 191 days. The pitch is strongest against OpenTable and weakest against Yelp Basic. Know which one you are selling against.

**Pricing discipline.** Hold $1,000 for founding members. Precedent for raising later while honoring early buyers: Plex raised its lifetime pass from $119.99 to $249.99 in 2025. Define "lifetime" in the contract: per location, for as long as you operate it, transferable on sale (the SMS brand follows the EIN, so transfers need re-registration), with data export forever and source release guaranteed.

---

## Structure: a cooperative (decided)

*Not legal advice. Exempt-organization counsel needed before anything is signed.*

- **501(c)(3).** Selling licenses to for-profit restaurants at market rate is likely unrelated business income: 21% tax on net, plus the bigger risk that sales become the primary activity and threaten the exemption itself (commerciality, private benefit). It can be related if it serves a charitable class: Rev. Rul. 74-587 covers assistance to businesses in economically depressed areas. In practice that means a c3 serving defined low-income communities, with a taxable subsidiary selling to everyone else.
- **501(c)(6).** Does not fix it. Particular services sold to members are unrelated business income.
- **Cooperative (chosen).** Under California's Consumer Cooperative Corporation Law, restaurants buy a **$1,000 member share**: lifetime access, one vote, and patronage dividends if there is surplus. That is the hedgehog made legal: restaurants literally own the book. Precedents: Ace Hardware (retailer-owned since 1976), franchisee purchasing co-ops (Yum!'s UFPC, Subway's IPC), platform co-ops (Stocksy, The Drivers Cooperative). Watch: a member share can raise securities questions.
- **The warning:** True Value. A co-op that sold control to private equity (2018), lost its co-op character, and went bankrupt (2024). Put an asset lock in the bylaws: the software and member data cannot be sold out from under members.
- **Shape:** a cooperative owned by member restaurants, plus a 501(c)(3) partner or fiscal sponsor that funds onboarding for restaurants in low-income communities through grants.

---

## What would kill this

1. **Support load outruns the endowment.** Mitigation: the three non-negotiables above. Track support minutes per restaurant weekly.
2. **Google never approves the integration, and AI agents route around us.** Mitigation: the link path works without approval; publish an open booking API; apply to the Actions Center early.
3. **An incumbent gives reservations away.** DoorDash already charges zero cover fees for SevenRooms restaurants. If OpenTable drops Basic to $0, the price story weakens, and the ownership story becomes the whole pitch. Make it the whole pitch from day one.
4. **Texting costs and compliance.** Carriers raised fees twice in 2026. Mitigation: email first, texting optional and pass-through, toll-free verification per restaurant.
5. **The business stays trapped in the founders' heads** (E-Myth). Mitigation: OPERATIONS.md is the franchise prototype. Every recurring task is a checklist someone else can run.
6. **A future sale breaks the lifetime promise.** Mitigation: the co-op asset lock, open source, source escrow.

---

## Next 90 days (Rocks)

| # | Rock | Done means |
|---|---|---|
| 1 | Five pilot restaurants live | Cut over from OpenTable or Resy using the checklist; two full services each without the old system |
| 2 | Cooperative formed | Counsel engaged; articles and bylaws filed with the asset lock; member share terms reviewed for securities questions; trademark search on Freeheld; freeheld.io live (freeheld.coop once the co-op exists) |
| 3 | Production ready | Deployed with backups and a tested restore; Postmark live; toll-free texting verified for pilots |
| 4 | Google channel live | Every pilot has the GBP reservation link; Actions Center interest form submitted |
| 5 | One POS validated | Toast Standard API access tested against a pilot's real data |

**Weekly scorecard (Level 10):** restaurants live · covers booked · share of covers from Google, Instagram and website · no-show rate · support tickets and minutes per restaurant · texting cost per restaurant · failed messages · uptime.

**Accountability chart (suggested, yours to change):**

| Seat | Owns | Suggested |
|---|---|---|
| Visionary | Strategy, partnerships, the co-op story, institutional channels | Cameron |
| Integrator | Operations, checklists, pilot quality, the weekly scorecard | Nathalie |
| Technology | Deploys, integrations, security, releases | Contract engineer (part-time) |
| Restaurant success | Onboarding, cutovers, support | First hire, or a pilot owner on contract |
| Finance and legal | Reserve fund, entity, counsel, contracts | Bookkeeper + counsel |
