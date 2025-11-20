// db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(
  path.join(__dirname, 'sqlite.db'),
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
);

// Initialize tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attendees (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      status TEXT,        -- checked_in | checked_out | updated
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

module.exports = db;
