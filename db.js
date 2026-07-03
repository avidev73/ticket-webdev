// Dual-mode ticket store:
//  - On Vercel (DATABASE_URL/POSTGRES_URL set): Postgres (Neon via Vercel marketplace)
//  - Locally (no env var): zero-config SQLite file, as before
// Both expose the same async interface.

const path = require('path');

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

const TICKET_COLUMNS = `
  id, created_at, name, client, site_url, title, details, attachment_url,
  ai_ok, ai_title, ai_summary, ai_technical, ai_priority, slack_status, slack_error
`;

function postgresStore() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: PG_URL });

  let ready;
  const init = () => {
    if (!ready) {
      ready = pool.query(`
        CREATE TABLE IF NOT EXISTS tickets (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          name TEXT NOT NULL,
          client TEXT NOT NULL,
          site_url TEXT,
          title TEXT NOT NULL,
          details TEXT NOT NULL,
          attachment_url TEXT,
          ai_ok BOOLEAN NOT NULL DEFAULT false,
          ai_title TEXT,
          ai_summary TEXT,
          ai_technical TEXT,
          ai_priority TEXT,
          slack_status TEXT NOT NULL DEFAULT 'pending',
          slack_error TEXT
        )
      `);
    }
    return ready;
  };

  return {
    async insertTicket(t) {
      await init();
      const { rows } = await pool.query(
        `INSERT INTO tickets (name, client, site_url, title, details, attachment_url)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [t.name, t.client, t.site_url, t.title, t.details, t.attachment_url]
      );
      return rows[0].id;
    },
    async saveAiResult(id, ai) {
      await init();
      await pool.query(
        `UPDATE tickets SET ai_ok = $2, ai_title = $3, ai_summary = $4,
           ai_technical = $5, ai_priority = $6 WHERE id = $1`,
        [id, !!ai.ai_ok, ai.ai_title, ai.ai_summary, ai.ai_technical, ai.ai_priority]
      );
    },
    async saveSlackStatus(id, status, error) {
      await init();
      await pool.query(
        'UPDATE tickets SET slack_status = $2, slack_error = $3 WHERE id = $1',
        [id, status, error || null]
      );
    },
    async getTicket(id) {
      await init();
      const { rows } = await pool.query(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = $1`, [id]);
      return rows[0];
    },
    async listTickets() {
      await init();
      const { rows } = await pool.query(`SELECT ${TICKET_COLUMNS} FROM tickets ORDER BY id DESC LIMIT 500`);
      return rows;
    },
  };
}

function sqliteStore() {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, 'tickets.db'));

  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      name TEXT NOT NULL,
      client TEXT NOT NULL,
      site_url TEXT,
      title TEXT NOT NULL,
      details TEXT NOT NULL,
      attachment_url TEXT,
      ai_ok INTEGER NOT NULL DEFAULT 0,
      ai_title TEXT,
      ai_summary TEXT,
      ai_technical TEXT,
      ai_priority TEXT,
      slack_status TEXT NOT NULL DEFAULT 'pending',
      slack_error TEXT
    )
  `);

  return {
    async insertTicket(t) {
      return db.prepare(`
        INSERT INTO tickets (name, client, site_url, title, details, attachment_url)
        VALUES (@name, @client, @site_url, @title, @details, @attachment_url)
      `).run(t).lastInsertRowid;
    },
    async saveAiResult(id, ai) {
      db.prepare(`
        UPDATE tickets SET ai_ok = @ai_ok, ai_title = @ai_title, ai_summary = @ai_summary,
          ai_technical = @ai_technical, ai_priority = @ai_priority WHERE id = @id
      `).run({ id, ...ai, ai_ok: ai.ai_ok ? 1 : 0 });
    },
    async saveSlackStatus(id, status, error) {
      db.prepare('UPDATE tickets SET slack_status = ?, slack_error = ? WHERE id = ?')
        .run(status, error || null, id);
    },
    async getTicket(id) {
      return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    },
    async listTickets() {
      return db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 500').all();
    },
  };
}

// On Vercel without a database, fail with an actionable message instead of
// crashing the whole function (serverless filesystem is read-only, so the
// SQLite fallback can't work there).
function unconfiguredStore() {
  const fail = async () => {
    throw new Error(
      'No database connected. In your Vercel project: Storage tab → Create Database → Neon (Postgres), then Redeploy. That sets DATABASE_URL automatically.'
    );
  };
  return {
    insertTicket: fail,
    saveAiResult: fail,
    saveSlackStatus: fail,
    getTicket: fail,
    listTickets: fail,
  };
}

module.exports = PG_URL
  ? postgresStore()
  : process.env.VERCEL
    ? unconfiguredStore()
    : sqliteStore();
