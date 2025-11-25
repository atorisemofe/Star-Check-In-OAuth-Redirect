require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const qs = require('qs');

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

let accessToken = null;
let refreshToken = null;

app.use(bodyParser.json());

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

    if (!code) return res.status(400).json({ error: 'Missing code' });

    try {
        const params = new URLSearchParams();
        params.append('code', code);
        params.append('client_secret', CLIENT_SECRET);
        params.append('client_id', CLIENT_ID);
        params.append('grant_type', 'authorization_code');

        const response = await axios.post(
            'https://www.eventbrite.com/oauth/token',
            params.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        accessToken = response.data.access_token;
        refreshToken = response.data.refresh_token;

        console.log('Received access token:', accessToken);
        console.log('Received refresh token:', refreshToken);

        res.json({
            access_token: accessToken,
            refresh_token: refreshToken
        });
    } catch (err) {
        console.error('Error exchanging code:', err.response?.data || err.message);
        res.status(500).json({ error: 'Token exchange failed', details: err.response?.data || err.message });
    }
});


// ----------------- Get list of events -----------------
app.get('/events', async (req, res) => {
    if (!accessToken) return res.status(401).json({ error: 'No access token saved' });

    try {
        const response = await axios.get('https://www.eventbriteapi.com/v3/users/me/events/', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const events = response.data.events.map(ev => ({
            id: ev.id,
            name: ev.name.text
        }));

        console.log('Fetched events:', events);
        res.json(events);
    } catch (err) {
        console.error('Error fetching events:', err.response?.data || err.message);
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

// ----------------- Health check -----------------
app.get('/', (req, res) => res.send('Star Check-In backend is running'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
