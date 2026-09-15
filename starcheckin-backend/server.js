require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const WebSocket = require('ws');

const eventbrite = require('./eventbriteClient');
const attendeeCache = require('./attendeeCache');

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

let accessToken = null;
let refreshToken = null;

app.use(bodyParser.json());
app.use(cors());

// ----------------- Logging middleware -----------------
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    next();
});

// ----------------- Save tokens manually -----------------
app.post('/save_token', (req, res) => {
    accessToken = req.body.access_token;
    refreshToken = req.body.refresh_token;
    console.log('Saved access token:', accessToken);
    console.log('Saved refresh token:', refreshToken);
    res.json({ status: 'ok' });
});

// ----------------- Exchange OAuth code for token -----------------
app.post('/exchange_token', async (req, res) => {
    const { code } = req.body;

    console.log('Received code from frontend:', code);

    if (!code) {
        console.error('No authorization code provided!');
        return res.status(400).json({ error: 'Missing code' });
    }

    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error('CLIENT_ID or CLIENT_SECRET is missing!');
        console.log('CLIENT_ID:', CLIENT_ID ? 'set' : 'missing');
        console.log('CLIENT_SECRET:', CLIENT_SECRET ? 'set' : 'missing');
        return res.status(500).json({ error: 'Server misconfiguration: CLIENT_ID or CLIENT_SECRET missing' });
    }

    try {
        const params = new URLSearchParams();
        params.append('code', code);
        params.append('client_secret', CLIENT_SECRET);
        params.append('client_id', CLIENT_ID);
        params.append('redirect_uri', 'https://star-check-in-oauth-redirect.onrender.com/eventbrite-callback.html');
        params.append('grant_type', 'authorization_code');

        console.log('Sending request to Eventbrite with params:', params.toString());

        // Login only happens once per session, not on the hot check-in path,
        // so this one goes straight through axios rather than the throttled
        // eventbrite client.
        const response = await axios.post(
            'https://www.eventbrite.com/oauth/token',
            params.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        console.log('Eventbrite response data:', response.data);

        accessToken = response.data.access_token;
        refreshToken = response.data.refresh_token;

        console.log('Saved access token:', accessToken);
        console.log('Saved refresh token:', refreshToken);

        res.json({
            access_token: accessToken,
            refresh_token: refreshToken
        });
    } catch (err) {
        console.error('Error exchanging code:', err.response?.data || err.message);
        res.status(500).json({
            error: 'Token exchange failed',
            details: err.response?.data || err.message
        });
    }
});

// ----------------- Get list of events across all organizations -----------------
// Cached briefly: the app calls this on every onResume(), and the event
// lineup for an org basically never changes minute-to-minute during a show.
let eventsCache = { data: null, ts: 0 };
const EVENTS_TTL_MS = 60 * 1000;

app.get('/events', async (req, res) => {
    if (!accessToken) return res.status(401).json({ error: 'No access token saved' });

    if (eventsCache.data && Date.now() - eventsCache.ts < EVENTS_TTL_MS) {
        return res.json(eventsCache.data);
    }

    try {
        const orgResponse = await eventbrite.get('https://www.eventbriteapi.com/v3/users/me/organizations/', accessToken);

        const orgs = orgResponse.data.organizations;
        if (!orgs || orgs.length === 0) {
            return res.status(404).json({ error: 'No organizations found for user' });
        }

        const allEvents = [];
        for (const org of orgs) {
            try {
                const eventsResponse = await eventbrite.get(
                    `https://www.eventbriteapi.com/v3/organizations/${org.id}/events/`,
                    accessToken
                );

                const orgEvents = eventsResponse.data.events.map(ev => ({
                    id: ev.id,
                    name: ev.name.text,
                    org_name: org.name
                }));

                allEvents.push(...orgEvents);
            } catch (err) {
                console.error(`Failed to fetch events for org ${org.id}:`, err.response?.data || err.message);
            }
        }

        allEvents.reverse(); // newest events first
        eventsCache = { data: allEvents, ts: Date.now() };

        console.log('Fetched all events (reversed):', allEvents);
        res.json(allEvents);
    } catch (err) {
        console.error('Error fetching organizations or events:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch events', details: err.response?.data || err.message });
    }
});

