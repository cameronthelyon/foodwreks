# Setting up the production server

A READ-DO checklist. About an hour, most of it waiting for DNS. You need: the DigitalOcean account, access to the freeheld.io DNS settings at your registrar, and a password manager.

| File | What it is |
|---|---|
| `setup.sh` | Paste into "User data" when creating the droplet. Installs and starts everything. Safe to re-run. |
| `update.sh` | Release a new version: pull, test, restart, roll back on failure. |
| `admin.sh` | Make someone a platform admin and print their set-password link. |
| `litestream.yml` | Continuous off-site backup of the database. |

## 0. Before you start

- [ ] **The code is on `main`.** The script deploys `main`. Merge the work branch first (or change `BRANCH` at the top of `setup.sh`).
- [ ] **An SSH key on your computer.** Mac or Linux: `ssh-keygen -t ed25519` (press Enter through it), then `cat ~/.ssh/id_ed25519.pub` and copy the line. This is how you log in; there is no root password.
- [ ] **Private repository?** The server cannot clone it on its own. Either make the repository public now (the AGPL source link needs it public by launch anyway), or follow "Private repository" at the bottom after step 5.

## 1. Create the droplet

DigitalOcean → Create → Droplets:

- [ ] **Region:** San Francisco (SFO3), closest to California restaurants
- [ ] **Image:** Ubuntu 24.04 (LTS) x64
- [ ] **Size:** Basic, Regular SSD, **2 GB / 1 CPU** (about $12 a month). Resize later in a few clicks
- [ ] **Authentication:** SSH key → New SSH key → paste the line from step 0
- [ ] **Advanced options:** tick "Add initialization scripts (free)". Open `deploy/setup.sh`, check the four settings at the top (`DOMAIN`, `SUPPORT_EMAIL`, `REPO_URL`, `BRANCH`), and paste the **whole file** into the box
- [ ] **Monitoring:** on (free). **IPv6:** on
- [ ] **Hostname:** `freeheld-1`
- [ ] Droplet backups: optional (about 20% more). The database is backed up separately in step 8; droplet backups only save rebuild time
- [ ] Create

## 2. Give it a permanent address

- [ ] Networking → Reserved IPs → assign one to `freeheld-1` (free while attached). Use this address from now on; it survives rebuilding the droplet

## 3. Point freeheld.io at it

At your registrar's DNS settings:

- [ ] `A` record, host `@`, value: the reserved IP
- [ ] `A` record, host `www`, value: the reserved IP
- [ ] TTL: the lowest offered (for example 5 minutes) while setting up
- [ ] Check from your computer: `dig +short freeheld.io` prints the reserved IP (can take minutes to an hour)

HTTPS starts working by itself once DNS points at the server: Caddy requests the certificate automatically.

## 4. Watch the setup finish

- [ ] `ssh root@<reserved IP>`
- [ ] `cloud-init status --wait` (returns when the script is done, a few minutes)
- [ ] `tail -n 20 /var/log/freeheld-setup.log` ends with "Freeheld is running"
- [ ] If it says it could not clone: see "Private repository" below

## 5. Save the secret

- [ ] `grep APP_SECRET /etc/freeheld/freeheld.env` and store the value in your password manager as "Freeheld APP_SECRET". **Losing it makes every saved POS and Stripe key unreadable and breaks every guest's manage link.** Restoring a backup needs it

## 6. Create your admin account

- [ ] Wait until `https://freeheld.io` loads with a padlock
- [ ] `sudo /opt/freeheld/deploy/admin.sh info@freeheld.io "Cameron Lyon"` (use your own email if you prefer)
- [ ] Open the printed link within 24 hours and choose a password
- [ ] `https://freeheld.io/admin` shows the admin page
- [ ] Sign-ups start **closed** (`SIGNUPS_OPEN=0`) for pilots: create each pilot restaurant from the admin page with **New restaurant**, which emails the owner an invite (and gives you the link to send by hand). Open sign-ups later by setting `SIGNUPS_OPEN=1` (step 7 shows how to change a setting)

