// attendeeservice.js
const axios = require('axios');
const db = require('./db');

// Save tokens to DB
function saveTokens(accessToken, refreshToken) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM tokens`,
      [],
      function () {
        db.run(
          `INSERT INTO tokens (access_token, refresh_token) VALUES (?, ?)`,
          [accessToken, refreshToken],
          err => {
            if (err) reject(err);
            else resolve();
          }
        );
      }
    );
  });
}

// Get tokens from DB
function getTokens() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM tokens ORDER BY id DESC LIMIT 1`, [], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Fetch attendees from Eventbrite
async function fetchAttendees(eventId) {
  const tokens = await getTokens();
  if (!tokens) throw new Error("No tokens saved.");

  const url = `https://www.eventbriteapi.com/v3/events/${eventId}/attendees/`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`
    }
  });

  // Save to DB
  const attendees = response.data.attendees || [];

  attendees.forEach(a => {
    db.run(
      `
      INSERT INTO attendees (id, name, email, status)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        email=excluded.email
      `,
      [
        a.id,
        a.profile?.name || "",
        a.profile?.email || "",
        "updated"
      ]
    );
  });

  return attendees;
}

// Handle webhook event from Eventbrite
function handleWebhook(body) {
  const attendee = body?.api_url_object;
  if (!attendee || !attendee.id) return;

  const status = body.config.action; // updated, check_in, check_out

  db.run(
    `
    INSERT INTO attendees (id, name, email, status)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,
      updated_at=CURRENT_TIMESTAMP
    `,
    [attendee.id, attendee.name || "", attendee.email || "", status]
  );
}

// Get attendees from DB for UI
function getAttendeesFromDB() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM attendees`, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

module.exports = {
  saveTokens,
  getTokens,
  fetchAttendees,
  handleWebhook,
  getAttendeesFromDB
};
