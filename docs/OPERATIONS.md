# Operations manual

The franchise prototype: every recurring job written down so that someone other than the founders can run it. Each list is **READ-DO**: read a line, do it, tick it. Do not skip lines because you "know this one."

---

## 1. Deploy a production server

**Target:** one small Linux VM (2 vCPU, 2-4 GB RAM, SSD), Node.js 22.13+ (current LTS preferred), and a reverse proxy for TLS. Docker also works (see `Dockerfile`).

- [ ] Create a non-root user `freeheld`; clone the repository to `/opt/freeheld`
- [ ] Create `/opt/freeheld/.env` from `.env.example`. Set at minimum: `NODE_ENV=production`, `BASE_URL=https://freeheld.io`, `APP_SECRET` (`openssl rand -base64 48`), `DATABASE_PATH=/var/lib/freeheld/freeheld.db`, `TRUST_PROXY=1`, `BRAND_NAME`, `SUPPORT_EMAIL=info@freeheld.io`, `SOURCE_URL` (public repository of the exact code deployed; the AGPL requires it)
- [ ] **Store `APP_SECRET` in your password manager.** Losing it makes integration credentials unreadable and invalidates every manage link and session
- [ ] Set email: `EMAIL_PROVIDER`, its key, and `EMAIL_FROM=Freeheld <reservations@freeheld.io>`
- [ ] DNS for freeheld.io email, from the provider's domain page: the DKIM TXT record, the Return-Path CNAME, and an SPF record if the provider asks for one. Add DMARC: `_dmarc.freeheld.io TXT "v=DMARC1; p=none; rua=mailto:info@freeheld.io"`, then move to `p=quarantine` after two clean weeks of reports
- [ ] Check that info@freeheld.io receives mail (it is the support address, the Reply-To on account emails, and where DMARC reports land)
- [ ] Send a test confirmation to a Gmail and an Outlook address. Both arrive in the inbox, the sender reads "Restaurant via Freeheld", and replying addresses the restaurant
- [ ] `mkdir -p /var/lib/freeheld && chown freeheld /var/lib/freeheld`
- [ ] Install the systemd unit below; `systemctl enable --now freeheld`
- [ ] Put Caddy (or nginx) in front for TLS (Caddyfile below)
- [ ] Check `https://freeheld.io/healthz` returns `{"ok":true}`
- [ ] Sign up the first account, then make it a platform admin: `sqlite3 /var/lib/freeheld/freeheld.db "UPDATE users SET is_platform_admin = 1 WHERE email = 'you@example.org'"`
- [ ] Set up off-box backups (section 4) and **run a restore drill (section 5) before the first restaurant goes live**
- [ ] Optional: `SIGNUPS_OPEN=0` during pilots, creating accounts by invitation

```ini
# /etc/systemd/system/freeheld.service
[Unit]
Description=Freeheld reservations
After=network.target

[Service]
User=freeheld
WorkingDirectory=/opt/freeheld
EnvironmentFile=/opt/freeheld/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/lib/freeheld

[Install]
WantedBy=multi-user.target
```

```
# /etc/caddy/Caddyfile
freeheld.io {
  reverse_proxy 127.0.0.1:3000
}

# One canonical address for search engines.
www.freeheld.io {
  redir https://freeheld.io{uri} permanent
}
```

Server-sent events need proxy buffering off. Caddy streams by default; for nginx add `proxy_buffering off;` on `/api/`.

---

## 2. Release a new version

- [ ] `npm test` passes locally (all green, no skips)
- [ ] Read the diff for migrations (`lib/db.js` MIGRATIONS). New migrations only append; never edit a shipped one
- [ ] Take a manual backup first: `sqlite3 /var/lib/freeheld/freeheld.db ".backup /var/lib/freeheld/pre-release.db"`
- [ ] Deploy outside service hours (mid-afternoon, never 5 to 9 PM local)
- [ ] `git pull && systemctl restart freeheld`
- [ ] `/healthz` is OK; log in; open one restaurant's Book and Floor views; load one booking page
- [ ] Watch logs for 10 minutes: `journalctl -u freeheld -f`
- [ ] If anything is wrong: `git checkout <previous tag>`, restore `pre-release.db` if a migration ran, restart

---

## 3. Weekly checks (15 minutes, same day each week)

- [ ] `/admin`: messages sent vs failed. Investigate any failure pattern (wrong domain records, an invalid number repeated)
- [ ] `/admin`: integration errors. Re-auth or contact the restaurant
- [ ] Disk: `df -h /var/lib/freeheld` under 70%
- [ ] Newest backup is from the last 24 hours, and an off-box copy exists
- [ ] Trials ending in the next 7 days: personal note to each owner
- [ ] Update the scorecard (STRATEGY.md): restaurants live, covers, channel mix, no-show rate, support minutes per restaurant, texting cost, failed messages, uptime

---

## 4. Backups

The server writes a consistent snapshot every `BACKUP_INTERVAL_HOURS` (default 24) to `BACKUP_DIR` and keeps `BACKUP_KEEP` (default 14). **Snapshots on the same disk are not backups.**

