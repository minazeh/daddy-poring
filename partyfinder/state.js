// ---------------------------------------------------------------------------
// Tracking of active party requests and carry requests.
// JS port of the reference party_state.py.
//
// The in-memory Maps below remain the authoritative store for the running
// process (v1 behavior, unchanged). v2 adds a Mongo WRITE-THROUGH: every
// mutation is mirrored fire-and-forget into partyfinder/db.js so open cards
// can be rehydrated after a restart (partyfinder/resume.js). If the DB is
// down/unconfigured, the mirror silently no-ops and the feature behaves
// exactly like v1 — in-memory only, lost on restart, never crashes.
// ---------------------------------------------------------------------------

const pfdb = require('./db');

let _idCounter = 0;

// id -> party object
const ACTIVE_PARTIES = new Map();
// id -> carry-request object
const ACTIVE_CARRY_REQUESTS = new Map();

function newId() {
  _idCounter += 1;
  return String(_idCounter);
}

// Restore the id high-water mark on boot (resume.js). The counter resets to 0
// on restart; without this, fresh ids would collide with ids persisted before
// the restart. Only ever raises the counter — never lowers it.
function restoreIdCounter(maxId) {
  const n = Number(maxId);
  if (Number.isFinite(n) && n > _idCounter) _idCounter = n;
}

// ---------------------------------------------------------------------------
// Fire-and-forget write-through. A user interaction must never fail because
// Atlas hiccuped — in-memory state stays authoritative for this process and
// the mirror catches up on the next mutation. db helpers no-op when not ready.
// ---------------------------------------------------------------------------
function persistParty(party) {
  pfdb.upsertParty(party).catch(err =>
    console.warn('[partyfinder/state] Party write-through failed (in-memory state unaffected):', err?.message || err));
}

function persistCarry(req) {
  pfdb.upsertCarry(req).catch(err =>
    console.warn('[partyfinder/state] Carry write-through failed (in-memory state unaffected):', err?.message || err));
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

/**
 * role_counts: object like { Tank: 1, Heal: 1, DPS: 3 } — required totals.
 * Leader is automatically slotted into their own category.
 */
function createParty({
  partyId,
  leaderId,
  leaderName,
  leaderCategory,
  eventName,
  partySize,
  roleCounts,
  serverTime,        // GMT+7 clock label, e.g. "4:30 PM" or "Wed 12:15 AM"
  startEpochSecs,    // chosen start instant, unix seconds (for <t:..:R> rendering)
  expiryEpochSecs,   // recruitment-close instant, unix seconds (live countdown)
  powerRating,
  messageId,
  channelId,
}) {
  const slots = { Tank: [], Heal: [], DPS: [] };
  slots[leaderCategory].push({ userId: leaderId, name: leaderName });

  const party = {
    id: partyId, // own id on the object so write-through helpers can key the doc
    leaderId,
    leaderName,
    eventName,
    partySize,
    roleCounts, // required totals per category
    slots, // filled members per category
    serverTime,
    startEpochSecs,
    expiryEpochSecs,
    powerRating,
    messageId,
    channelId,
    closed: false,
  };
  ACTIVE_PARTIES.set(partyId, party);
  persistParty(party);
  return party;
}

function getParty(partyId) {
  return ACTIVE_PARTIES.get(partyId) || null;
}

function totalFilled(party) {
  return Object.values(party.slots).reduce((sum, arr) => sum + arr.length, 0);
}

function isFull(party) {
  return totalFilled(party) >= party.partySize;
}

function categoryFull(party, category) {
  return party.slots[category].length >= (party.roleCounts[category] || 0);
}

function alreadyJoined(party, userId) {
  for (const members of Object.values(party.slots)) {
    if (members.some(m => m.userId === userId)) return true;
  }
  return false;
}

// Which category the user currently occupies, or null if not joined.
function currentCategory(party, userId) {
  for (const [category, members] of Object.entries(party.slots)) {
    if (members.some(m => m.userId === userId)) return category;
  }
  return null;
}

function addMember(party, category, userId, name) {
  party.slots[category].push({ userId, name });
  persistParty(party);
}

// Remove the user from the given category's slot array (no-op if absent).
function removeMember(party, category, userId) {
  party.slots[category] = party.slots[category].filter(m => m.userId !== userId);
  persistParty(party);
}

// Drop the party from memory AND delete its persisted doc (all close paths —
// cancel / full / expiry — land here, so the store never accumulates closed docs).
function removeParty(partyId) {
  ACTIVE_PARTIES.delete(partyId);
  pfdb.deleteParty(partyId).catch(err =>
    console.warn('[partyfinder/state] Party doc delete failed (in-memory state unaffected):', err?.message || err));
}

// Boot-time rehydration (resume.js) — seed the Map WITHOUT writing back to the
// DB (the doc is already the source we just read).
function restoreParty(partyId, party) {
  ACTIVE_PARTIES.set(partyId, party);
}

// ---------------------------------------------------------------------------
// Carry requests (simpler — no role slots, just event + time + responder list)
// ---------------------------------------------------------------------------

function createCarryRequest({
  requestId,
  leaderId,
  leaderName,
  eventName,
  serverTime,        // GMT+7 clock label, e.g. "4:30 PM" or "Wed 12:15 AM"
  startEpochSecs,    // chosen start instant, unix seconds (for <t:..:R> rendering)
  expiryEpochSecs,   // request-close instant, unix seconds (live countdown)
  messageId,
  channelId,
}) {
  const req = {
    id: requestId,
    leaderId,
    leaderName,
    eventName,
    serverTime,
    startEpochSecs,
    expiryEpochSecs,
    messageId,
    channelId,
    responders: [],
    closed: false,
  };
  ACTIVE_CARRY_REQUESTS.set(requestId, req);
  persistCarry(req);
  return req;
}

function getCarryRequest(requestId) {
  return ACTIVE_CARRY_REQUESTS.get(requestId) || null;
}

function addResponder(req, userId, name) {
  req.responders.push({ userId, name });
  persistCarry(req);
}

// Remove the user from the responder list (no-op if absent) — Withdraw button.
function removeResponder(req, userId) {
  req.responders = req.responders.filter(r => r.userId !== userId);
  persistCarry(req);
}

function hasResponded(req, userId) {
  return req.responders.some(r => r.userId === userId);
}

function removeCarryRequest(requestId) {
  ACTIVE_CARRY_REQUESTS.delete(requestId);
  pfdb.deleteCarry(requestId).catch(err =>
    console.warn('[partyfinder/state] Carry doc delete failed (in-memory state unaffected):', err?.message || err));
}

// Boot-time rehydration (resume.js) — no write-back.
function restoreCarryRequest(requestId, req) {
  ACTIVE_CARRY_REQUESTS.set(requestId, req);
}

// Test hook — wipe in-memory state to simulate a process restart. Touches the
// Maps and counter ONLY (never the DB). Never used at runtime.
function _resetForTests() {
  ACTIVE_PARTIES.clear();
  ACTIVE_CARRY_REQUESTS.clear();
  _idCounter = 0;
}

module.exports = {
  newId,
  restoreIdCounter,
  // parties
  createParty,
  getParty,
  totalFilled,
  isFull,
  categoryFull,
  alreadyJoined,
  currentCategory,
  addMember,
  removeMember,
  removeParty,
  restoreParty,
  // carries
  createCarryRequest,
  getCarryRequest,
  addResponder,
  removeResponder,
  hasResponded,
  removeCarryRequest,
  restoreCarryRequest,
  // exported for tests / simulation
  _resetForTests,
};
