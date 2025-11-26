require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const qs = require('qs');
const cors = require('cors');
const WebSocket = require('ws');


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

    // Log incoming code
    console.log('Received code from frontend:', code);

    // Check for missing code
    if (!code) {
        console.error('No authorization code provided!');
        return res.status(400).json({ error: 'Missing code' });
    }

    // Check that environment variables exist
    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error('CLIENT_ID or CLIENT_SECRET is missing!');
        console.log('CLIENT_ID:', CLIENT_ID ? 'set' : 'missing');
        console.log('CLIENT_SECRET:', CLIENT_SECRET ? 'set' : 'missing');
        return res.status(500).json({ error: 'Server misconfiguration: CLIENT_ID or CLIENT_SECRET missing' });
    }

    try {
        // Build URL-encoded body
        const params = new URLSearchParams();
        params.append('code', code);
        params.append('client_secret', CLIENT_SECRET);
        params.append('client_id', CLIENT_ID);
        params.append('redirect_uri', 'https://star-check-in-oauth-redirect.onrender.com/eventbrite-callback.html');
        params.append('grant_type', 'authorization_code');

        console.log('Sending request to Eventbrite with params:', params.toString());

        const response = await axios.post(
            'https://www.eventbrite.com/oauth/token',
            params.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        // Log full response for debugging
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



// ----------------- Get list of events -----------------
// ----------------- Get list of events across all organizations -----------------
app.get('/events', async (req, res) => {
    if (!accessToken) return res.status(401).json({ error: 'No access token saved' });

    try {
        // Step 1: Get all organizations for the user
        const orgResponse = await axios.get('https://www.eventbriteapi.com/v3/users/me/organizations/', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const orgs = orgResponse.data.organizations;
        if (!orgs || orgs.length === 0) {
            return res.status(404).json({ error: 'No organizations found for user' });
        }

        // Step 2: Fetch events for each organization
        const allEvents = [];
        for (let org of orgs) {
            try {
                const eventsResponse = await axios.get(`https://www.eventbriteapi.com/v3/organizations/${org.id}/events/`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });

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

        // After collecting allEvents
        allEvents.reverse(); // now newest events are first
        console.log('Fetched all events (reversed):', allEvents);
        res.json(allEvents);

    } catch (err) {
        console.error('Error fetching organizations or events:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch events', details: err.response?.data || err.message });
    }
});


// ----------------- Get attendees for an event -----------------
app.get('/attendees/:eventId', async (req, res) => {
    const { eventId } = req.params;
    if (!accessToken) return res.status(401).json({ error: 'No access token saved' });

    try {
        const response = await axios.get(`https://www.eventbriteapi.com/v3/events/${eventId}/attendees/`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const attendees = response.data.attendees.map(a => ({
            id: a.id,
            name: a.profile.name,
            email: a.profile.email,
            status: a.status,
            checked_in: a.checked_in,
            answers: a.answers?.reduce((acc, ans) => {
                acc[ans.question] = ans.answer;
                return acc;
            }, {}) || {}
        }));

        console.log(`Fetched attendees for event ${eventId}:`, attendees);
        res.json(attendees);
    } catch (err) {
        console.error('Error fetching attendees:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch attendees', details: err.response?.data || err.message });
    }
});

// // ----------------- Webhook endpoint -----------------
// app.post('/webhook', async (req, res) => {
//     try {
//         const eventType = req.headers['x-eventbrite-event'];
//         const deliveryId = req.headers['x-eventbrite-delivery'];
//         const payload = req.body;

//         console.log(`Received Eventbrite webhook: ${eventType} (delivery ${deliveryId})`);
//         console.log('Payload:', JSON.stringify(payload, null, 2));

//         // For attendee.updated or attendee.created events, you may want to reload attendee data
//         if (eventType?.startsWith('attendee.')) {
//             const attendeeApiUrl = payload.api_url;
//             console.log('Fetching updated attendee info from:', attendeeApiUrl);

//             // Optional: Fetch the attendee data from Eventbrite immediately
//             const response = await axios.get(attendeeApiUrl, {
//                 headers: { Authorization: `Bearer ${accessToken}` }
//             });

//             const updatedAttendee = response.data;
//             console.log('Updated attendee details:', updatedAttendee);

//             // TODO: Broadcast to your Android app via a WebSocket, push notification, or refresh endpoint
//             // Example: Notify connected clients to refetch attendees for the event
//         }

//         // Respond immediately to Eventbrite to acknowledge delivery
//         res.json({ received: true });
//     } catch (err) {
//         console.error('Error handling webhook:', err.response?.data || err.message);
//         res.status(500).json({ error: 'Failed to process webhook', details: err.response?.data || err.message });
//     }
// });

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
app.post('/webhook', async (req, res) => {
    try {
        const eventType = req.headers['x-eventbrite-event'];
        const deliveryId = req.headers['x-eventbrite-delivery'];
        const payload = req.body;

        console.log(`Webhook: ${eventType} (delivery ${deliveryId})`);
        console.log('Payload:', JSON.stringify(payload, null, 2));

        if (eventType?.startsWith('attendee.')) {
            const attendeeApiUrl = payload.api_url;
            const response = await axios.get(attendeeApiUrl, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });

            const updatedAttendee = response.data;
            const eventId = updatedAttendee.event_id || payload.config?.event_id;
            if (eventId) broadcastEvent(eventId);
        }

        res.json({ received: true });
    } catch (err) {
        console.error('Error handling webhook:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to process webhook', details: err.response?.data || err.message });
    }
});


// ----------------- Health check -----------------
app.get('/', (req, res) => res.send('Star Check-In backend is running'));