- [ ] Copy snapshots off the box nightly, for example `rclone copy /var/lib/freeheld/backups remote:freeheld-backups` on a cron at 4 AM
- [ ] Better: run Litestream for continuous replication of `freeheld.db` to object storage
- [ ] Keep at least one monthly copy for a year

---

## 5. Restore drill (monthly, and before the first live restaurant)

- [ ] On a scratch machine, download last night's snapshot
- [ ] `DATABASE_PATH=./restored.db APP_SECRET=<production secret> PORT=3999 node server.js`
- [ ] Log in, open a restaurant, confirm last night's bookings are there
- [ ] Note how long it took. Target: under 30 minutes from "server gone" to "booking pages back"
- [ ] Delete the scratch copy (it contains guest data)

---

## 6. Onboard a restaurant (one 60-minute call)

Before the call:
- [ ] Owner has signed up (or you created the account with `SIGNUPS_OPEN=0`)
- [ ] Ask them to export from their current system: guest list CSV and upcoming reservations CSV

On the call (share their screen):
- [ ] **Floor plan:** rename the starter tables to their real names; set min/max covers; untick "online" on walk-in-only tables (bar, chef's counter); add combinations they actually push together
- [ ] **Hours:** each shift with real first and last seating; pacing (start with covers per 15-minute slot at about 1.5x their kitchen's comfortable pace, adjust after a week)
- [ ] **Turn times** by party size from their own experience
- [ ] **Booking rules:** online party limit, notice, cancellation cutoff, policy text
- [ ] **Messages:** email on; reminder 24h; staff alert email
- [ ] **Import** guests, then reservations. Check the "needs a table" lane on the Floor view for any upcoming bookings without a table
- [ ] **Test booking** from their phone on the booking page; cancel it from the email link
- [ ] **Team:** invite managers and hosts
- [ ] **Share:** website widget snippet to their web person; Google Business Profile link (do it together); Instagram bio link
- [ ] Book the cutover date (section 7)

---

## 7. Cutover from OpenTable, Resy, Tock or Yelp

Run both systems for one service, then switch. Never switch on a Friday.

**T minus 3 days**
- [ ] Fresh export of future reservations from the old system; import (duplicates are skipped by confirmation number)
- [ ] Website button, Google link and Instagram link point at the new booking page

**Cutover day (a quiet weekday)**
- [ ] Morning: close online availability in the old system (do not cancel the account)
- [ ] One more export and import to catch anything booked since T-3
- [ ] Brief the host team: Book view, one-tap Arrived/Seat/Done, walk-ins, waitlist, the "needs a table" lane
- [ ] Service runs on the new book only. Honor anything that still arrives in the old system and enter it by hand

**T plus 7 days**
- [ ] No new bookings arriving in the old system
- [ ] Old account kept until the last old booking has been served

**T plus 30 days**
- [ ] Cancel the old subscription. Save the cancellation confirmation
- [ ] Show the owner Reports: channel mix, no-show rate, fees avoided

---

## 8. Text messages for a restaurant

- [ ] Restaurant has decided it wants texting (email-only is fine for many)
- [ ] Collect legal business name, EIN, address, website, contact
- [ ] Register a toll-free number for them in Twilio and submit toll-free verification (use case: reservation confirmations, reminders and waitlist alerts; opt-in at booking). Allow 3 to 5 business days
- [ ] After approval, set the number for their messages and switch on Settings → Guest messages → Text them too
- [ ] Explain cost: about 1.3¢ per text in carrier fees, passed through at cost

---

## 9. Support triage

| Priority | Examples | Response |
|---|---|---|
| P1 | Booking pages down; host stand will not load; wrong tables double-booked | Within 15 minutes during service hours; phone the owner back |
| P2 | Emails not arriving; POS sync failing; import trouble | Same business day |
| P3 | How-to questions; feature requests | Within 2 business days; answer with a link to a doc, and if the doc is missing, write it |

- [ ] Every ticket gets a one-line cause in the log
- [ ] Any question asked twice becomes a doc or a fix. That is how support stays small enough for the endowment to survive

---

## 10. Incident: site down

- [ ] `systemctl status freeheld`; `journalctl -u freeheld -n 200`
- [ ] Disk full? Free space (old backups, logs). Writes fail while deletes still succeed
- [ ] Restart: `systemctl restart freeheld`; check `/healthz`
- [ ] Still down: restore to a new machine (section 5) and point DNS at it
- [ ] Afterwards: a short note to affected owners with what happened, what was lost (usually nothing: bookings are in the database, messages retry), and the fix

---

## 11. License activation paid offline (check, invoice)

- [ ] Payment received and recorded in the books
- [ ] `/admin` → restaurant → "Mark lifetime (paid offline)" → enter the reference (check number or invoice)
- [ ] Email the owner a receipt and the lifetime terms

---

## 12. A restaurant leaves

Leaving must be as easy as arriving. It is part of the promise.

- [ ] Owner exports everything: Settings → Import & export → Everything (JSON), plus the two CSVs
- [ ] Owner removes the widget, the Google link and the Instagram link
- [ ] If they ask for deletion: delete the restaurant row (cascades to its tables, bookings, guests and messages), confirm in writing, and note that backups age out within `BACKUP_KEEP` days
