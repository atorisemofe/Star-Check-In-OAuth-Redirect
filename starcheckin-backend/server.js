require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

let accessToken = null;
let refreshToken = null;

app.use(cors());
app.use(bodyParser.json());

console.log("Server starting...");

// Exchange code for tokens
app.post('/exchange_token', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });

    try {
        const response = await axios.post('https://www.eventbrite.com/oauth/token', null, {
            params: {
                code,
                client_secret: CLIENT_SECRET,
                client_id: CLIENT_ID,
                grant_type: 'authorization_code'
            }
        });

        accessToken = response.data.access_token;
        refreshToken = response.data.refresh_token;

        console.log('Saved access token:', accessToken);

        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Error exchanging code:', err.response?.data || err.message);
        res.status(500).json({ error: 'Token exchange failed', details: err.response?.data || err.message });
    }
});

// Get events
app.get('/events', async (req, res) => {
    if (!accessToken) return res.status(401).json({ error: 'No access token' });

    try {
        const response = await axios.get('https://www.eventbriteapi.com/v3/users/me/events/', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const events = response.data.events.map(ev => ({
            id: ev.id,
            name: ev.name.text
        }));

        res.json(events);
    } catch (err) {
        console.error('Error fetching events:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch events', details: err.response?.data || err.message });
    }
});

// Get attendees
app.get('/attendees/:eventId', async (req, res) => {
    const { eventId } = req.params;
    if (!accessToken) return res.status(401).json({ error: 'No access token' });

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

        res.json(attendees);
    } catch (err) {
        console.error('Error fetching attendees:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch attendees', details: err.response?.data || err.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
