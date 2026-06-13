# Freefly Lunch

Group lunch ordering + penny-perfect bill splitting for the #freefly-lunch crew.

Walu has no API, so the integration is link-based: you post a link in the
channel, everyone puts their order in through that link, and the app gives you
ready-to-paste Walu messages at every step (order link → order summary →
who-owes-what).

## The lunch flow

1. **Start the server** (organizer's machine, see below) and open the app.
2. Click **Start group order** → **Copy Walu message** → paste it in
   **#freefly-lunch**.
3. Everyone opens the link (works on phones, no accounts) and adds what they
   want. You watch orders arrive live. Prices are optional for them — you fill
   real prices from the receipt later.
4. Click **Close ordering** when time's up. **Copy order summary** gives you a
   per-dish list for calling in / placing the order.
5. After paying, click **Import into splitter**, fill in the highlighted
   prices plus tax/tip from the receipt, and **Compute Split**.
6. **Copy for Walu** posts the damage back to the channel.

## Running the server

Zero dependencies — only Node 18+:

```bash
node server.js          # default port 8126
node server.js 9000     # custom port
```

It prints a `Network:` URL (your LAN IP). That's the link base your colleagues
use — anyone on the office network can reach it. Order data is stored as JSON
files under `data/` (gitignored).

To keep it running permanently on a Linux box:

```bash
sudo tee /etc/systemd/system/freefly-lunch.service > /dev/null <<EOF
[Unit]
Description=Freefly Lunch
After=network.target

[Service]
ExecStart=$(command -v node) $(pwd)/server.js
WorkingDirectory=$(pwd)
Restart=always
User=$USER

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now freefly-lunch
```

## Without the server (GitHub Pages)

`index.html` still works as a pure static page — the splitter is fully
client-side. The Group Order card simply hides itself when no backend is
reachable, so the GitHub Pages deployment keeps working as before.

## Files

| File | What it is |
|---|---|
| `index.html` | Organizer app: group-order dashboard + bill splitter |
| `order.html` | What colleagues see when they open the link from Walu |
| `server.js` | Zero-dependency Node server: static files + JSON API + storage |

## API (for the curious)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | liveness + LAN base URL |
| POST | `/api/sessions` | — | create session → `organizerToken` |
| GET | `/api/sessions/:id` | — | session + orders (tokens stripped) |
| POST | `/api/sessions/:id/orders` | — | place an order → edit `token` |
| PUT/DELETE | `/api/sessions/:id/orders/:oid` | `X-Auth-Token` | edit/remove own order (organizer can too) |
| PUT | `/api/sessions/:id/status` | `X-Auth-Token` (organizer) | open/close ordering |
| GET | `/o/:id` | — | short link → redirects to the order page |
