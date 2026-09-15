// eventbriteClient.js
//
// A thin wrapper around axios for every call we make to the Eventbrite API.
// It exists to stop bursts of webhook traffic (e.g. a rush of people
// checking in at once) from firing a pile of simultaneous Eventbrite
// requests and tripping their rate limit:
//   - outbound calls are queued through a small concurrency cap + minimum
//     gap between request starts, instead of firing however many arrive
//   - a 429 (or 5xx) is retried with backoff, honoring Eventbrite's
//     `Retry-After` header when present instead of guessing
//
// Every place in this app that talks to eventbriteapi.com should go through
// `get()` here rather than calling axios directly, so the throttling and
// retry behavior is applied consistently.

const axios = require('axios');

const MAX_CONCURRENT = 3;
const MIN_GAP_MS = 150; // floor between request starts (~6-7 req/sec ceiling)
const MAX_RETRIES = 5;

let inFlight = 0;
let lastStart = 0;
const queue = [];

function pump() {
  if (inFlight >= MAX_CONCURRENT || queue.length === 0) return;

  const wait = Math.max(0, lastStart + MIN_GAP_MS - Date.now());

  setTimeout(() => {
    const item = queue.shift();
    if (!item) return;

    lastStart = Date.now();
    inFlight++;

    item
      .task()
      .then(item.resolve, item.reject)
      .finally(() => {
        inFlight--;
        pump();
      });

    pump(); // let another slot start filling immediately if capacity allows
  }, wait);
}

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

async function requestWithRetry(config) {
  let attempt = 0;

  for (;;) {
    try {
      return await schedule(() => axios(config));
    } catch (err) {
      const status = err.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);

      if (!retryable || attempt >= MAX_RETRIES) throw err;

      const retryAfterHeader = err.response?.headers?.['retry-after'];
      const delayMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : Math.min(30000, 500 * 2 ** attempt) + Math.random() * 250;

      console.warn(
        `[eventbriteClient] ${config.url} -> ${status}, retrying in ${Math.round(
          delayMs
        )}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
      );

      await new Promise(r => setTimeout(r, delayMs));
      attempt++;
    }
  }
}

function get(url, accessToken) {
  return requestWithRetry({
    method: 'get',
    url,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

module.exports = { get };
