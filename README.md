# 🎫 ticket-webdev

A dead-simple ticketing form for web-dev clients:

1. Client fills in a form (no login) — name, company, URL, problem title, description, optional screenshot/video.
2. **Google Gemini** rewrites the non-technical description into a developer-ready ticket (title, summary, technical description, priority).
3. The ticket is posted to your dev team's **Slack channel**.
4. You (the owner) see every submission and its Slack delivery status (sent / failed, with a Retry button) at `/admin`.

If the AI call ever fails, the ticket is still sent to Slack with the client's original words — nothing gets lost.

## Setup

Requirements: Node.js 18+

```bash
npm install
cp .env.example .env   # then edit .env
npm start
```

Fill in `.env`:

| Variable | What it is |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key — free at https://aistudio.google.com/apikey |
| `GEMINI_MODEL` | Optional, default `gemini-2.5-flash` |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook for your dev channel — create at https://api.slack.com/messaging/webhooks |
| `ADMIN_PASSWORD` | Password for the `/admin` page (any username works) |
| `APP_URL` | Public URL of this app, e.g. `https://tickets.yourdomain.com` — used so attachment links in Slack are clickable. Leave empty on localhost. |
| `PORT` | Default `3000` |

**Clients** shown in the form dropdown are managed from the admin panel — add or remove them in the "Clients" section at the top of `/admin`. (They're stored in the database; the old `clients.json` file is no longer used.)

## URLs

| URL | Who | What |
|---|---|---|
| `/` | Clients | The problem-report form |
| `/admin` | You | Manage clients, view the ticket log, set each ticket's workflow status (New / In progress / Stuck / Solved), filter by status/priority/client/date, see AI + Slack status, and retry failures (HTTP Basic Auth, password from `ADMIN_PASSWORD`) |

## Data

- Tickets are stored in a local SQLite file `tickets.db` (created automatically).
- Uploaded screenshots/videos go to `uploads/` and are served at `/uploads/<file>`.

## Deploying on Vercel

The app is Vercel-ready (`api/index.js` + `vercel.json`). On Vercel it automatically switches from local SQLite/disk to **Postgres** and **Vercel Blob**:

1. Go to [vercel.com/new](https://vercel.com/new) and **import the `avidev73/ticket-webdev` GitHub repo**. Framework preset: *Other*. Deploy.
2. In the project's **Storage** tab:
   - Create a **Neon (Postgres)** database → this auto-adds `DATABASE_URL` to the project.
   - Create a **Blob** store → this auto-adds `BLOB_READ_WRITE_TOKEN` (screenshots get public URLs, clickable straight from Slack — no `APP_URL` needed).
3. In **Settings → Environment Variables**, add:
   - `GEMINI_API_KEY`
   - `SLACK_WEBHOOK_URL`
   - `ADMIN_PASSWORD`
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the new env vars take effect.

Every `git push` to `main` then auto-deploys.

CLI alternative: `npx vercel login && npx vercel --prod`, then the same Storage/env-var steps.

### How the environment switch works

| | Local (`npm start`) | Vercel |
|---|---|---|
| Ticket log | SQLite file `tickets.db` | Postgres (`DATABASE_URL` present) |
| Attachments | `uploads/` folder | Vercel Blob (`BLOB_READ_WRITE_TOKEN` present) |
| Attachment links in Slack | need `APP_URL` set | automatic (Blob URLs are public) |

Note: on Vercel the form submit takes a few extra seconds — the AI summary and Slack post run before the "Thanks" page is shown, because serverless functions can't keep working in the background after responding.

## Notes

- The AI model defaults to `gemini-2.5-flash` (fast + cheap). Set `GEMINI_MODEL=gemini-2.5-pro` in `.env` for higher quality on tricky tickets.
- On local runs, Slack webhooks can't fetch files from your machine, so attachment links need `APP_URL`. On Vercel this is handled by Blob automatically.