// ----------------- Get attendees for an event -----------------
// Serves from the in-memory cache. Eventbrite is only hit here on the very
// first request for an event (cold cache) or if ?refresh=true is passed
// explicitly; every other read is free. The cache itself is kept warm by
// the webhook handler below.
app.get('/attendees/:eventId', async (req, res) => {
    const { eventId } = req.params;
    if (!accessToken) {
        return res.status(401).json({ error: 'No access token saved' });
    }

    try {
        const forceRefresh = req.query.refresh === 'true';
        const attendees = (attendeeCache.hasSynced(eventId) && !forceRefresh)
            ? attendeeCache.listFor(eventId)
            : await attendeeCache.fullSync(eventId, accessToken);

        res.json(attendees);
    } catch (err) {
        console.error('Error fetching attendees:', err.response?.data || err.message);
        res.status(500).json({
            error: 'Failed to fetch attendees',
            details: err.response?.data || err.message
        });
    }
});

// ----------------- WebSocket server -----------------
const wss = new WebSocket.Server({ noServer: true });
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

// Broadcast helper
function broadcastEvent(eventId) {
    const message = JSON.stringify({ type: 'attendee_update', eventId });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ----------------- Webhook endpoint -----------------
// Eventbrite can fire a burst of these in the same second (a rush of people
// checking in at once). We ack immediately, and instead of fetching on every
// single delivery we debounce per event: deliveries for the same event that
// arrive within WEBHOOK_DEBOUNCE_MS of each other are coalesced into one
// batch, so a burst of 20 check-ins costs at most ~20 single-attendee calls
// (or a single full sync, whichever is cheaper) instead of 20 full
// guest-list re-fetches times however many stations are connected.
const WEBHOOK_DEBOUNCE_MS = 500;
const pendingByEvent = new Map(); // eventId -> { attendeeUrls: Set<string>, timer }

app.post('/webhook', async (req, res) => {
    try {
        const eventType = req.headers['x-eventbrite-event'];
        const deliveryId = req.headers['x-eventbrite-delivery'];
        const payload = req.body;

        console.log(`Webhook: ${eventType} (delivery ${deliveryId})`);
        console.log('Payload:', JSON.stringify(payload, null, 2));

        if (eventType?.startsWith('attendee.') && payload?.api_url) {
            const eventId = extractEventIdFromApiUrl(payload.api_url);

            if (!eventId) {
                console.warn('Could not extract eventId from api_url:', payload.api_url);
            } else {
                queueAttendeeUpdate(eventId, payload.api_url);
            }
        }

        res.json({ received: true });
    } catch (err) {
        console.error('Error handling webhook:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to process webhook', details: err.response?.data || err.message });
    }
});

function queueAttendeeUpdate(eventId, attendeeApiUrl) {
    let pending = pendingByEvent.get(eventId);
    if (!pending) {
        pending = { attendeeUrls: new Set(), timer: null };
        pendingByEvent.set(eventId, pending);
    }

    pending.attendeeUrls.add(attendeeApiUrl);

    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => flushPendingUpdates(eventId), WEBHOOK_DEBOUNCE_MS);
}

async function flushPendingUpdates(eventId) {
    const pending = pendingByEvent.get(eventId);
    if (!pending) return;
    pendingByEvent.delete(eventId);

    if (!accessToken) {
        console.warn('Skipping webhook flush, no access token saved yet');
        return;
    }

    try {
        if (!attendeeCache.hasSynced(eventId)) {
            // No baseline cached for this event yet - one full sync covers
            // every pending change at once and is cheaper than fetching each
            // attendee individually anyway.
            await attendeeCache.fullSync(eventId, accessToken);
        } else {
            const urls = Array.from(pending.attendeeUrls);
            await Promise.all(
                urls.map(url => attendeeCache.upsertSingleAttendee(eventId, url, accessToken))
            );
        }
    } catch (err) {
        console.error(`Failed to process webhook updates for event ${eventId}:`, err.response?.data || err.message);
        // Fall through and notify clients anyway - their next GET will
        // trigger whatever sync is still needed.
    }

    broadcastEvent(eventId);
}

// ----------------- Periodic reconciliation -----------------
// Self-heals against any webhook delivery that gets dropped (Eventbrite
// retries failed deliveries, but a redeploy or a brief outage could still
// miss one). Only resyncs events we've already loaded at least once, and
// goes through the same throttled client as everything else.
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;

setInterval(() => {
    if (!accessToken) return;
    for (const eventId of attendeeCache.knownEventIds()) {
        attendeeCache.fullSync(eventId, accessToken).catch(err => {
            console.error(`Periodic resync failed for event ${eventId}:`, err.response?.data || err.message);
        });
    }
}, RECONCILE_INTERVAL_MS);

// ----------------- Extract EventID -----------------
function extractEventIdFromApiUrl(apiUrl) {
    const match = apiUrl.match(/\/events\/(\d+)\//);
    return match ? match[1] : null;
}

// ----------------- Health check -----------------
app.get('/', (req, res) => res.send('Star Check-In backend is running'));
