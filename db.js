const Database = require('better-sqlite3');
const path = require('path');

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
    attachment_path TEXT,
    ai_ok INTEGER NOT NULL DEFAULT 0,
    ai_title TEXT,
    ai_summary TEXT,
    ai_technical TEXT,
    ai_priority TEXT,
    slack_status TEXT NOT NULL DEFAULT 'pending',
    slack_error TEXT
  )
`);

module.exports = {
  insertTicket(t) {
    const stmt = db.prepare(`
      INSERT INTO tickets (name, client, site_url, title, details, attachment_path)
      VALUES (@name, @client, @site_url, @title, @details, @attachment_path)
    `);
    return stmt.run(t).lastInsertRowid;
  },

  saveAiResult(id, ai) {
    db.prepare(`
      UPDATE tickets SET ai_ok = @ai_ok, ai_title = @ai_title, ai_summary = @ai_summary,
        ai_technical = @ai_technical, ai_priority = @ai_priority WHERE id = @id
    `).run({ id, ...ai });
  },

  saveSlackStatus(id, status, error) {
    db.prepare('UPDATE tickets SET slack_status = ?, slack_error = ? WHERE id = ?')
      .run(status, error || null, id);
  },

  getTicket(id) {
    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  },

  listTickets() {
    return db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 500').all();
  },
};
