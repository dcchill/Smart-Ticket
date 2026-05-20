# SmartTicket

A local smart IT ticket system with separate admin and client portals.

## Run

```powershell
node server.js
```

Open:

- Admin: `http://localhost:3000/admin`
- Client: `http://localhost:3000/client`

## Persistence

Data is stored in `data/store.json`, and tickets are mirrored to `data/tickets.csv`.

## Email

Admin recipients and ticket defaults are configured in the Admin Email and Settings screen. Without SMTP settings, messages are written to `data/email-outbox.jsonl`.

To send real email, start the server with SMTP environment variables:

```powershell
$env:SMTP_HOST="smtp.example.com"
$env:SMTP_PORT="465"
$env:SMTP_USER="user@example.com"
$env:SMTP_PASS="app-password"
$env:SMTP_FROM="helpdesk@example.com"
node server.js
```

## Wix client frontend

To host the client frontend in Wix, paste the contents of `wix-client-embed.html` into a Wix Embed HTML element and change:

```js
const API_BASE = "https://tickets.yourdomain.com";
```

to your public SmartTicket server URL.

Add your Wix origins in Admin > Email and Settings > Allowed client origins, for example:

```text
https://www.yourdomain.com
https://youraccount.wixsite.com
```
