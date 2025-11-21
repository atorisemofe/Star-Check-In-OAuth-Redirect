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

// -------------------------------------------------------
// ENV CHECK
// -------------------------------------------------------
console.log("ENV Check:");
console.log("CLIENT_ID:", process.env.CLIENT_ID ? "(set)" : "(missing)");
console.log("CLIENT_SECRET:", process.env.CLIENT_SECRET ? "(set)" : "(missing)");
console.log("EVENTBRITE_ACCESS_TOKEN:", process.env.EVENTBRITE_ACCESS_TOKEN ? "(set)" : "(missing)");

// -------------------------------------------------------
// DATABASE INIT
// -------------------------------------------------------
console.log("=== Initializing SQLite Database ===");

const dbPath = path.join(__dirname, "sqlite.db");
console.log("SQLite DB Path:", dbPath);

const db = new sqlite3.Database(
    dbPath,
    sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
    (err) => {
        if (err) console.error("❌ DB Connection Error:", err);
        else console.log("✅ SQLite Connected");
    }
);

db.serialize(() => {
    console.log("Creating tokens table if not exists...");
    db.run(`
        CREATE TABLE IF NOT EXISTS tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log("Creating attendees table if not exists...");
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

// -------------------------------------------------------
// TOKEN EXCHANGE
// -------------------------------------------------------
app.post("/exchange_token", async (req, res) => {
    console.log("\n=== POST /exchange_token ===");
    console.log("Incoming body:", req.body);

    const { code } = req.body;
    if (!code) {
        console.warn("Missing OAuth code");
        return res.status(400).json({ error: "Missing code" });
    }

    console.log("Exchanging OAuth code:", code);

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

        console.log("Clearing old tokens...");
        db.run(`DELETE FROM tokens`);

        console.log("Inserting new tokens...");
        db.run(
            `INSERT INTO tokens (access_token, refresh_token) VALUES (?, ?)`,
            [data.access_token, data.refresh_token],
            (err) => {
                if (err) console.error("Token insert error:", err);
                else console.log("Tokens saved.");
            }
        );

        res.json(data);
    } catch (err) {
        console.error("Token exchange error:", err);
        res.status(500).json({ error: "Token exchange failed" });
    }
});

// -------------------------------------------------------
// GET TOKENS
// -------------------------------------------------------
function getTokens() {
    console.log("Fetching latest OAuth tokens from DB...");
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT * FROM tokens ORDER BY id DESC LIMIT 1`,
            [],
            (err, row) => {
                if (err) {
                    console.error("DB Token fetch error:", err);
                    reject(err);
                } else {
                    console.log("Fetched tokens:", row);
                    resolve(row);
                }
            }
        );
    });
}

// -------------------------------------------------------
// FETCH ATTENDEES FROM EVENTBRITE
// -------------------------------------------------------
app.get("/attendees/:eventId", async (req, res) => {
    console.log("\n=== GET /attendees ===");
    console.log("Params:", req.params);

    try {
        const { eventId } = req.params;
        const tokens = await getTokens();
        if (!tokens) {
            console.warn("No OAuth tokens found in DB!");
            return res.status(400).json({ error: "No OAuth tokens stored" });
        }

        console.log(`Fetching attendees for event: ${eventId}`);

        const response = await fetch(
            `https://www.eventbriteapi.com/v3/events/${eventId}/attendees/`,
            { headers: { Authorization: `Bearer ${tokens.access_token}` } }
        );

        const data = await response.json();
        console.log("Eventbrite attendees response:", data);

        const attendees = data.attendees || [];

        console.log(`Upserting ${attendees.length} attendees into SQLite...`);
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
                ],
                (err) => {
                    if (err) console.error("DB attendee insert/update error:", err);
                    else console.log("Upserted attendee:", a.id);
                }
            );
        });

        res.json(attendees);
    } catch (err) {
        console.error("Fetch attendees error:", err);
        res.status(500).json({ error: "Failed to fetch attendees" });
    }
});

// -------------------------------------------------------
// WEBSOCKET SERVER
// -------------------------------------------------------
console.log("Starting WebSocket server...");

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/websocket" });

wss.on("connection", ws => {
    console.log("🔌 WebSocket client connected.");

    ws.on("close", () => console.log("❌ WebSocket client disconnected"));
    ws.on("error", err => console.error("WebSocket error:", err));

    console.log("Sending welcome packet...");
    ws.send(JSON.stringify({
        id: "welcome_001",
        name: "WebSocket Connected",
        email: "",
        status: "connected"
    }));
});

function broadcastAttendeeUpdate(attendee) {
    console.log("📢 Broadcasting attendee update:", attendee);
    console.log("Connected clients:", wss.clients.size);

    const message = JSON.stringify(attendee);

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            console.log("Sending update to a client...");
            client.send(message);
        }
    });
}

// -------------------------------------------------------
// WEBHOOK ENDPOINT
// -------------------------------------------------------
app.post("/webhook", async (req, res) => {
    console.log("\n=== Eventbrite Webhook Received ===");
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);

    res.json({ received: true });

    try {
        const body = req.body;
        const apiUrl = body?.api_url;
        const action = body?.config?.action || "updated";

        console.log("Webhook api_url:", apiUrl);
        console.log("Webhook action:", action);

        let attendeeData;

        if (apiUrl) {
            console.log("Fetching attendee from Eventbrite:", apiUrl);

            if (!process.env.EVENTBRITE_ACCESS_TOKEN) {
                console.warn("⚠️ No EVENTBRITE_ACCESS_TOKEN set!");
                return;
            }

            const attendeeResp = await fetch(apiUrl, {
                headers: { Authorization: `Bearer ${process.env.EVENTBRITE_ACCESS_TOKEN}` }
            });

            attendeeData = await attendeeResp.json();

            console.log("Full attendee JSON from Eventbrite:");
            console.log(JSON.stringify(attendeeData, null, 2));

            attendeeData = {
                id: attendeeData.id,
                name: attendeeData.profile?.name || "Unknown",
                email: attendeeData.profile?.email || "",
                status: attendeeData.status || action
            };
        } else {
            console.log("No api_url — using test payload");
            attendeeData = {
                id: "test_001",
                name: "Test Attendee",
                email: "test@example.com",
                status: action
            };
        }

        console.log("Upserting attendee into DB:", attendeeData);

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
            [attendeeData.id, attendeeData.name, attendeeData.email, attendeeData.status],
            (err) => {
                if (err) console.error("DB error inserting attendee:", err);
                else console.log("DB attendee updated:", attendeeData);
            }
        );

        broadcastAttendeeUpdate(attendeeData);

    } catch (err) {
        console.error("Webhook processing error:", err);
    }
});

// -------------------------------------------------------
// LOCAL ATTENDEE FETCH
// -------------------------------------------------------
app.get("/local_attendees", (req, res) => {
    console.log("\n=== GET /local_attendees ===");

    db.all(`SELECT * FROM attendees`, [], (err, rows) => {
        if (err) {
            console.error("Local attendees DB error:", err);
            return res.status(500).json({ error: "DB error" });
        }
        console.log("Returning attendees:", rows.length);
        res.json(rows);
    });
});

// -------------------------------------------------------
// START SERVER
// -------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 Backend running on port ${PORT}`);
    console.log("=====================================================\n");
});
