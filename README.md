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

Admin recipients, requester notifications, and SMTP delivery are configured in the Admin Email and Settings screen. Without SMTP settings, messages are written to `data/email-outbox.jsonl`.

For most setups, open Admin > Email and Settings > Email Delivery and enter your SMTP host, port, username, app password, and from address.

For Gmail or Google Workspace:

1. Open `https://myaccount.google.com/security`.
2. Turn on 2-Step Verification.
3. Open `https://myaccount.google.com/apppasswords`.
4. Create an app password for SmartTicket.
5. In SmartTicket, use:
   - SMTP host: `smtp.gmail.com`
   - SMTP port: `465`
   - SMTP username: your full Gmail or Google Workspace email
   - SMTP password: the generated app password, not your normal Google password
   - From email: the same email address
   - Use secure SMTP/TLS: checked
6. Save settings, then click Send test email.

If Google shows `Application-specific password required`, the SMTP password is still your normal password or app passwords are not enabled for the account. For school/work Google Workspace accounts, an administrator may need to allow app passwords.

You can also override saved SMTP settings with environment variables:

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
