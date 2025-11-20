const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json());
app.use(cors());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = "https://star-check-in-oauth-redirect.onrender.com/eventbrite-callback.html";

/* ============================
   SQLite Database Setup
============================ */
const db = new sqlite3.Database(
    path.join(__dirname, "sqlite.db"),
    sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
);

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
            status TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

/* ============================
   OAuth Token Exchange
============================ */
app.get("/exchange_token", (req, res) => {
    res.send("Backend is running! Use POST to /exchange_token with { code }");
});

app.post("/exchange_token", async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Missing code" });

    const params = new URLSearchParams();
    params.append("client_id", CLIENT_ID);
    params.append("client_secret", CLIENT_SECRET);
    params.append("code", code);
    params.append("redirect_uri", REDIRECT_URI);
    params.append("grant_type", "authorization_code");

    try {
        const response = await fetch("https://www.eventbrite.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString()
        });

        const data = await response.json();

        // store tokens
        db.run(`DELETE FROM tokens`);
        db.run(
            `INSERT INTO tokens (access_token, refresh_token) VALUES (?, ?)`,
            [data.access_token, data.refresh_token]
        );

        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Token exchange failed" });
    }
});

/* ============================
   Helper: Get Tokens
============================ */
function getTokens() {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT * FROM tokens ORDER BY id DESC LIMIT 1`,
            [],
            (err, row) => (err ? reject(err) : resolve(row))
        );
    });
}

/* ============================
   Fetch Attendees from Eventbrite
============================ */
app.get("/attendees/:eventId", async (req, res) => {
    try {
        const { eventId } = req.params;
        const tokens = await getTokens();
        if (!tokens) return res.status(400).json({ error: "No OAuth tokens stored" });

        const response = await fetch(
            `https://www.eventbriteapi.com/v3/events/${eventId}/attendees/`,
            {
                headers: {
                    Authorization: `Bearer ${tokens.access_token}`
                }
            }
        );

        const data = await response.json();
        const attendees = data.attendees || [];

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

        res.json(attendees);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch attendees" });
    }
});

/* ============================
   WebSocket Setup
============================ */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcastAttendeeUpdate(attendee) {
    const message = JSON.stringify(attendee);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

/* ============================
   Webhook Endpoint
============================ */
app.post("/webhook", async (req, res) => {
    console.log("=== Eventbrite Webhook Received ===");
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);

    // Immediately acknowledge receipt to Eventbrite
    res.json({ received: true });

    try {
        const body = req.body;
        const apiUrl = body?.api_url;
        const action = body?.config?.action || "updated";

        let attendeeData;

        if (apiUrl) {
            // Real webhook: fetch attendee details from Eventbrite
            const accessToken = process.env.EVENTBRITE_ACCESS_TOKEN;
            if (!accessToken) {
                console.warn("No EVENTBRITE_ACCESS_TOKEN set");
                return;
            }

            const attendeeResp = await fetch(apiUrl, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });

            if (!attendeeResp.ok) {
                console.error("Failed to fetch attendee from Eventbrite:", attendeeResp.status);
                return;
            }

            attendeeData = await attendeeResp.json();
            // Make sure attendeeData has required fields
            attendeeData.id = attendeeData.id || "unknown_id";
            attendeeData.name = attendeeData.profile?.name || "Unknown";
            attendeeData.email = attendeeData.profile?.email || "";
            attendeeData.status = attendeeData.status || action;

        } else {
            // Test webhook: create a fake attendee
            attendeeData = {
                id: "test_001",
                name: "Test Attendee",
                email: "test@example.com",
                status: action
            };
        }

        // Insert/update attendee in SQLite
        db.run(
            `
            INSERT INTO attendees (id, name, email, status)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
                name=excluded.name,
                email=excluded.email,
                status=excluded.status,
                updated_at=CURRENT_TIMESTAMP
            `,
            [attendeeData.id, attendeeData.name, attendeeData.email, attendeeData.status]
        );

        console.log("Attendee updated:", attendeeData);

        // Broadcast update via WebSocket
        broadcastAttendeeUpdate(attendeeData);

    } catch (err) {
        console.error("Webhook processing error:", err);
    }
});


/* ============================
   Local Attendee List (For Android)
============================ */
app.get("/local_attendees", (req, res) => {
    db.all(`SELECT * FROM attendees`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB error" });
        res.json(rows);
    });
});

/* ============================
   Start Server + WebSocket
============================ */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Backend + WebSocket running on port ${PORT}`));
