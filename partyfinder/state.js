// ---------------------------------------------------------------------------
// In-memory tracking of active party requests and carry requests.
// JS port of the reference party_state.py.
//
// Parties/carries are short-lived (recruitment closes ~15 min before start), so we don't
// need a database — Maps keyed by an incrementing id are sufficient and avoid
// extra deployment complexity. In-memory only is intentional (v1): state is
// lost on restart — accepted tradeoff, same as the source.
// ---------------------------------------------------------------------------

let _idCounter = 0;

// id -> party object
const ACTIVE_PARTIES = new Map();
// id -> carry-request object
const ACTIVE_CARRY_REQUESTS = new Map();

function newId() {
  _idCounter += 1;
  return String(_idCounter);
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
}

// Remove the user from the given category's slot array (no-op if absent).
function removeMember(party, category, userId) {
  party.slots[category] = party.slots[category].filter(m => m.userId !== userId);
}

function removeParty(partyId) {
  ACTIVE_PARTIES.delete(partyId);
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
  return req;
}

function getCarryRequest(requestId) {
  return ACTIVE_CARRY_REQUESTS.get(requestId) || null;
}

function addResponder(req, userId, name) {
  req.responders.push({ userId, name });
}

function hasResponded(req, userId) {
  return req.responders.some(r => r.userId === userId);
}

function removeCarryRequest(requestId) {
  ACTIVE_CARRY_REQUESTS.delete(requestId);
}

module.exports = {
  newId,
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
  // carries
  createCarryRequest,
  getCarryRequest,
  addResponder,
  hasResponded,
  removeCarryRequest,
};
