const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

console.log("=== Starting backend... ===");

const app = express();
app.use(express.json());
app.use(cors());

// ENV check
console.log("ENV Check:");
console.log("CLIENT_ID:", process.env.CLIENT_ID ? "(set)" : "(missing)");
console.log("CLIENT_SECRET:", process.env.CLIENT_SECRET ? "(set)" : "(missing)");

// DATABASE SETUP
const dbPath = path.join(__dirname, "sqlite.db");
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) console.error("❌ DB Connection Error:", err);
    else console.log("✅ SQLite Connected");
});

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
            event_id TEXT,
            name TEXT,
            email TEXT,
            status TEXT,
            checked_in INTEGER,
            answers TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// HELPER: Get latest OAuth token
function getTokens() {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM tokens ORDER BY id DESC LIMIT 1`, [], (err, row) => {
            if (err) {
                console.error("DB token fetch error:", err);
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

// OAUTH CODE EXCHANGE
app.post("/exchange_token", async (req, res) => {
    const { code } = req.body;
    console.log("Exchange token request received:", code);
    if (!code) return res.status(400).json({ error: "Missing code" });

    const params = new URLSearchParams();
    params.append("client_id", process.env.CLIENT_ID);
    params.append("client_secret", process.env.CLIENT_SECRET);
    params.append("code", code);
    params.append("redirect_uri", "https://star-check-in-oauth-redirect.onrender.com/eventbrite-callback.html");
    params.append("grant_type", "authorization_code");

    try {
        console.log("Calling Eventbrite OAuth...");
        const response = await fetch("https://www.eventbrite.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString()
        });
        const data = await response.json();
        console.log("OAuth Response:", data);

        db.run("DELETE FROM tokens");
        db.run("INSERT INTO tokens (access_token, refresh_token) VALUES (?, ?)", [data.access_token, data.refresh_token], (err) => {
            if (err) console.error("Error saving token:", err);
            else console.log("✅ Tokens saved.");
        });

        res.json(data);
    } catch (err) {
        console.error("Token exchange error:", err);
        res.status(500).json({ error: "Token exchange failed" });
    }
});

// GET EVENTS
app.get("/events", async (req, res) => {
    console.log("GET /events called");
    try {
        const tokens = await getTokens();
        if (!tokens) return res.status(400).json({ error: "No OAuth token stored" });

        console.log("Fetching events from Eventbrite...");
        const response = await fetch("https://www.eventbriteapi.com/v3/users/me/events/", {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        const data = await response.json();
        console.log("Events fetched:", data.events?.length || 0);

        res.json(data.events || []);
    } catch (err) {
        console.error("Fetch events error:", err);
        res.status(500).json({ error: "Failed to fetch events" });
    }
});

// GET ATTENDEES
app.get("/attendees/:eventId", async (req, res) => {
    const { eventId } = req.params;
    console.log(`GET /attendees/${eventId} called`);
    try {
        const tokens = await getTokens();
        if (!tokens) return res.status(400).json({ error: "No OAuth token stored" });

        console.log(`Fetching attendees for event ${eventId}...`);
        const response = await fetch(`https://www.eventbriteapi.com/v3/events/${eventId}/attendees/`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        const data = await response.json();
        const attendees = data.attendees || [];
        console.log(`Fetched ${attendees.length} attendees`);

        attendees.forEach(a => {
            const answersStr = JSON.stringify(a.answers || []);
            const checkedIn = a.checked_in ? 1 : 0;
            db.run(`
                INSERT INTO attendees (id, event_id, name, email, status, checked_in, answers)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,
                    email=excluded.email,
                    status=excluded.status,
                    checked_in=excluded.checked_in,
                    answers=excluded.answers,
                    updated_at=CURRENT_TIMESTAMP
            `, [a.id, eventId, a.profile?.name || "", a.profile?.email || "", a.status || "", checkedIn, answersStr], (err) => {
                if (err) console.error("DB insert error:", err);
                else console.log(`Upserted attendee ${a.id}`);
            });
        });

        res.json(attendees);
    } catch (err) {
        console.error("Fetch attendees error:", err);
        res.status(500).json({ error: "Failed to fetch attendees" });
    }
});

// WEBSOCKET SETUP
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/websocket" });

wss.on("connection", ws => {
    console.log("🔌 WebSocket client connected.");
    ws.on("close", () => console.log("❌ WebSocket client disconnected"));
    ws.on("error", err => console.error("WebSocket error:", err));

    ws.send(JSON.stringify({ id: "welcome_001", name: "WebSocket Connected", status: "connected" }));
});

function broadcastAttendeeUpdate(attendee) {
    const msg = JSON.stringify(attendee);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// START SERVER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
