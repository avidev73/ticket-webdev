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
if (USE_DISK) app.use('/uploads', express.static(UPLOAD_DIR));

// ---- Client dropdown for the public form ----
app.get('/api/clients', async (req, res, next) => {
  try {
    res.json(await db.listClients());
  } catch (err) {
    next(err);
  }
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

    // Run AI + Slack before responding: on serverless the function is frozen
    // after the response is sent, so background work would be lost.
    await processTicket(id);

    res.redirect('/thanks.html');
  } catch (err) {
    next(err);
  }
});

async function processTicket(id) {
  let ticket = await db.getTicket(id);

  // 1. AI summary — if it fails, record why and still send the raw ticket to Slack
  try {
    const ai = await summarizeTicket(ticket);
    await db.saveAiResult(id, {
      ai_ok: true,
      ai_title: ai.title,
      ai_summary: ai.summary,
      ai_technical: ai.technical_description,
      ai_priority: ai.priority,
      ai_error: null,
    });
  } catch (err) {
    console.error(`Ticket #${id} AI summarization failed:`, err.message);
    await db.saveAiResult(id, {
      ai_ok: false, ai_title: null, ai_summary: null, ai_technical: null, ai_priority: null,
      ai_error: err.message,
    });
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
    const filters = {
      work_status: req.query.work_status || '',
      priority: req.query.priority || '',
      client: req.query.client || '',
      date_from: req.query.date_from || '',
      date_to: req.query.date_to || '',
    };
    const [tickets, clients] = await Promise.all([db.listTickets(filters), db.listClients()]);
    res.send(renderAdminPage(tickets, clients, filters));
  } catch (err) {
    next(err);
  }
});

// Change a ticket's workflow status
app.post('/admin/status/:id', requireAdmin, async (req, res, next) => {
  try {
    const status = req.body.work_status;
    if (db.WORK_STATUSES.includes(status)) await db.setWorkStatus(Number(req.params.id), status);
    res.redirect(req.get('referer') || '/admin');
  } catch (err) {
    next(err);
  }
});

