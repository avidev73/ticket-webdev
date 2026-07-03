# 🎫 ticket-webdev

A dead-simple ticketing form for web-dev clients:

1. Client fills in a form (no login) — name, company, URL, problem title, description, optional screenshot/video.
2. **Claude AI** rewrites the non-technical description into a developer-ready ticket (title, summary, technical description, priority).
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
| `ANTHROPIC_API_KEY` | API key from https://platform.claude.com/ |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook for your dev channel — create at https://api.slack.com/messaging/webhooks |
| `ADMIN_PASSWORD` | Password for the `/admin` page (any username works) |
| `APP_URL` | Public URL of this app, e.g. `https://tickets.yourdomain.com` — used so attachment links in Slack are clickable. Leave empty on localhost. |
| `PORT` | Default `3000` |

Edit **`clients.json`** to set the companies shown in the client dropdown.

## URLs

| URL | Who | What |
|---|---|---|
| `/` | Clients | The problem-report form |
| `/admin` | You | Ticket log + Slack status + retry (HTTP Basic Auth, password from `.env`) |

## Data

- Tickets are stored in a local SQLite file `tickets.db` (created automatically).
- Uploaded screenshots/videos go to `uploads/` and are served at `/uploads/<file>`.

## Notes

- The AI model used is `claude-opus-4-8`; change it in `ai.js` if you want.
- Slack webhooks can't upload files, so attachments are shared as links to this app — that's why `APP_URL` matters once deployed.
