# FoodWreks

Find the best restaurant near you by pooling reviews from Google, Yelp, Tripadvisor and OpenStreetMap, then let a wheel make the final call.

- **Location**: browser geolocation, or type an address / city / ZIP.
- **Aggregation**: the same restaurant is matched across sources (name, distance, phone), and its ratings are blended into one score.
- **Filters**: distance, price ($ to $$$$), minimum score, minimum review count, minimum number of rated sources, open now, cuisine include/exclude, hidden gems only, hide mixed reviews, include unrated.
- **Wheel**: spins over the top N filtered results (or your hand-picked ★ pins), optionally weighted so better places get bigger slices. Veto a winner and respin.

Zero dependencies. Node 20.12+ and a browser.

## Quick start

```bash
npm run demo        # synthetic data, no keys needed: http://localhost:3000
```

For real data:

```bash
cp .env.example .env   # add whichever keys you have
npm start
```

Every source is optional. With no keys at all, only OpenStreetMap runs, which finds places but has **no ratings**; you will need to tick "Include unrated places" to see anything.

| Source | Key | What it adds | Cost notes |
|---|---|---|---|
| Google Places (New) | `GOOGLE_PLACES_API_KEY` | Up to 60 places, rating, review count, price, open now | Rating, price and hours fields bill at the higher Text Search tier. Check current pricing. |
| Yelp Fusion | `YELP_API_KEY` | Up to 100 places, rating, review count, price, categories | Yelp moved its API to paid plans in 2024 (trial available). |
| Tripadvisor Content API | `TRIPADVISOR_API_KEY` | 10 places with rating, review count, price, cuisine | 11 calls per search (1 nearby + 10 details). Keys are IP/domain restricted; set `TRIPADVISOR_REFERER` if you restricted by domain. |
| OpenStreetMap (Overpass) | none | Discovery, cuisine tags, phone, website | Free; please don't hammer the public server. Set `OVERPASS_URL` to use a mirror, `OSM_DISABLED=1` to turn it off. |

Responses are cached in memory for 10 minutes on a ~110 m grid, so moving filters around never re-bills an API. Only the distance slider triggers a new search.

## How scoring works

1. **Match.** Records are clustered in source order (Google, Yelp, Tripadvisor, OSM). A record joins an existing restaurant if it is from a source not already in it and either the phone numbers match within 400 m, the names are a strong match (≥ 0.5 token similarity) within 150 m, or a weaker match (≥ 0.34) within 40 m. Chains with the same name at different addresses stay separate.
2. **Blend.** Each source's rating is weighted by its review count, capped at 500 per source so one platform's volume (usually Google's) can't drown out the rest.
3. **Shrink.** A Bayesian average pulls the blend toward the local average with the weight of 30 reviews: `score = (blend × weight + localAvg × 30) / (weight + 30)`. A 5.0 with 3 reviews no longer beats a 4.7 with 2,000.
4. **Tag.** *Top pick* (#1), *Hidden gem* (≥ 0.3 above local average with relatively few reviews), *Crowd favorite* (heavily reviewed and above average), *Mixed reviews* (sources disagree by ≥ 0.75 stars).

Knobs live in `SCORING` in `lib/aggregate.js`.

## Layout

```
server.js               static files + /api/restaurants, /api/geocode, /api/config
lib/aggregate.js        matching, blending, scoring, tags
lib/normalize.js        names, phones, distance, price and cuisine mapping
lib/providers/*.js      one file per source, each exporting search() and toRecord()
public/                 index.html, app.js (state, filters, list), wheel.js (canvas wheel)
test/                   node:test suites (npm test)
```

Adding a source means writing one provider file that returns records in the shared shape (`source, id, name, lat, lng, rating, reviewCount, price, cuisines, url, openNow, ...`) and adding it to `PROVIDERS` in `server.js`.

## Known limits

- Google returns at most 60 results per query and Yelp at most 100 here, so very dense areas are sampled, not exhaustive.
- "Open now" only knows what Google and Yelp report. With it on, places with unknown hours are dropped.
- Address lookup uses OpenStreetMap's Nominatim (1 request/second policy).
- Review the Google, Yelp and Tripadvisor terms before deploying publicly. They have attribution and caching rules; every result here links back to its source.
