import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pg from "pg";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --------------------
// DATABASE CONNECTION
// --------------------
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

db.connect()
  .then(() => console.log("✅ Database connected"))
  .catch(err => console.error("❌ Database connection error:", err));

// ----------------------
// WEBSOCKET SERVER SETUP
// ----------------------
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔌 WebSocket client connected");

  ws.on("close", () => {
    console.log("❌ WebSocket client disconnected");
  });
});

/** Broadcast helper */
function broadcastUpdate(attendee) {
  const payload = JSON.stringify({ type: "attendee_update", attendee });

  console.log("📢 Broadcasting WebSocket Update:");
  console.log("   Payload:", payload);
  console.log("   Connected Clients:", wss.clients.size);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ---------------------------
// WEBHOOK ENDPOINT (Eventbrite)
// ---------------------------
app.post("/webhook", async (req, res) => {
  console.log("🔔 Webhook Received!");
  console.log("📥 Raw Body:", JSON.stringify(req.body, null, 2));

  try {
    const { api_url, config } = req.body;

    console.log("📌 Webhook Config:", config);

    if (!api_url) {
      console.error("❌ Missing api_url");
      return res.status(400).send("Missing api_url");
    }

    // Fetch full attendee details from Eventbrite API
    console.log("🌐 Fetching attendee from:", api_url);

    const eventbriteRes = await fetch(api_url, {
      headers: {
        Authorization: `Bearer ${process.env.EVENTBRITE_ACCESS_TOKEN}`,
      },
    });

    const attendeeData = await eventbriteRes.json();

    console.log("📤 Full Attendee JSON From Eventbrite:");
    console.log(JSON.stringify(attendeeData, null, 2));

    const id = attendeeData.id;
    const name = attendeeData.profile?.name || "No Name";
    const email = attendeeData.profile?.email || null;
    const checkedIn = attendeeData.checked_in ? "checked_in" : "not_checked_in";

    console.log("🔍 Parsed Attendee:");
    console.log({ id, name, email, checkedIn });

    // -----------------------------
    // DB FETCH BEFORE UPDATE
    // -----------------------------
    console.log("🗄️ Fetching attendee from database:", id);

    const existing = await db.query(
      "SELECT * FROM attendees WHERE id = $1",
      [id]
    );

    console.log("📦 Database Result Before Update:", existing.rows);

    // -----------------------------
    // DB INSERT/UPDATE
    // -----------------------------
    const updated = await db.query(
      `INSERT INTO attendees (id, name, email, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id)
       DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, status = EXCLUDED.status
       RETURNING *`,
      [id, name, email, checkedIn]
    );

    console.log("💾 Database Updated Row:", updated.rows[0]);

    // -----------------------------
    // BROADCAST TO MOBILE APP
    // -----------------------------
    console.log("📡 Sending WebSocket update...");
    broadcastUpdate(updated.rows[0]);

    return res.status(200).send("Received");
  } catch (error) {
    console.error("🔥 WEBHOOK ERROR:", error);
    res.status(500).send("Webhook processing failed");
  }
});

// -----------------------------
// CREATE HTTP SERVER & UPGRADE
// -----------------------------
const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server running on port ${process.env.PORT || 3000}`);
});

server.on("upgrade", (req, socket, head) => {
  console.log("⬆️ WebSocket upgrade requested");

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});
