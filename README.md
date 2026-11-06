# Pingerr

Pings your URLs every **14 minutes** (fixed) and emails **raw.adarshn@gmail.com** the instant one fails, and again when it recovers. It does nothing else: no Discord, no bot.

A ping counts as failed if the request errors, times out (60 s) or returns a non-OK HTTP status (4xx/5xx).
You get one DOWN email per outage (not one every 14 minutes), then one RECOVERED email.

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and set `URLS` (e.g. your own site + one more).
3. Email, using your own Gmail (no third-party mail service):
   - Google Account → turn on **2-Step Verification**
   - myaccount.google.com/apppasswords → create an app password
   - put your address in `GMAIL_USER` and the 16-character password in `GMAIL_APP_PASSWORD`
4. `npm run testmail` → check your inbox (and spam) once.
5. `npm start`

## Why Gmail SMTP and not "no mailer at all"?
Sending email with no account at all means connecting straight to Gmail's servers. Most hosts block that port, and Gmail would treat it as spam. Your own Gmail with an app password is the reliable no-extra-service way. Never commit your `.env`.

## Hosting
Pingerr must stay running 24/7: a VPS, Raspberry Pi, a PC that is always on, or any always-on host. On a free tier that sleeps, Pingerr itself will sleep and stop pinging, and a sleeping program can't wake itself. Visiting its web page (`/`) shows the current status of every URL.