## 7. Email

Until this step, emails are printed to the server log instead of sent.

- [ ] Create a Postmark account; add and verify the domain `freeheld.io`
- [ ] Add the DNS records Postmark shows (DKIM `TXT`, Return-Path `CNAME`)
- [ ] Add DMARC: `TXT` record, host `_dmarc`, value `v=DMARC1; p=none; rua=mailto:info@freeheld.io`
- [ ] On the server: `nano /etc/freeheld/freeheld.env`, set `EMAIL_PROVIDER=postmark` and add `POSTMARK_TOKEN=<server token>`, save
- [ ] `systemctl restart freeheld`
- [ ] Book a test table on a pilot's booking page using a Gmail address and an Outlook address. Both land in the inbox, the sender reads "<Restaurant> via Freeheld", and pressing reply addresses the restaurant

Changing any setting works the same way: edit `/etc/freeheld/freeheld.env`, then `systemctl restart freeheld`.

## 8. Off-site backups

The server snapshots the database daily onto its own disk. That protects against mistakes, not against losing the server. Litestream copies every change off the server within seconds.

- [ ] DigitalOcean → Spaces Object Storage → create a bucket in SFO3, named for example `freeheld-backups`, **private** (about $5 a month)
- [ ] Spaces → Access keys → create a key limited to that bucket
- [ ] `nano /etc/freeheld/litestream.env` and fill in:
  `LITESTREAM_BUCKET=freeheld-backups`, `LITESTREAM_ENDPOINT=https://sfo3.digitaloceanspaces.com`, `LITESTREAM_REGION=sfo3`, and the two key values
- [ ] `systemctl enable --now litestream`
- [ ] After a minute: `journalctl -u litestream -n 20` shows no errors, and the bucket contains a `freeheld.db` folder

**Restore drill** (now, then monthly, as in `docs/OPERATIONS.md`):

```bash
set -a; . /etc/freeheld/litestream.env; set +a
litestream restore -config /etc/litestream.yml -o /tmp/restored.db /var/lib/freeheld/freeheld.db
sqlite3 /tmp/restored.db "SELECT count(*) FROM reservations"
rm /tmp/restored.db
```

## 9. Releasing updates

- [ ] `sudo /opt/freeheld/deploy/update.sh`
  It pulls the branch, runs the test suite, restarts, and checks the server answers. If tests fail or the server does not come back, it rolls back and says so

## Private repository

If you keep the repository private for now:

```bash
ssh-keygen -t ed25519 -f /root/.ssh/github_deploy -N ""
cat /root/.ssh/github_deploy.pub
```

- [ ] GitHub → the repository → Settings → Deploy keys → Add deploy key: paste it, leave "Allow write access" **off**
- [ ] On the server:

```bash
printf 'Host github.com\n  IdentityFile /root/.ssh/github_deploy\n  StrictHostKeyChecking accept-new\n' >> /root/.ssh/config
cp /var/lib/cloud/instance/user-data.txt /root/setup.sh
sed -i 's#^REPO_URL=.*#REPO_URL="git@github.com:cameronthelyon/foodwreks.git"#' /root/setup.sh
bash /root/setup.sh
```

- [ ] When the repository goes public, set `SOURCE_URL` in `/etc/freeheld/freeheld.env` to its public address (the AGPL link on every page uses it)

## If something is wrong

| Symptom | Check |
|---|---|
| Site does not load | `systemctl status freeheld caddy`, then `journalctl -u freeheld -n 50` |
| No padlock / certificate error | DNS not pointing here yet: `dig +short freeheld.io`. Then `journalctl -u caddy -n 50` |
| Emails not arriving | Admin page "Recent delivery failures"; Postmark's activity log |
| Out of disk | `df -h`; old snapshots live in `/var/lib/freeheld/backups` |
