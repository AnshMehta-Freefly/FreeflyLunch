# Deploying Freefly Lunch (always-on, free)

Goal: the app runs whenever your machine is on - no manual `node server.js` - and
is reachable from phones/home over HTTPS, with order data snapshotted locally so a
bad restart or accidental deletion can't lose it. When your machine is **off**, the bill-splitter still
works as a static page (GitHub Pages); only *new orders* pause until you're back.

Three one-time setups: **(A) the service**, **(B) the public URL**, **(C) backups**.

---

## A. Run the server as a systemd service

```bash
# Adjust paths/user inside the unit if your checkout isn't /home/ansh/Freefly/FreeflyLunch.
sudo cp deploy/freefly-lunch.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now freefly-lunch
systemctl status freefly-lunch        # should be "active (running)"
```

Don't enable it for real until you've filled in `PUBLIC_BASE_URL` in step B -
otherwise order links use the LAN IP and won't work off the network.

Logs: `journalctl -u freefly-lunch -f`

---

## B. Public HTTPS URL with Tailscale Funnel (free, stable, no domain)

Funnel gives a fixed `https://<machine>.<tailnet>.ts.net` URL that follows your
laptop between office and home. No port-forwarding, no static IP, free HTTPS.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                     # log in (Google/GitHub/email - free account)
tailscale status                      # note your machine name + tailnet, e.g. mylaptop.tail1234.ts.net

# Expose the app's port publicly over HTTPS:
sudo tailscale funnel --bg 8126
tailscale funnel status               # prints the public https URL
```

Take that `https://<machine>.<tailnet>.ts.net` URL and:

1. Put it in `deploy/freefly-lunch.service` as `PUBLIC_BASE_URL` (no trailing slash).
2. `sudo cp deploy/freefly-lunch.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart freefly-lunch`
3. Open that URL - the startup banner / `journalctl` should show `Public: https://...`,
   and "Start group order" → "Copy Walu message" now produces an HTTPS link that
   works on any phone. (Bonus: on HTTPS the clipboard copy works natively.)

> Why not Cloudflare Tunnel? A named/stable Cloudflare tunnel needs a domain you
> control as a Cloudflare zone. Your `freeflylunch.work.gd` is a shared FreeDNS
> domain, so it can't be a Cloudflare zone. Tailscale Funnel needs no domain.

---

## C. Back up `data/` to local snapshots

`backup.sh` tarballs `data/` into a backup folder, but only when something changed
since the last snapshot, and keeps the newest 48. No accounts, no remote, no auth.

Default folder is `~/freefly-lunch-backups` (outside the repo, so it survives a
re-clone). Session files contain secret tokens, so keep that folder private.

> Heads up: local snapshots protect against accidental deletion, corruption, or a
> bad restart - but they're on the same disk, so they don't survive the machine
> dying. For off-machine safety, set `BACKUP_DIR` to a mounted drive or a synced
> cloud folder (e.g. `Environment=BACKUP_DIR=%h/Dropbox/freefly-lunch-backups` in
> `freefly-lunch-backup.service`). Override `KEEP=N` to change how many to retain.

1. Verify a manual run works:

   ```bash
   deploy/backup.sh && ls -1 ~/freefly-lunch-backups
   ```
2. Install the timer (backs up every 5 min, plus on shutdown via the app unit's
   `ExecStopPost`):

   ```bash
   sudo cp deploy/freefly-lunch-backup.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now freefly-lunch-backup.timer
   systemctl list-timers freefly-lunch-backup.timer
   ```

### Restore from a snapshot

Pick a snapshot and unpack it over the repo (it restores the `data/` folder):

```bash
cd /home/ansh/Freefly/FreeflyLunch
sudo systemctl stop freefly-lunch
rm -rf data
tar -xzf ~/freefly-lunch-backups/sessions-YYYYMMDD-HHMMSS.tar.gz -C .
sudo systemctl start freefly-lunch
```

---

## D. Optional: Read receipt with AI

Lets you snap the receipt and have prices filled in automatically (Claude vision).
It's off unless an API key is set, so the button only appears once enabled.

1. Create a key at <https://console.anthropic.com> (pay-as-you-go; ~$0.03-0.05 per receipt).
   Set a monthly spend limit and use a key dedicated to this app so it's easy to revoke.
2. Put it in a root-only secrets file (kept out of the public repo):
   ```bash
   sudo install -m 600 /dev/null /etc/freefly-lunch.env
   sudo nano /etc/freefly-lunch.env      # add one line: ANTHROPIC_API_KEY=sk-ant-your-key
   ```
   The unit already references it (`EnvironmentFile=-/etc/freefly-lunch.env`).
   See `.env.example` for the keys the app understands.
3. Reinstall and restart:
   ```bash
   sudo cp deploy/freefly-lunch.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl restart freefly-lunch
   curl -s http://localhost:8126/api/health   # expect "receiptAI":true
   ```
4. Open the splitter, import a group order (or add items), then click
   **Read receipt with AI** and pick the photo. Prices, tax, and tip fill in -
   eyeball them, then Compute Split.

Note: this sends the receipt photo to Anthropic's API (data leaves your machine).
Only works on the LAN server, not the static GitHub Pages site.

---

## What happens when your machine is off

- **Bill-splitter:** still fully usable at your GitHub Pages site - it's pure
  client-side, and the Group Order card auto-hides when the backend is unreachable
  (`index.html` `goInit()` → `/api/health` fails → card stays hidden).
- **New orders:** paused until your machine is back (collecting orders needs the
  server running). Existing order data is safe in the private backup repo.
