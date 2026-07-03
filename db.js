// Dual-mode store:
//  - On Vercel (DATABASE_URL/POSTGRES_URL set): Postgres (Neon via Vercel marketplace)
//  - Locally (no env var): zero-config SQLite file
// Both expose the same async interface.

const path = require('path');

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

const WORK_STATUSES = ['new', 'in_progress', 'stuck', 'solved'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const TICKET_COLUMNS = `
  id, created_at, name, client, site_url, title, details, attachment_url,
  ai_ok, ai_title, ai_summary, ai_technical, ai_priority, ai_error,
  slack_status, slack_error, work_status
`;

// Build a WHERE clause from admin filters. `ph(i)` returns the placeholder
// for the i-th (1-based) parameter: '?' for SQLite, '$i' for Postgres.
function buildFilter(filters, ph) {
  const where = [];
  const params = [];
  const add = (make, val) => {
    params.push(val);
    where.push(make(ph(params.length)));
  };
  if (filters.work_status && WORK_STATUSES.includes(filters.work_status)) {
    add((p) => `work_status = ${p}`, filters.work_status);
  }
  if (filters.priority && PRIORITIES.includes(filters.priority)) {
    add((p) => `ai_priority = ${p}`, filters.priority);
  }
  if (filters.client) add((p) => `client = ${p}`, filters.client);
  if (filters.date_from) add((p) => `created_at >= ${p}`, filters.date_from);
  if (filters.date_to) {
    // Include the whole end day by comparing against the next day's start.
    const next = new Date(filters.date_to + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    add((p) => `created_at < ${p}`, next.toISOString().slice(0, 10));
  }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function postgresStore() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: PG_URL });

  let ready;
  const init = () => {
    if (!ready) {
      ready = (async () => {
        await pool.query(`
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
            ai_title TEXT, ai_summary TEXT, ai_technical TEXT, ai_priority TEXT, ai_error TEXT,
            slack_status TEXT NOT NULL DEFAULT 'pending',
            slack_error TEXT,
            work_status TEXT NOT NULL DEFAULT 'new'
          )
        `);
        // Add columns that older deployments won't have yet.
        await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_error TEXT`);
        await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS work_status TEXT NOT NULL DEFAULT 'new'`);
        await pool.query(`CREATE TABLE IF NOT EXISTS clients (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE)`);
      })();
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
           ai_technical = $5, ai_priority = $6, ai_error = $7 WHERE id = $1`,
        [id, !!ai.ai_ok, ai.ai_title, ai.ai_summary, ai.ai_technical, ai.ai_priority, ai.ai_error || null]
      );
    },
    async saveSlackStatus(id, status, error) {
      await init();
      await pool.query('UPDATE tickets SET slack_status = $2, slack_error = $3 WHERE id = $1', [id, status, error || null]);
    },
    async setWorkStatus(id, status) {
      await init();
      await pool.query('UPDATE tickets SET work_status = $2 WHERE id = $1', [id, status]);
    },
    async getTicket(id) {
      await init();
      const { rows } = await pool.query(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = $1`, [id]);
      return rows[0];
    },
    async listTickets(filters = {}) {
      await init();
      const { clause, params } = buildFilter(filters, (i) => `$${i}`);
      const { rows } = await pool.query(
        `SELECT ${TICKET_COLUMNS} FROM tickets ${clause} ORDER BY id DESC LIMIT 500`,
        params
      );
      return rows;
    },
    async listClients() {
      await init();
      const { rows } = await pool.query('SELECT name FROM clients ORDER BY name ASC');
      return rows.map((r) => r.name);
    },
    async addClient(name) {
      await init();
      await pool.query('INSERT INTO clients (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    },
    async removeClient(name) {
      await init();
      await pool.query('DELETE FROM clients WHERE name = $1', [name]);
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
      ai_title TEXT, ai_summary TEXT, ai_technical TEXT, ai_priority TEXT, ai_error TEXT,
      slack_status TEXT NOT NULL DEFAULT 'pending',
      slack_error TEXT,
      work_status TEXT NOT NULL DEFAULT 'new'
    );
    CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
  `);

  // Migrate older local DBs that predate ai_error / work_status.
  const cols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  if (!cols.includes('ai_error')) db.exec('ALTER TABLE tickets ADD COLUMN ai_error TEXT');
  if (!cols.includes('work_status')) db.exec("ALTER TABLE tickets ADD COLUMN work_status TEXT NOT NULL DEFAULT 'new'");

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
          ai_technical = @ai_technical, ai_priority = @ai_priority, ai_error = @ai_error WHERE id = @id
      `).run({ id, ...ai, ai_ok: ai.ai_ok ? 1 : 0, ai_error: ai.ai_error || null });
    },
    async saveSlackStatus(id, status, error) {
      db.prepare('UPDATE tickets SET slack_status = ?, slack_error = ? WHERE id = ?').run(status, error || null, id);
    },
    async setWorkStatus(id, status) {
      db.prepare('UPDATE tickets SET work_status = ? WHERE id = ?').run(status, id);
    },
    async getTicket(id) {
      return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    },
    async listTickets(filters = {}) {
      const { clause, params } = buildFilter(filters, () => '?');
      return db.prepare(`SELECT ${TICKET_COLUMNS} FROM tickets ${clause} ORDER BY id DESC LIMIT 500`).all(...params);
    },
    async listClients() {
      return db.prepare('SELECT name FROM clients ORDER BY name ASC').all().map((r) => r.name);
    },
    async addClient(name) {
      db.prepare('INSERT OR IGNORE INTO clients (name) VALUES (?)').run(name);
    },
    async removeClient(name) {
      db.prepare('DELETE FROM clients WHERE name = ?').run(name);
    },
  };
}

function unconfiguredStore() {
  const fail = async () => {
    throw new Error(
      'No database connected. In your Vercel project: Storage tab → Create Database → Neon (Postgres), then Redeploy. That sets DATABASE_URL automatically.'
    );
  };
  return {
    insertTicket: fail, saveAiResult: fail, saveSlackStatus: fail, setWorkStatus: fail,
    getTicket: fail, listTickets: fail, listClients: fail, addClient: fail, removeClient: fail,
  };
}

const store = PG_URL ? postgresStore() : process.env.VERCEL ? unconfiguredStore() : sqliteStore();

module.exports = Object.assign(store, { WORK_STATUSES, PRIORITIES });
