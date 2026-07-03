const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db');
const { summarizeTicket } = require('./ai');
const { sendTicketToSlack } = require('./slack');

const app = express();
const PORT = process.env.PORT || 3000;

// Attachments: Vercel Blob when a token is present (deployed), local disk otherwise.
// On Vercel without Blob, keep files in memory so we can show a clear error.
const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;
const USE_DISK = !USE_BLOB && !process.env.VERCEL;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (USE_DISK) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function uniqueFilename(originalname) {
  const safeExt = path.extname(originalname).toLowerCase().slice(0, 10);
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${safeExt}`;
}

const upload = multer({
  storage: USE_DISK
    ? multer.diskStorage({
        destination: UPLOAD_DIR,
        filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
      })
    : multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const ok = /^(image|video)\//.test(file.mimetype);
    cb(ok ? null : new Error('Only image or video files are allowed'), ok);
  },
});

async function storeAttachment(file) {
  if (!file) return null;
  if (USE_BLOB) {
    const { put } = require('@vercel/blob');
    const blob = await put(`tickets/${uniqueFilename(file.originalname)}`, file.buffer, {
      access: 'public',
      contentType: file.mimetype,
    });
    return blob.url; // public https URL — clickable from Slack directly
  }
  if (!USE_DISK) {
    throw new Error(
      'Attachment uploads need Blob storage. In your Vercel project: Storage tab → Create → Blob, then Redeploy. (Or submit without an attachment.)'
    );
  }
  return `/uploads/${file.filename}`;
}

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
if (!USE_BLOB) app.use('/uploads', express.static(UPLOAD_DIR));

// ---- Client dropdown (edit clients.json to change the list) ----
app.get('/api/clients', (req, res) => {
  const clients = JSON.parse(fs.readFileSync(path.join(__dirname, 'clients.json'), 'utf8'));
  res.json(clients);
});

// ---- Ticket submission ----
app.post('/submit', upload.single('attachment'), async (req, res, next) => {
  try {
    const { name, client, site_url, title, details } = req.body;
    if (!name || !client || !title || !details) {
      return res.status(400).send('Missing required fields');
    }

    const id = await db.insertTicket({
      name: name.trim(),
      client: client.trim(),
      site_url: (site_url || '').trim() || null,
      title: title.trim(),
      details: details.trim(),
      attachment_url: await storeAttachment(req.file),
    });

    // Run AI + Slack before responding: on serverless (Vercel) the function
    // is frozen after the response is sent, so background work would be lost.
    await processTicket(id);

    res.redirect('/thanks.html');
  } catch (err) {
    next(err);
  }
});

async function processTicket(id) {
  let ticket = await db.getTicket(id);

  // 1. AI summary — if it fails, still send the raw ticket to Slack
  try {
    const ai = await summarizeTicket(ticket);
    await db.saveAiResult(id, {
      ai_ok: true,
      ai_title: ai.title,
      ai_summary: ai.summary,
      ai_technical: ai.technical_description,
      ai_priority: ai.priority,
    });
  } catch (err) {
    console.error(`Ticket #${id} AI summarization failed:`, err.message);
    await db.saveAiResult(id, { ai_ok: false, ai_title: null, ai_summary: null, ai_technical: null, ai_priority: null });
  }

  // 2. Send to Slack
  ticket = await db.getTicket(id);
  try {
    await sendTicketToSlack(ticket);
    await db.saveSlackStatus(id, 'sent');
  } catch (err) {
    console.error(`Ticket #${id} Slack send failed:`, err.message);
    await db.saveSlackStatus(id, 'failed', err.message);
  }
}

// ---- Owner admin (HTTP Basic Auth) ----
function requireAdmin(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return res.status(500).send('ADMIN_PASSWORD is not set');

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (pass === password) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Ticket Admin"');
  res.status(401).send('Authentication required');
}

app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    res.send(renderAdminPage(await db.listTickets()));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/retry/:id', requireAdmin, async (req, res, next) => {
  try {
    const ticket = await db.getTicket(Number(req.params.id));
    if (!ticket) return res.status(404).send('Ticket not found');

    if (!ticket.ai_ok) {
      // AI failed last time — try once more before resending
      try {
        const ai = await summarizeTicket(ticket);
        await db.saveAiResult(ticket.id, {
          ai_ok: true,
          ai_title: ai.title,
          ai_summary: ai.summary,
          ai_technical: ai.technical_description,
          ai_priority: ai.priority,
        });
      } catch (err) {
        console.error(`Ticket #${ticket.id} AI retry failed:`, err.message);
      }
    }
    try {
      await sendTicketToSlack(await db.getTicket(ticket.id));
      await db.saveSlackStatus(ticket.id, 'sent');
    } catch (err) {
      await db.saveSlackStatus(ticket.id, 'failed', err.message);
    }
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(d) {
  return new Date(d).toISOString().replace('T', ' ').slice(0, 16);
}

function renderAdminPage(tickets) {
  const rows = tickets.map((t) => {
    const status = t.slack_status === 'sent'
      ? '<span class="badge sent">sent</span>'
      : t.slack_status === 'failed'
        ? `<span class="badge failed" title="${esc(t.slack_error)}">failed</span>`
        : '<span class="badge pending">pending</span>';
    const retry = t.slack_status === 'failed'
      ? `<form method="post" action="/admin/retry/${t.id}"><button>Retry</button></form>`
      : '';
    const attachment = t.attachment_url
      ? `<a href="${esc(t.attachment_url)}" target="_blank">file</a>`
      : '—';
    return `<tr>
      <td>#${t.id}</td>
      <td>${esc(fmtDate(t.created_at))}</td>
      <td>${esc(t.client)}</td>
      <td>${esc(t.name)}</td>
      <td>
        <strong>${esc(t.ai_title || t.title)}</strong>
        <div class="detail">${esc(t.ai_technical || t.details)}</div>
      </td>
      <td>${esc(t.ai_priority || '—')}</td>
      <td>${attachment}</td>
      <td>${t.ai_ok ? '✅' : '⚠️ raw'}</td>
      <td>${status}${t.slack_error ? `<div class="err">${esc(t.slack_error)}</div>` : ''}${retry}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Ticket Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #1a202c; }
  h1 { font-size: 1.4rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { border-bottom: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f7fafc; position: sticky; top: 0; }
  .detail { color: #4a5568; max-width: 420px; white-space: pre-wrap; margin-top: 4px; }
  .badge { padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 0.75rem; }
  .sent { background: #c6f6d5; color: #22543d; }
  .failed { background: #fed7d7; color: #742a2a; }
  .pending { background: #fefcbf; color: #744210; }
  .err { color: #c53030; font-size: 0.75rem; max-width: 200px; margin-top: 4px; }
  button { cursor: pointer; margin-top: 4px; }
</style></head>
<body>
<h1>🎫 Ticket Log (${tickets.length})</h1>
<table>
<tr><th>ID</th><th>Created (UTC)</th><th>Client</th><th>Name</th><th>Ticket</th><th>Priority</th><th>File</th><th>AI</th><th>Slack</th></tr>
${rows || '<tr><td colspan="9">No tickets yet</td></tr>'}
</table>
</body></html>`;
}

// Friendly error for oversized/invalid uploads and anything unexpected
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(400).send(`Error: ${esc(err.message)}. <a href="/">Go back</a>`);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Ticket form:  http://localhost:${PORT}`);
    console.log(`Admin log:    http://localhost:${PORT}/admin`);
  });
}

module.exports = app;
