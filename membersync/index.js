// ---------------------------------------------------------------------------
// membersync bootstrap — called from events/ready.js.
//
// Exposes:
//   initAndStart(client)   — init DB schema, run an immediate sync, then set
//                            up the hourly timer. Never throws; all errors logged.
//
// Callers import { initSchema, isReady } from ./db and { syncMembers } from
// ./sync directly when they need fine-grained access (e.g. the /syncmembers
// command imports syncMembers from ./sync directly).
// ---------------------------------------------------------------------------

const db = require('./db');
const { syncMembers } = require('./sync');

const HOUR_MS = 60 * 60 * 1000; // 1 hour in milliseconds

async function initAndStart(client) {
  // Step 1: connect + ensure indexes.
  let ok;
  try {
    ok = await db.initSchema();
  } catch (err) {
    console.warn('[membersync] initSchema threw unexpectedly — member sync disabled:', err?.message || err);
    return;
  }

  if (!ok) {
    // initSchema already logged the reason (no URI / Atlas unreachable).
    return;
  }

  // Step 2: immediate sync on boot (fire-and-forget — don't block ready.js).
  syncMembers(client).catch(err =>
    console.warn('[membersync] Initial sync failed:', err?.message || err)
  );

  // Step 3: hourly timer. setInterval is unref()d so it doesn't prevent a
  // clean process exit in test/dev scenarios.
  const timer = setInterval(() => {
    syncMembers(client).catch(err =>
      console.warn('[membersync] Hourly sync failed:', err?.message || err)
    );
  }, HOUR_MS);

  // Allow the process to exit cleanly (e.g. in scripts/tests) without waiting
  // for the next interval tick.
  if (timer.unref) timer.unref();

  console.log('[membersync] Hourly sync timer started (interval: 1 h).');
}

module.exports = { initAndStart, db, syncMembers };
