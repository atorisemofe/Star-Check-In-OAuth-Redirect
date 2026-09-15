// attendeeCache.js
//
// In-memory per-event attendee cache. This is what actually kills the rate
// limit problem: previously every webhook delivery caused every connected
// device to re-fetch the ENTIRE (paginated) attendee list straight from
// Eventbrite. With N check-in stations connected and an event of any size,
// one single check-in could cost N x (number of pages) Eventbrite calls.
//
// Now:
//   - the full paginated list is only ever fetched from Eventbrite once per
//     event (fullSync), the first time it's needed, and periodically after
//     that for reconciliation
//   - a webhook for a single attendee only fetches that ONE attendee from
//     Eventbrite and patches the cache (upsertSingleAttendee)
//   - every client hitting GET /attendees/:eventId reads the cache; that
//     endpoint no longer talks to Eventbrite on every request
//   - concurrent callers asking for the same not-yet-synced event share a
//     single in-flight sync instead of each starting their own

const eventbrite = require('./eventbriteClient');

// eventId -> { byId: Map<attendeeId, attendee>, lastFullSync: number, syncPromise: Promise|null }
const cache = new Map();

function normalizeAttendee(a) {
  return {
    id: a.id,
    name: a.profile?.name,
    email: a.profile?.email,
    status: a.status,
    checked_in: a.checked_in,
    answers: (a.answers || []).reduce((acc, ans) => {
      acc[ans.question] = ans.answer;
      return acc;
    }, {}),
  };
}

function getEntry(eventId) {
  let entry = cache.get(eventId);
  if (!entry) {
    entry = { byId: new Map(), lastFullSync: 0, syncPromise: null };
    cache.set(eventId, entry);
  }
  return entry;
}

function listFor(eventId) {
  const entry = cache.get(eventId);
  return entry ? Array.from(entry.byId.values()) : [];
}

function hasSynced(eventId) {
  const entry = cache.get(eventId);
  return !!entry && entry.lastFullSync > 0;
}

function knownEventIds() {
  return Array.from(cache.keys());
}

async function fullSync(eventId, accessToken) {
  const entry = getEntry(eventId);

  // Coalesce concurrent callers (e.g. several devices asking for the same
  // event at once with a cold cache) into a single in-flight sync.
  if (entry.syncPromise) return entry.syncPromise;

  entry.syncPromise = (async () => {
    let continuation = null;
    let hasMore = true;
    const fresh = new Map();

    while (hasMore) {
      const url = continuation
        ? `https://www.eventbriteapi.com/v3/events/${eventId}/attendees/?continuation=${continuation}`
        : `https://www.eventbriteapi.com/v3/events/${eventId}/attendees/`;

      const response = await eventbrite.get(url, accessToken);
      const { attendees, pagination } = response.data;

      attendees.forEach(a => fresh.set(String(a.id), normalizeAttendee(a)));

      hasMore = pagination?.has_more_items === true;
      continuation = pagination?.continuation;
    }

    entry.byId = fresh;
    entry.lastFullSync = Date.now();
    console.log(`[attendeeCache] full sync for event ${eventId}: ${fresh.size} attendees`);

    return listFor(eventId);
  })();

  try {
    return await entry.syncPromise;
  } finally {
    entry.syncPromise = null;
  }
}

async function upsertSingleAttendee(eventId, attendeeApiUrl, accessToken) {
  const response = await eventbrite.get(attendeeApiUrl, accessToken);
  const normalized = normalizeAttendee(response.data);

  const entry = getEntry(eventId);
  entry.byId.set(String(normalized.id), normalized);

  return normalized;
}

module.exports = {
  fullSync,
  upsertSingleAttendee,
  listFor,
  hasSynced,
  knownEventIds,
};