// Add / remove clients from the form dropdown
app.post('/admin/clients', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (name) await db.addClient(name);
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/clients/delete', requireAdmin, async (req, res, next) => {
  try {
    if (req.body.name) await db.removeClient(req.body.name);
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/retry/:id', requireAdmin, async (req, res, next) => {
  try {
    const ticket = await db.getTicket(Number(req.params.id));
    if (!ticket) return res.status(404).send('Ticket not found');

    if (!ticket.ai_ok) {
      try {
        const ai = await summarizeTicket(ticket);
        await db.saveAiResult(ticket.id, {
          ai_ok: true, ai_title: ai.title, ai_summary: ai.summary,
          ai_technical: ai.technical_description, ai_priority: ai.priority, ai_error: null,
        });
      } catch (err) {
        console.error(`Ticket #${ticket.id} AI retry failed:`, err.message);
        await db.saveAiResult(ticket.id, {
          ai_ok: false, ai_title: null, ai_summary: null, ai_technical: null, ai_priority: null,
          ai_error: err.message,
        });
      }
    }
    try {
      await sendTicketToSlack(await db.getTicket(ticket.id));
      await db.saveSlackStatus(ticket.id, 'sent');
    } catch (err) {
      await db.saveSlackStatus(ticket.id, 'failed', err.message);
    }
    res.redirect(req.get('referer') || '/admin');
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

const WORK_LABELS = { new: 'New', in_progress: 'In progress', stuck: 'Stuck', solved: 'Solved' };

function renderAdminPage(tickets, clients, filters) {
  const opt = (val, label, selected) =>
    `<option value="${esc(val)}"${val === selected ? ' selected' : ''}>${esc(label)}</option>`;

  const clientFilterOpts = clients.map((c) => opt(c, c, filters.client)).join('');
  const statusFilterOpts = db.WORK_STATUSES.map((s) => opt(s, WORK_LABELS[s], filters.work_status)).join('');
  const priorityFilterOpts = db.PRIORITIES.map((p) => opt(p, p, filters.priority)).join('');

  const clientChips = clients.length
    ? clients.map((c) => `
        <span class="chip">${esc(c)}
          <form method="post" action="/admin/clients/delete" onsubmit="return confirm('Remove ${esc(c)} from the dropdown?')">
            <input type="hidden" name="name" value="${esc(c)}"><button title="Remove">×</button>
          </form>
        </span>`).join('')
    : '<span class="muted">No clients yet — add one so it appears in the form dropdown.</span>';

  const rows = tickets.map((t) => {
    const slack = t.slack_status === 'sent'
      ? '<span class="badge sent">sent</span>'
      : t.slack_status === 'failed'
        ? `<span class="badge failed" title="${esc(t.slack_error)}">failed</span>`
        : '<span class="badge pending">pending</span>';
    const retry = t.slack_status === 'failed' || !t.ai_ok
      ? `<form method="post" action="/admin/retry/${t.id}"><button>Retry</button></form>`
      : '';
    const attachment = t.attachment_url
      ? `<a href="${esc(t.attachment_url)}" target="_blank">file</a>`
      : '—';
    const ai = t.ai_ok
      ? '✅'
      : `<span class="warn" title="${esc(t.ai_error || 'AI summary unavailable')}">⚠️ raw</span>`;
    const statusSelect = `
      <form method="post" action="/admin/status/${t.id}" class="status-form">
        <select name="work_status" onchange="this.form.submit()" class="ws ws-${esc(t.work_status)}">
          ${db.WORK_STATUSES.map((s) => opt(s, WORK_LABELS[s], t.work_status)).join('')}
        </select>
      </form>`;
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
      <td>${statusSelect}</td>
      <td>${attachment}</td>
      <td>${ai}${!t.ai_ok && t.ai_error ? `<div class="err">${esc(t.ai_error)}</div>` : ''}</td>
      <td>${slack}${t.slack_error ? `<div class="err">${esc(t.slack_error)}</div>` : ''}${retry}</td>
    </tr>`;
  }).join('\n');

  const anyFilter = filters.work_status || filters.priority || filters.client || filters.date_from || filters.date_to;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Ticket Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 1.5rem; color: #1a202c; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; color: #4a5568; }
  .panel { background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; margin-bottom: 1rem; }
  form.inline { display: inline; }
  input, select, button { font-size: 0.85rem; font-family: inherit; }
  input[type=text], input[type=date], select { padding: 5px 7px; border: 1px solid #cbd5e0; border-radius: 6px; }
  .filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
  .filters label { display: flex; flex-direction: column; font-size: 0.72rem; color: #718096; gap: 3px; font-weight: 600; }
  .filters button, .clientadd button { background: #3182ce; color: #fff; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-weight: 600; }
  .filters a.clear { align-self: end; padding: 6px 8px; color: #718096; text-decoration: none; }
  .chip { display: inline-flex; align-items: center; gap: 4px; background: #edf2f7; border-radius: 14px; padding: 3px 6px 3px 10px; margin: 3px; font-size: 0.82rem; }
  .chip form { display: inline; }
  .chip button { background: #cbd5e0; color: #2d3748; border: none; border-radius: 50%; width: 18px; height: 18px; line-height: 1; cursor: pointer; }
  .chip button:hover { background: #fc8181; color: #fff; }
  .clientadd { margin-top: 8px; display: flex; gap: 6px; }
  .muted { color: #a0aec0; font-size: 0.85rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { border-bottom: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f7fafc; position: sticky; top: 0; }
  .detail { color: #4a5568; max-width: 380px; white-space: pre-wrap; margin-top: 4px; }
  .badge { padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 0.75rem; }
  .sent { background: #c6f6d5; color: #22543d; }
  .failed { background: #fed7d7; color: #742a2a; }
  .pending { background: #fefcbf; color: #744210; }
  .warn { color: #975a16; }
  .err { color: #c53030; font-size: 0.72rem; max-width: 220px; margin-top: 4px; word-break: break-word; }
  .status-form { margin: 0; }
  select.ws { border-radius: 12px; font-weight: 600; border: 1px solid transparent; }
  .ws-new { background: #e2e8f0; color: #2d3748; }
  .ws-in_progress { background: #bee3f8; color: #2a4365; }
  .ws-stuck { background: #fed7d7; color: #742a2a; }
  .ws-solved { background: #c6f6d5; color: #22543d; }
  button { cursor: pointer; margin-top: 4px; }
</style></head>
<body>
<h1>🎫 Ticket Admin</h1>

<h2>Clients (shown in the form dropdown)</h2>
<div class="panel">
  ${clientChips}
  <form method="post" action="/admin/clients" class="clientadd">
    <input type="text" name="name" placeholder="Add a client / company name" maxlength="100" required>
    <button type="submit">Add client</button>
  </form>
</div>

<h2>Tickets (${tickets.length}${anyFilter ? ', filtered' : ''})</h2>
<div class="panel">
  <form method="get" action="/admin" class="filters">
    <label>Status<select name="work_status"><option value="">Any</option>${statusFilterOpts}</select></label>
    <label>Priority<select name="priority"><option value="">Any</option>${priorityFilterOpts}</select></label>
    <label>Client<select name="client"><option value="">Any</option>${clientFilterOpts}</select></label>
    <label>From<input type="date" name="date_from" value="${esc(filters.date_from)}"></label>
    <label>To<input type="date" name="date_to" value="${esc(filters.date_to)}"></label>
    <button type="submit">Filter</button>
    ${anyFilter ? '<a class="clear" href="/admin">Clear</a>' : ''}
  </form>
</div>

<table>
<tr><th>ID</th><th>Created (UTC)</th><th>Client</th><th>Name</th><th>Ticket</th><th>Priority</th><th>Status</th><th>File</th><th>AI</th><th>Slack</th></tr>
${rows || '<tr><td colspan="10">No tickets match.</td></tr>'}
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
