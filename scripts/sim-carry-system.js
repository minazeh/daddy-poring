// ---------------------------------------------------------------------------
// Sim / verification for the Final Mirage carry-sales system.
//
// Runs the REAL carry/db.js, carry/state.js and carry/handlers.js against a
// fake in-memory Mongo (injected through db._setCollectionsForTests, the same
// hook partyfinder/db.js exposes) and a fake Discord client. No Atlas, no
// network, no token.
//
// It exists to PROVE the four things the spec says this feature must get right,
// rather than assert them in a comment:
//
//   A. THE CONDITIONAL TAKE (spec §4.1). Concurrent buyers on the last seat.
//      Run twice — once with the in-process fast path, once with it disabled —
//      because the in-process guard alone would pass a test that the design is
//      explicitly NOT allowed to rely on (Railway restarts; possibly >1 instance).
//   B. THE 30-MINUTE EXPIRY (spec §7.8) and its ordering against Mark Paid.
//   C. RESTART REHYDRATION (spec §10). Wipe every in-memory structure and show
//      the seat truth is unchanged and the timers come back from `pendingUntil`.
//   D. THE `delete`-WITH-PAID-BOOKINGS GUARD (spec §6.1).
//   E. THE RUNNER HANDOFF (spec §7 step 7). The bot stores no payment details;
//      the buyer's DM carries a CLICKABLE mention of the run's creator. Proven
//      end to end through handlers.route(), including the two ways it can have
//      nobody to point at — no createdBy, and a createdBy that won't resolve.
//
// Plus the two invariants that make it a LEDGER (spec §4.2): the booking count
// never decreases, and no booking document is ever removed.
//
// And one regression check for the retirement: /partyfinder must stop being
// registered while every other command keeps registering.
//
// Run: node scripts/sim-carry-system.js
// ---------------------------------------------------------------------------

const path = require('node:path');

// The modules under test. Loaded before anything sets MONGODB_URI so their
// module-level MongoClient is never constructed.
delete process.env.MONGODB_URI;

const db = require('../carry/db');
const cs = require('../carry/state');
const handlers = require('../carry/handlers');
const { TIERS, SEAT_STATUS, BOOKING_STATUS, RUN_STATUS } = require('../carry/constants');

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok  - ${msg}`);
  else { console.error(`  FAIL - ${msg}`); failures++; }
}
function section(title) { console.log(`\n[${title}]`); }

// ---------------------------------------------------------------------------
// Fake Mongo — enough of the query/update language for the real db.js to run
// unchanged, with DOCUMENT-LEVEL ATOMICITY modelled honestly: every op awaits
// first (so callers genuinely interleave), then does its read-modify-write in
// one synchronous block. That is the property the conditional take depends on.
// ---------------------------------------------------------------------------
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, (k, val) => val)));

function eq(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : a;
    const bt = b instanceof Date ? b.getTime() : b;
    return at === bt;
  }
  return a === b;
}
function cmp(a, b) {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av === undefined || av === null) return NaN;
  return av < bv ? -1 : av > bv ? 1 : 0;
}
function getPath(doc, p) {
  return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}
function setPath(doc, p, val) {
  const ks = String(p).split('.');
  let o = doc;
  for (let i = 0; i < ks.length - 1; i++) {
    if (o[ks[i]] == null) o[ks[i]] = {};
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = val;
}
function matchValue(actual, cond) {
  const isOperator = cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond);
  if (!isOperator) return eq(actual, cond);
  for (const [op, v] of Object.entries(cond)) {
    switch (op) {
      case '$in':  if (!v.some(x => eq(actual, x))) return false; break;
      case '$nin': if (v.some(x => eq(actual, x))) return false; break;
      case '$ne':  if (eq(actual, v)) return false; break;
      case '$gt':  if (!(cmp(actual, v) > 0)) return false; break;
      case '$gte': if (!(cmp(actual, v) >= 0)) return false; break;
      case '$lt':  if (!(cmp(actual, v) < 0)) return false; break;
      case '$lte': if (!(cmp(actual, v) <= 0)) return false; break;
      default: throw new Error(`fake-mongo: unsupported operator ${op}`);
    }
  }
  return true;
}
function matches(doc, query) {
  return Object.entries(query || {}).every(([k, v]) => matchValue(getPath(doc, k), v));
}
function applyUpdate(doc, update) {
  const before = JSON.stringify(doc);
  for (const [op, spec] of Object.entries(update)) {
    if (op === '$set') for (const [k, v] of Object.entries(spec)) setPath(doc, k, v);
    else if (op === '$inc') for (const [k, v] of Object.entries(spec)) setPath(doc, k, (getPath(doc, k) || 0) + v);
    else if (op === '$push') for (const [k, v] of Object.entries(spec)) {
      const arr = getPath(doc, k);
      if (Array.isArray(arr)) arr.push(v); else setPath(doc, k, [v]);
    } else throw new Error(`fake-mongo: unsupported update operator ${op}`);
  }
  return JSON.stringify(doc) !== before;
}

// A real await boundary, so concurrent callers actually interleave here.
const tick = () => new Promise(res => setTimeout(res, 0));

function makeCollection(name) {
  const docs = new Map();
  let deletes = 0; // must stay 0 for carry_bookings — the ledger never deletes.

  return {
    _name: name,
    _docs: docs,
    get _deletes() { return deletes; },

    async createIndex() { return name; },

    async insertOne(doc) {
      await tick();
      if (docs.has(doc._id)) throw new Error('duplicate key');
      docs.set(doc._id, doc);
      return { insertedId: doc._id };
    },

    async findOne(query) {
      await tick();
      for (const doc of docs.values()) if (matches(doc, query)) return doc;
      return null;
    },

    find(query) {
      let sortSpec = null;
      const self = {
        sort(spec) { sortSpec = spec; return self; },
        async toArray() {
          await tick();
          let out = [...docs.values()].filter(d => matches(d, query));
          if (sortSpec) {
            const [key, dir] = Object.entries(sortSpec)[0];
            out = out.sort((a, b) => (cmp(getPath(a, key), getPath(b, key)) || 0) * dir);
          }
          return out;
        },
      };
      return self;
    },

    async countDocuments(query) {
      await tick();
      return [...docs.values()].filter(d => matches(d, query)).length;
    },

    // --- the atomic bit -----------------------------------------------------
    async updateOne(filter, update) {
      await tick();
      // Everything below is SYNCHRONOUS: one document, one uninterrupted RMW.
      for (const doc of docs.values()) {
        if (!matches(doc, filter)) continue;
        const modified = applyUpdate(doc, update);
        return { matchedCount: 1, modifiedCount: modified ? 1 : 0 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },

    async updateMany(filter, update) {
      await tick();
      let matched = 0; let modified = 0;
      for (const doc of docs.values()) {
        if (!matches(doc, filter)) continue;
        matched++;
        if (applyUpdate(doc, update)) modified++;
      }
      return { matchedCount: matched, modifiedCount: modified };
    },

    async findOneAndUpdate(filter, update, opts = {}) {
      await tick();
      for (const doc of docs.values()) {
        if (!matches(doc, filter)) continue;
        applyUpdate(doc, update);
        return opts.returnDocument === 'after' ? doc : clone(doc);
      }
      if (opts.upsert) {
        const doc = { ...filter };
        applyUpdate(doc, update);
        docs.set(doc._id, doc);
        return doc;
      }
      return null;
    },

    async deleteOne(query) {
      await tick();
      for (const doc of docs.values()) {
        if (matches(doc, query)) { docs.delete(doc._id); deletes++; return { deletedCount: 1 }; }
      }
      return { deletedCount: 0 };
    },
  };
}

let runsCol; let bookingsCol; let countersCol;
function resetStore() {
  runsCol = makeCollection('carry_runs');
  bookingsCol = makeCollection('carry_bookings');
  countersCol = makeCollection('carry_counters');
  db._setCollectionsForTests(runsCol, bookingsCol, countersCol);
  cs._resetForTests();
}

// ---------------------------------------------------------------------------
// Fake Discord client — records DMs and board messages so the sim can assert on
// what a buyer/officer would actually have seen.
// ---------------------------------------------------------------------------
function makeClient() {
  const dms = [];
  const messages = new Map();
  let nextId = 1000;

  const channelFor = (id) => ({
    id,
    async send(payload) {
      const msg = {
        id: String(++nextId),
        channelId: id,
        payload,
        deleted: false,
        async edit(p) { this.payload = p; return this; },
        async delete() { this.deleted = true; messages.delete(this.id); },
      };
      messages.set(msg.id, msg);
      return msg;
    },
    messages: {
      async fetch(mid) {
        const m = messages.get(mid);
        if (!m || m.deleted) throw new Error('Unknown Message');
        return m;
      },
    },
  });

  return {
    dms,
    messages,
    channels: { async fetch(id) { return channelFor(id); } },
    users: {
      async fetch(id) {
        return { id, async send(text) { dms.push({ userId: id, text }); } };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const HOUR = 60 * 60 * 1000;

function member(roleIds = []) {
  return { roles: { cache: { has: (id) => roleIds.includes(id) } }, displayName: 'Someone' };
}

// A bare button interaction, for asserting a customId is NOT routed.
function btnLike(customId) {
  return {
    customId,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    async reply() {}, async update() {}, async deferUpdate() {}, async editReply() {},
  };
}

const PRIEST = '1518174089817227415';
const KNIGHT = '1518174089087422506';

// A real Discord snowflake for the runner, so the mention assertions are about
// what Discord would actually render as a clickable user link.
const RUNNER_ID = '1518076150692188201';

async function newRun(tierKey = 'SS', hoursAhead = 24, { createdBy = 'godfather' } = {}) {
  return db.createRun({
    tier: TIERS[tierKey],
    startAt: new Date(Date.now() + hoursAhead * HOUR),
    guildId: 'G1',
    createdBy,
  });
}

// A payment-method select click, shaped like the real interaction so it can go
// through handlers.route() rather than through a hand-called internal.
function paySelectInteraction(client, { userId, runId, seatIndex, method = 'gcash' }) {
  const shown = [];
  return {
    customId: `carry:pay:${runId}:${seatIndex}`,
    values: [method],
    user: { id: userId, username: userId },
    member: member([]),
    guildId: 'G1',
    client,
    shown,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    async deferUpdate() {},
    async update(payload) { shown.push(payload); },
    async editReply(payload) { shown.push(payload); },
    async reply(payload) { shown.push(payload); },
  };
}

// A run/timeslot select click. Carries the buyer's ROLES, so the "every class
// gets the same seat" claim can be driven through handlers.route() end to end
// rather than asserted against the pure resolver alone.
function runSelectInteraction({ userId, runId, tierKey = 'SS', roles = [] }) {
  const shown = [];
  const modals = [];
  return {
    customId: `carry:run:${tierKey}`,
    values: [runId],
    user: { id: userId, username: userId },
    member: member(roles),
    guildId: 'G1',
    shown,
    modals,
    deferred: false,
    replied: false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    async showModal(m) { modals.push(m.toJSON ? m.toJSON() : m); },
    async update(payload) { shown.push(payload); },
    async editReply(payload) { shown.push(payload); },
    async reply(payload) { shown.push(payload); },
  };
}

// A booking-modal submit, shaped like the real interaction so it can go through
// handlers.route() rather than through a hand-called internal.
//
// `fields` is the map of custom ids the SUBMITTED modal actually carried. A
// modal opened seconds before the 2026-09-02 deploy carries only the IGN, and
// discord.js does NOT return undefined for an absent id — ModalSubmitFields
// #getField THROWS a DiscordjsTypeError. That throw is the production failure
// this fixture exists to reproduce, so it is modelled exactly.
function bookingModalInteraction({ userId, runId, seatIndex, fields }) {
  const shown = [];
  return {
    customId: `carry:ign:${runId}:${seatIndex}`,
    user: { id: userId, username: userId },
    member: member([]),
    guildId: 'G1',
    shown,
    fields: {
      getTextInputValue(id) {
        if (!Object.prototype.hasOwnProperty.call(fields, id)) {
          const err = new TypeError(`[ModalSubmitInteractionFieldNotFound]: Field "${id}" not found.`);
          err.code = 'ModalSubmitInteractionFieldNotFound';
          throw err;
        }
        return fields[id];
      },
    },
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    async showModal() { throw new Error('Discord forbids answering a modal submit with another modal'); },
    async update(payload) { shown.push(payload); },
    async editReply(payload) { shown.push(payload); },
    async reply(payload) { shown.push(payload); },
    async deferUpdate() {},
  };
}

// Drive the REAL buyer flow from the MODAL SUBMIT through to a pending seat.
// Nothing is planted in the draft by hand here, so a value has to survive every
// hop — modal -> draft -> claimSeat -> seat doc + booking doc — on its own.
async function bookThroughModal(client, run, {
  userId, seatIndex = 0, ign = 'Tester', heardFrom = 'FB Group',
  method = 'gcash', omitHeardFrom = false,
} = {}) {
  const fields = { carry_ign: ign };
  if (!omitHeardFrom) fields.carry_heard_from = heardFrom;

  const mx = bookingModalInteraction({ userId, runId: run._id, seatIndex, fields });
  const modalRouted = await handlers.route(mx);
  const draft = cs.getDraft(userId, { runId: run._id, seatIndex });

  const px = paySelectInteraction(client, { userId, runId: run._id, seatIndex, method });
  const claimed = await handlers.route(px);

  return {
    modalRouted,
    modalReply: mx.shown.length ? mx.shown[mx.shown.length - 1] : null,
    draft: draft ? { ...draft } : null,
    claimed,
    payReply: px.shown.length ? px.shown[px.shown.length - 1] : null,
    dm: [...client.dms].reverse().find(d => d.userId === userId) || null,
  };
}

// Drive the real buyer flow from "IGN captured" to "seat pending + DM sent".
async function bookThroughPaySelect(client, run, { userId, seatIndex = 0, ign = 'Tester', method = 'gcash' }) {
  cs.setDraft(userId, { runId: run._id, seatIndex, tierKey: run.tier, ign });
  const interaction = paySelectInteraction(client, { userId, runId: run._id, seatIndex, method });
  const claimed = await handlers.route(interaction);
  const dm = [...client.dms].reverse().find(d => d.userId === userId) || null;
  const ephemeralText = interaction.shown.length ? interaction.shown[interaction.shown.length - 1].content : '';
  return { claimed, dm, ephemeralText };
}

async function buy(run, { userId, ign = 'Tester', seatIndex, method = 'gcash' }) {
  const fresh = await db.getRun(run._id);
  return cs.claimSeat({
    run: fresh,
    seatIndex,
    userId,
    username: userId,
    displayName: userId,
    ign,
    paymentMethod: method,
    guildId: 'G1',
  });
}

// ===========================================================================
async function main() {
  // -------------------------------------------------------------------------
  section('A. product shape — capacity follows from the tier, every seat open to all');
  // -------------------------------------------------------------------------
  const ssSeats = db.buildSeats(TIERS.SS);
  const sssSeats = db.buildSeats(TIERS.SSS);
  assert(ssSeats.length === 4, 'Guaranteed SS has 4 slots');
  assert(sssSeats.length === 3, 'Guaranteed SSS has 3 slots');
  assert(ssSeats.every(s => s.priestOnly === undefined), 'NO SS seat is class-gated any more');
  assert(sssSeats.every(s => s.priestOnly === undefined), 'NO SSS seat is class-gated any more');
  assert(TIERS.SS.priestSeatIndex === undefined && TIERS.SSS.priestSeatIndex === undefined,
    'the tiers no longer carry a priestSeatIndex');
  assert(cs.classProfile === undefined, 'the class-profile helper is gone from carry/state');
  assert(TIERS.SS.priceUsd === 5 && TIERS.SSS.priceUsd === 10, 'prices are $5 / $10');
  assert(ssSeats.every(s => s.status === SEAT_STATUS.OPEN), 'a new run starts wholly open');

  // -------------------------------------------------------------------------
  section('B. seat selection — EVERY SEAT IS OPEN TO EVERY CLASS');
  // -------------------------------------------------------------------------
  resetStore();
  {
    const run = await newRun('SS');
    const empty = await db.getRun(run._id);

    // selectSeat takes ONLY the run now — there is no member argument left to
    // pass, which is the strongest available form of "the buyer's class is
    // never consulted".
    assert(cs.selectSeat.length === 1, 'selectSeat takes one argument: the run');

    const first = cs.selectSeat(empty);
    assert(first.ok && first.seatIndex === 0, 'an empty run gives seat 1');
    assert(first.priestSeat === undefined && first.needsDeclaration === undefined,
      'no priestSeat / needsDeclaration flags survive on the result');

    // Fill the first three seats.
    for (let i = 0; i < 3; i++) {
      const r = await buy(run, { userId: `buyer${i}`, seatIndex: i });
      assert(r.ok, `seat ${i + 1} sold`);
    }
    const nearlyFull = await db.getRun(run._id);

    // THE CHANGE: the last seat — which used to be Priest-only — is now just a
    // seat. A Knight takes it, which the old code refused outright (old §11).
    const last = cs.selectSeat(nearlyFull);
    assert(last.ok && last.seatIndex === 3, 'the last seat is offered, not withheld');

    const r = await buy(run, { userId: 'knightbuyer', seatIndex: last.seatIndex });
    assert(r.ok, 'A KNIGHT TAKES THE SEAT THAT USED TO BE PRIEST-ONLY');
    assert(r.booking.priestSeat === undefined, 'the booking carries no priestSeat flag');
    assert(r.booking.declaredPriest === undefined && r.booking.priestRoleVerified === undefined,
      'no declaration fields are written to the ledger any more');

    const full = await db.getRun(run._id);
    assert(cs.selectSeat(full).reason === 'full', 'a full run reports full');

    // BACKWARD COMPATIBILITY — runs created BEFORE this change still carry
    // priestOnly:true on their last seat in Mongo. Nothing migrates them;
    // selectSeat simply ignores the field, and THAT is what makes the seat
    // sellable to anyone. If this assertion ever fails, every run that was
    // already open at deploy time silently keeps a locked seat.
    //
    // CLONE the seats before shaping them. The in-memory store hands back a
    // LIVE reference, so mutating what getRun returned edited the run itself
    // and quietly reopened a seat on a run a later assertion expects to be
    // full. (Real Mongo returns a fresh object; the fake does not. This was
    // caught by the "full run is filtered out" assertion going red, not by
    // reading the code.)
    const stored = await db.getRun(run._id);
    const legacy = { ...stored, seats: stored.seats.map(seat => ({ ...seat })) };
    legacy.seats[0].status = SEAT_STATUS.PAID;
    legacy.seats[1].status = SEAT_STATUS.PAID;
    legacy.seats[2].status = SEAT_STATUS.PAID;
    legacy.seats[3].status = SEAT_STATUS.OPEN;
    legacy.seats[3].priestOnly = true;   // the pre-change shape
    const onLegacy = cs.selectSeat(legacy);
    assert(onLegacy.ok && onLegacy.seatIndex === 3,
      'a LEGACY run with priestOnly:true still offers that seat — no migration needed');

    const untouched = await db.getRun(run._id);
    assert(untouched.seats.every(seat => seat.status !== SEAT_STATUS.OPEN),
      'shaping the legacy fixture did not mutate the stored run');


    const openForTier = await db.listOpenRunsForTier('SS');
    assert(openForTier.length === 0, 'a FULL RUN IS FILTERED OUT of the timeslot picker (§7.3)');

    // END TO END through the REAL router, not the resolver alone: a KNIGHT and
    // a PRIEST each pick a run whose ONLY open seat is the one that used to be
    // Priest-only. Both must be shown the IGN modal. Under the old code the
    // Knight got a refusal and the Priest got a different path, so this is the
    // assertion that would go red if any class check crept back in.
    for (const [who, roles] of [['knight', [KNIGHT]], ['priest', [PRIEST]], ['noclass', []]]) {
      const r2 = await newRun('SS');
      for (let i = 0; i < 3; i++) await buy(r2, { userId: `${who}-pre${i}`, seatIndex: i });

      const ix = runSelectInteraction({ userId: who, runId: r2._id, tierKey: 'SS', roles });
      const handled = await handlers.route(ix);
      assert(handled, `${who}: the run select is routed`);
      assert(ix.modals.length === 1, `${who} IS SHOWN THE IGN MODAL on the ex-Priest seat`);
      assert(ix.shown.length === 0, `${who}: no refusal and no declaration prompt is rendered`);

      const cid = ix.modals[0].custom_id;
      assert(cid.startsWith('carry:ign:'), `${who}: the modal is the IGN modal (${cid})`);
      // The run id itself contains a colon (carryrun:0002), so the NEW form is
      // five segments. The OLD form, with the declaration flag, was six.
      assert(cid.split(':').length === 5,
        `${who}: the IGN customId carries NO declaration segment (${cid})`);
      assert(cid.endsWith(':3'), `${who}: it targets seat 4, the ex-Priest seat (${cid})`);
    }

    // The declaration BUTTON is dead: its customId is in carry's own namespace,
    // so a stale one left in a channel must be ignored rather than crash.
    assert((await handlers.route(btnLike('carry:priest:carryrun:0001:3'))) === false,
      'a stale "I am a Priest" button is no longer routed by carry');

    // A modal opened seconds BEFORE this deploy carries the OLD five-segment
    // customId. Parsed by the new router it yields a runId that cannot exist,
    // so the buyer is told to start again — it can never land on a real run and
    // claim the wrong seat.
    {
      const parts = 'carry:ign:carryrun:0001:0:1'.split(':');
      const staleRunId = parts.slice(2, parts.length - 1).join(':');
      assert(staleRunId === 'carryrun:0001:0',
        `an old-form IGN customId parses to a bogus run id (${staleRunId})`);
      assert((await db.getRun(staleRunId)) == null,
        'and that bogus run id resolves to nothing, so no seat can be claimed by it');
    }
  }

  // -------------------------------------------------------------------------
  section('C. THE CONDITIONAL TAKE — two buyers, one seat (spec §4.1)');
  // -------------------------------------------------------------------------
  resetStore();
  {
    const run = await newRun('SSS');
    for (let i = 0; i < 2; i++) await buy(run, { userId: `early${i}`, seatIndex: i });

    // Both buyers resolve the SAME last seat and click at the same instant.
    const before = await db.getRun(run._id);
    const pick = cs.selectSeat(before);
    assert(pick.ok && pick.seatIndex === 2, 'both buyers resolve seat 3, the last one');

    const [a, b] = await Promise.all([
      buy(run, { userId: 'raceA', seatIndex: pick.seatIndex }),
      buy(run, { userId: 'raceB', seatIndex: pick.seatIndex }),
    ]);

    const winners = [a, b].filter(r => r.ok);
    assert(winners.length === 1, 'EXACTLY ONE buyer wins the last seat');
    assert([a, b].filter(r => !r.ok && r.reason === 'taken').length === 1,
      'the loser is told the seat was taken — not silently double-sold');

    const after = await db.getRun(run._id);
    assert(after.seats[2].status === SEAT_STATUS.PENDING, 'the seat is held exactly once');
    assert(after.seats[2].bookingId === winners[0].booking._id, 'the seat names the winner\'s booking');

    // The two guards reject at DIFFERENT points, and that shows up in the
    // ledger. The in-process fast path rejects BEFORE anything is written, so a
    // buyer it turns away leaves no record — nothing happened to them. The
    // conditional take rejects AFTER the booking row exists (the row is written
    // first, so a crash mid-purchase leaves something recoverable rather than a
    // seat held by nothing), so THAT loser is on the ledger as `released`.
    // C2 below exercises the second path.
    const all = await db.listBookingsForRun(run._id);
    assert(all.length === 3,
      'the fast-path loser is turned away before any record is written — 3 bookings, not 4');
    assert(all.every(x => x.status === BOOKING_STATUS.PENDING),
      'and every record that does exist is a real hold');
    assert(bookingsCol._deletes === 0, 'nothing was deleted to achieve that');
  }

  // -------------------------------------------------------------------------
  section('C2. the same race WITHOUT the in-process guard — the DB must still win');
  // -------------------------------------------------------------------------
  resetStore();
  {
    // Disable the in-process fast path so the ONLY thing standing between two
    // buyers and a double-sold seat is the conditional update. This is the case
    // a Railway restart or a second instance actually produces, and it is the
    // reason the design is not allowed to lean on the Map the way /partyfinder
    // does. If the conditional take were removed, this test fails and the
    // previous one still passes — which is exactly why it is here.
    const inFlight = cs._inFlight;
    const origHas = inFlight.has;
    // Faithful disable: make `has` report false for THIS set only, so the fast
    // path never fires and the conditional update is the sole guard left.
    inFlight.has = () => false;

    const run = await newRun('SS');
    for (let i = 0; i < 3; i++) await buy(run, { userId: `pre${i}`, seatIndex: i });

    const results = await Promise.all(
      ['x1', 'x2', 'x3', 'x4'].map(u =>
        buy(run, { userId: u, seatIndex: 3 })),
    );
    const ok = results.filter(r => r.ok);
    assert(ok.length === 1, 'FOUR simultaneous buyers, in-process guard OFF — still exactly one winner');
    assert(results.filter(r => !r.ok && r.reason === 'taken').length === 3, 'the other three are told it was taken');

    const after = await db.getRun(run._id);
    assert(after.seats.filter(s => s.status !== SEAT_STATUS.OPEN).length === 4, 'the run holds exactly 4 seats — no overselling');
    const bookings = await db.listBookingsForRun(run._id);
    assert(bookings.length === 7, 'all seven attempts are on the ledger (3 early + 4 racers)');
    assert(bookings.filter(b => b.status === BOOKING_STATUS.RELEASED).length === 3, 'the three losers are `released`, not deleted');

    inFlight.has = origHas;
  }

  // -------------------------------------------------------------------------
  section('C3. an OVERSUBSCRIBED run — 9 buyers, 4 seats, all at once');
  // -------------------------------------------------------------------------
  resetStore();
  {
    const run = await newRun('SS');
    // Every buyer independently resolves a seat off the same starting state,
    // which is the worst case: several of them target the SAME index.
    const start = await db.getRun(run._id);
    const picks = [];
    for (let i = 0; i < 9; i++) {
      picks.push(cs.selectSeat(start).seatIndex);
    }
    assert(picks.every(p => p === 0), 'all nine resolve seat 1 off the same stale snapshot — the worst case');

    const results = await Promise.all(picks.map((seatIndex, i) =>
      buy(run, { userId: `mob${i}`, seatIndex })));
    const winners = results.filter(r => r.ok).length;
    assert(winners === 1, 'only ONE of nine buyers targeting the same seat wins it');

    const after = await db.getRun(run._id);
    const held = after.seats.filter(s => s.status !== SEAT_STATUS.OPEN);
    assert(held.length === 1, 'exactly one seat is held');
    assert(new Set(held.map(s => s.bookingId)).size === held.length, 'no seat holds two bookings');
    assert(bookingsCol._deletes === 0, 'NOT ONE booking document was deleted');
  }

  // -------------------------------------------------------------------------
  section('D. the 30-minute expiry (spec §7.8)');
  // -------------------------------------------------------------------------
  resetStore();
  {
    const client = makeClient();
    const run = await newRun('SS');
    const r = await buy(run, { userId: 'lapsed', seatIndex: 0 });
    assert(r.ok, 'buyer takes a seat');

    const held = await db.getRun(run._id);
    assert(held.seats[0].status === SEAT_STATUS.PENDING, 'the seat goes PENDING, not paid');
    const holdMs = new Date(r.booking.pendingUntil).getTime() - new Date(r.booking.createdAt).getTime();
    assert(Math.abs(holdMs - 30 * 60 * 1000) < 1500, `the hold is 30 minutes (got ${Math.round(holdMs / 60000)} min)`);

    // Wind the deadline into the past — same shape as a hold that lapsed.
    await bookingsCol.updateOne({ _id: r.booking._id }, { $set: { pendingUntil: new Date(Date.now() - 1000) } });

    const released = await handlers.releaseHold(client, r.booking._id);
    assert(released === true, 'the expiry fires and releases the hold');

    const afterRun = await db.getRun(run._id);
    assert(afterRun.seats[0].status === SEAT_STATUS.OPEN, 'the SEAT IS OPEN AGAIN and can be resold');
    assert(afterRun.seats[0].userId === null && afterRun.seats[0].ign === null, 'the seat carries no leftover buyer data');

    const booking = await db.getBooking(r.booking._id);
    assert(booking !== null, 'the booking still EXISTS after release (ledger, §4.2)');
    assert(booking.status === BOOKING_STATUS.RELEASED, 'its status is `released`');
    assert(booking.history.map(h => h.status).join('->') === 'pending->released',
      'the status history records how it got there');
    assert(booking.ign === 'Tester' && booking.paymentMethod === 'gcash',
      'buyer identity, IGN and chosen payment method are all retained');
    assert(client.dms.some(d => d.userId === 'lapsed' && /released/i.test(d.text)), 'the buyer is DM\'d that the slot lapsed');

    // Idempotence: the timer firing twice (or a duplicate re-arm after a
    // restart) must be a harmless no-op.
    const again = await handlers.releaseHold(client, r.booking._id);
    assert(again === false, 'a second release attempt is a no-op, not a double transition');
    const stillOne = (await db.getBooking(r.booking._id)).history.length;
    assert(stillOne === 2, 'the history is not appended to twice');

    // Resale of the released seat must work.
    const resold = await buy(run, { userId: 'nextbuyer', seatIndex: 0 });
    assert(resold.ok, 'the released seat sells again');
  }

  // -------------------------------------------------------------------------
  section('E. Mark Paid vs the expiry — ordering (spec §11)');
  // -------------------------------------------------------------------------
  resetStore();
  {
    const client = makeClient();
    const run = await newRun('SS');

    // E1: paid first, then a late timer fires. The timer must NOT evict them.
    const paid = await buy(run, { userId: 'payer', seatIndex: 0 });
    assert(await db.confirmSeatPaid(run._id, 0, paid.booking._id), 'officer confirms the seat');
    assert(await db.markBookingPaid(paid.booking._id, 'officer1'), 'the booking goes pending -> paid');

    const lateFire = await handlers.releaseHold(client, paid.booking._id);
    assert(lateFire === false, 'a LATE expiry timer on a PAID booking does nothing');
    const afterLate = await db.getRun(run._id);
    assert(afterLate.seats[0].status === SEAT_STATUS.PAID, 'the paid buyer keeps their seat');

    // E2: released first, then an officer clicks Mark Paid. Must be refused.
    const lapsed = await buy(run, { userId: 'slowpoke', seatIndex: 1 });
    await bookingsCol.updateOne({ _id: lapsed.booking._id }, { $set: { pendingUntil: new Date(Date.now() - 1000) } });
    await handlers.releaseHold(client, lapsed.booking._id);

    const seatClaimed = await db.confirmSeatPaid(run._id, 1, lapsed.booking._id);
    assert(seatClaimed === false, 'Mark Paid AFTER auto-release cannot re-take the seat');
    const bookingPaid = await db.markBookingPaid(lapsed.booking._id, 'officer1');
    assert(bookingPaid === false, 'and cannot move the booking out of `released`');

    // E3: the released seat is resold, THEN the stale Mark Paid arrives.
    const resold = await buy(run, { userId: 'freshbuyer', seatIndex: 1 });
    assert(resold.ok, 'somebody else buys the released seat');
    const stale = await db.confirmSeatPaid(run._id, 1, lapsed.booking._id);
    assert(stale === false, 'THE STALE CLICK CANNOT OVERWRITE THE NEW OCCUPANT — this is the refund case');
    const seat1 = (await db.getRun(run._id)).seats[1];
    assert(seat1.bookingId === resold.booking._id, 'the seat still belongs to the new buyer');

    // E4: two officers click Mark Paid at the same instant.
    const both = await Promise.all([
      db.markBookingPaid(resold.booking._id, 'officerA'),
      db.markBookingPaid(resold.booking._id, 'officerB'),
    ]);
    assert(both.filter(Boolean).length === 1, 'two officers clicking Mark Paid at once — only one transition lands');
  }

  // -------------------------------------------------------------------------
  section('F. RESTART REHYDRATION (spec §10)');
  // -------------------------------------------------------------------------
  resetStore();
  {
    const client = makeClient();
    const run = await newRun('SS');

    const live = await buy(run, { userId: 'liveHold', seatIndex: 0 });
    const dead = await buy(run, { userId: 'deadHold', seatIndex: 1 });
    const sold = await buy(run, { userId: 'soldSeat', seatIndex: 2 });
    await db.confirmSeatPaid(run._id, 2, sold.booking._id);
    await db.markBookingPaid(sold.booking._id, 'officer1');

    cs.armRelease(live.booking._id, live.booking.pendingUntil, () => {});
    cs.armRelease(dead.booking._id, dead.booking.pendingUntil, () => {});
    assert(cs.armedReleaseCount() === 2, 'two release timers armed before the restart');

    // deadHold's window elapses while the bot is down.
    await bookingsCol.updateOne({ _id: dead.booking._id }, { $set: { pendingUntil: new Date(Date.now() - 60_000) } });

    const seatsBefore = (await db.getRun(run._id)).seats.map(s => `${s.status}:${s.bookingId}`).join('|');

    // ---- THE RESTART: every in-memory structure is destroyed. ----
    cs._resetForTests();
    assert(cs.armedReleaseCount() === 0, 'the restart wipes every timer (setTimeout does not survive a deploy)');
    assert(cs.getDraft('anyone') === null, 'and every half-finished purchase draft');

    const seatsAfter = (await db.getRun(run._id)).seats.map(s => `${s.status}:${s.bookingId}`).join('|');
    assert(seatsBefore === seatsAfter,
      'SEAT TRUTH IS UNCHANGED BY THE RESTART — this is what Mongo-authoritative buys (§4.1)');

    // ---- resume() ----
    const resume = require('../carry/resume');
    await resume.resume(client);

    const liveAfter = await db.getBooking(live.booking._id);
    const deadAfter = await db.getBooking(dead.booking._id);
    const soldAfter = await db.getBooking(sold.booking._id);
    assert(liveAfter.status === BOOKING_STATUS.PENDING, 'the hold that had time left survives the restart');
    assert(deadAfter.status === BOOKING_STATUS.RELEASED,
      'THE HOLD THAT EXPIRED WHILE THE BOT WAS DOWN IS RELEASED ON BOOT, not left hanging (§10)');
    assert(soldAfter.status === BOOKING_STATUS.PAID, 'the confirmed sale is untouched');

    const runAfter = await db.getRun(run._id);
    assert(runAfter.seats[1].status === SEAT_STATUS.OPEN, 'and its seat is back on sale');
    assert(runAfter.seats[0].status === SEAT_STATUS.PENDING && runAfter.seats[2].status === SEAT_STATUS.PAID,
      'the other two seats are exactly as they were');
    assert(cs.armedReleaseCount() === 1, 'exactly one timer is re-armed — for the hold that is still live');
    assert(runAfter.boardMessageId !== null, 'the run board message id is persisted, so edits survive the restart');

    // A board message deleted by hand while the bot was down (spec §11).
    const oldBoardId = runAfter.boardMessageId;
    client.messages.delete(oldBoardId);
    await handlers.renderRunBoard(client, run._id);
    const healed = await db.getRun(run._id);
    assert(healed.boardMessageId !== oldBoardId, 'a board message deleted by hand is RE-POSTED');
    assert(client.messages.has(healed.boardMessageId), 'and its new id is re-persisted');
  }

  // -------------------------------------------------------------------------
  section('G. /carryrun delete vs the ledger (spec §6.1)');
  // -------------------------------------------------------------------------
  resetStore();
  {
    const client = makeClient();
    const run = await newRun('SS');
    await handlers.renderRunBoard(client, run._id);

    const paidA = await buy(run, { userId: 'paidA', seatIndex: 0 });
    const paidB = await buy(run, { userId: 'paidB', seatIndex: 1 });
    const holding = await buy(run, { userId: 'holding', seatIndex: 2 });
    for (const b of [paidA, paidB]) {
      await db.confirmSeatPaid(run._id, b.booking.seatIndex, b.booking._id);
      await db.markBookingPaid(b.booking._id, 'officer1');
    }

    const ledgerBefore = bookingsCol._docs.size;
    const runDoc = await db.getRun(run._id);

    const refused = await handlers.deleteRunAndBoard(client, runDoc, 'godfather');
    assert(refused.ok === false, 'delete is REFUSED while paid bookings survive');
    assert(refused.paidCount === 2, `and says how many — got ${refused.paidCount}`);
    assert((await db.getRun(run._id)).status === RUN_STATUS.OPEN, 'the run is untouched by the refusal');
    assert(bookingsCol._docs.size === ledgerBefore, 'and nothing was removed from the ledger');
    assert(client.messages.has(runDoc.boardMessageId), 'the board message is still up');

    // Clear them the deliberate way — the per-booking Cancel action.
    for (const b of [paidA, paidB]) {
      assert(await db.markBookingCancelled(b.booking._id, 'officer1', 'refunded'), `booking ${b.booking._id} cancelled`);
      await db.vacateSeat(run._id, b.booking.seatIndex, b.booking._id);
    }
    const cancelled = await db.getBooking(paidA.booking._id);
    assert(cancelled.status === BOOKING_STATUS.CANCELLED, 'Cancel is a status transition');
    assert(cancelled.history.map(h => h.status).join('->') === 'pending->paid->cancelled',
      'the full path is on the record — pending -> paid -> cancelled');
    assert(cancelled.cancelReason === 'refunded' && cancelled.cancelledBy === 'officer1', 'with who did it and why');

    const runNow = await db.getRun(run._id);
    const ok = await handlers.deleteRunAndBoard(client, runNow, 'godfather');
    assert(ok.ok === true, 'with no paid bookings left, delete proceeds');
    assert(ok.released === 1, 'the one remaining unpaid hold is dropped');

    const deletedRun = await db.getRun(run._id);
    assert(deletedRun.status === RUN_STATUS.DELETED, 'the run is tombstoned, not dropped — the ledger points at it');
    assert(!client.messages.has(runNow.boardMessageId), 'its board message is removed from Discord');
    assert((await db.listLiveRuns()).length === 0, 'and it no longer appears anywhere live');

    const held = await db.getBooking(holding.booking._id);
    assert(held.status === BOOKING_STATUS.RUN_DELETED, 'the live hold is marked `run_deleted`');
    assert(client.dms.some(d => d.userId === 'holding' && /removed/i.test(d.text)), 'and that buyer is told the run went away');

    const stillCancelled = await db.getBooking(paidA.booking._id);
    assert(stillCancelled.status === BOOKING_STATUS.CANCELLED,
      'a booking that already ENDED as cancelled keeps that truth — run deletion does not rewrite how it ended');
    assert(stillCancelled.runDeletedAt !== null, 'but it is still stamped with the run deletion');

    assert(bookingsCol._docs.size === ledgerBefore, 'THE LEDGER NEVER SHRANK — no booking was deleted at any point');
    assert(bookingsCol._deletes === 0, 'deleteOne was never called on carry_bookings');
  }

  // -------------------------------------------------------------------------
  section('H. the bot holds NO payment details — anywhere (spec §2)');
  // -------------------------------------------------------------------------
  {
    const constants = require('../carry/constants');
    const { PAYMENT_METHODS } = constants;

    assert(constants.paymentDetailsFor === undefined,
      'paymentDetailsFor() is gone — there is no code path that reads account details');
    assert(Object.values(PAYMENT_METHODS).every(m => m.env === undefined),
      'no payment method names an environment variable any more');
    assert(Object.values(PAYMENT_METHODS).every(m => Object.keys(m).sort().join(',') === 'emoji,key,label'),
      'a payment method is a LABEL ONLY — key, label, emoji and nothing else');
    assert(Object.keys(PAYMENT_METHODS).sort().join(',') === 'bank,gcash,paypal,wise',
      'the four methods are still offered — the select survives, only the stored details went');

    // Repo-wide sweep. The needle is built from two halves so this file's own
    // assertion text is not itself a hit.
    const fs = require('node:fs');
    const NEEDLE = 'CARRY_PAY' + '_';
    const root = path.join(__dirname, '..');
    const SKIP = new Set(['node_modules', '.git', '.railwayignore']);
    const scanned = [];
    const offenders = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(js|json|md|example|env|yml|yaml|txt)$/i.test(entry.name) && entry.name !== '.env') continue;
        scanned.push(full);
        let src;
        try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
        if (src.includes(NEEDLE)) offenders.push(path.relative(root, full));
      }
    })(root);
    assert(scanned.length > 50, `the sweep actually read the repo — ${scanned.length} files scanned`);
    assert(offenders.length === 0,
      `no ${NEEDLE} reference survives anywhere in the repo${offenders.length ? ` — found in ${offenders.join(', ')}` : ''}`);

    // Discord ids are 17-20 digit snowflakes and legitimately live in the
    // source; strip those first so this check is about ACCOUNT numbers rather
    // than role and channel ids.
    const files = ['carry/constants.js', 'carry/db.js', 'carry/state.js', 'carry/handlers.js', 'carry/resume.js',
      'commands/carrypanel.js', 'commands/carryrun.js'];
    const stripSnowflakes = (src) => src.replace(/\b\d{17,20}\b/g, 'SNOWFLAKE');
    const suspicious = /(?:\d[ -]?){11,}|paypal\.me\/|@paypal|iban\s*[:=]|\bsort\s*code\b|\baccount\s*(?:no|number)\s*[:=]/i;
    const hits = files.filter(f => suspicious.test(stripSnowflakes(fs.readFileSync(path.join(root, f), 'utf8'))));
    assert(hits.length === 0, `no account-number-shaped literal in any carry source file${hits.length ? ` (found in ${hits.join(', ')})` : ''}`);
  }

  // -------------------------------------------------------------------------
  section('H2. the buyer is told to DM THE RUNNER, clickably (spec §7 step 7)');
  // -------------------------------------------------------------------------
  {
    resetStore();
    const client = makeClient();
    const run = await newRun('SS', 24, { createdBy: RUNNER_ID });

    const { claimed, dm, ephemeralText } = await bookThroughPaySelect(client, run, { userId: 'buyer1', ign: 'Kupo' });
    assert(claimed === true, 'the pay-select click is routed by carry.route()');

    const after = await db.getRun(run._id);
    assert(after.seats[0].status === SEAT_STATUS.PENDING, 'the seat goes PENDING off the real flow, not a hand-called internal');
    const booking = await db.getBooking(after.seats[0].bookingId);
    assert(booking.paymentMethod === 'gcash', 'the chosen payment method is recorded on the booking');

    assert(dm !== null, 'the buyer is DM\'d');
    assert(dm.text.includes(`<@${RUNNER_ID}>`), 'the DM names the runner as a REAL <@id> mention — tappable straight into a DM');
    assert(/<@\d{17,20}>/.test(dm.text), 'and it is snowflake-shaped, so Discord renders it as a user link rather than literal text');
    assert(!/<@(null|undefined|)>/.test(dm.text), 'no broken mention anywhere in it');
    assert(/DM <@\d{17,20}> to arrange payment/.test(dm.text), 'the instruction is explicit: DM the runner to arrange payment');

    assert(!/send payment to/i.test(dm.text), 'the old "Send payment to: <details>" block is GONE');
    assert(!/\bgcash\b[^\n]*\d{4,}/i.test(dm.text), 'and no account-number-shaped string took its place');

    assert(dm.text.includes(booking._id), 'the booking id is still in the DM');
    assert(/include your booking id/i.test(dm.text), 'with the "include your booking id" line kept');
    assert(dm.text.includes('$5'), 'the price is still there');
    assert(dm.text.includes(handlers.runLabel(after)), 'the run label is still there');
    assert(/held for \*\*30 minutes\*\*/.test(dm.text), 'and the 30-minute hold countdown');
    assert(dm.text.includes('GCash'), 'the method the buyer picked is named, so the runner knows what is coming');

    assert(ephemeralText.includes(`<@${RUNNER_ID}>`), 'the ephemeral confirmation also points at the runner');
    assert(!/details aren't configured/i.test(ephemeralText), 'and no longer talks about unconfigured details');
  }

  // -------------------------------------------------------------------------
  section('H3. no runner to point at — the fallback (never <@null>)');
  // -------------------------------------------------------------------------
  {
    // (a) the run was created without a creator at all.
    resetStore();
    const client = makeClient();
    const run = await newRun('SS', 24, { createdBy: null });
    assert((await db.getRun(run._id)).createdBy === null, 'a run can legitimately have no createdBy');

    const { dm, ephemeralText } = await bookThroughPaySelect(client, run, { userId: 'buyer2' });
    assert(dm !== null, 'the buyer is still DM\'d — the booking is not blocked by a missing runner');
    assert(!dm.text.includes('<@'), 'the DM contains NO mention at all — nothing broken is rendered');
    assert(!/\bnull\b|\bundefined\b/i.test(dm.text), 'and no stray "null" / "undefined" leaked into the copy');
    assert(/officer will follow up/i.test(dm.text), 'the buyer is told an officer will follow up');
    assert(/held for \*\*30 minutes\*\*/.test(dm.text), 'and the hold countdown');
    assert(/no runner on record/i.test(ephemeralText), 'the ephemeral confirmation says so too, rather than pointing at nobody');

    const held = await db.getRun(run._id);
    const fallbackBooking = await db.getBooking(held.seats[0].bookingId);
    assert(dm.text.includes(fallbackBooking._id), 'the booking id is kept in the fallback DM too');
    assert(dm.text.includes('$5') && dm.text.includes('GCash'), 'along with the price and the chosen method');
    assert(held.seats[0].status === SEAT_STATUS.PENDING, 'THE SEAT IS STILL HELD — a missing runner is a copy problem, not a sales failure');

    // (b) createdBy is set but the user no longer resolves (left the server).
    resetStore();
    const base = makeClient();
    const GHOST = '1518076150692188209';
    const ghostClient = {
      ...base,
      users: {
        async fetch(id) {
          if (id === GHOST) throw new Error('Unknown User');
          return { id, async send(text) { base.dms.push({ userId: id, text }); } };
        },
      },
    };
    const run2 = await newRun('SS', 24, { createdBy: GHOST });
    const res2 = await bookThroughPaySelect(ghostClient, run2, { userId: 'buyer3' });
    assert(res2.dm !== null, 'the buyer whose runner has vanished is still DM\'d');
    assert(!res2.dm.text.includes('<@'), 'an UNRESOLVABLE runner also renders no mention — the id alone is not trusted');
    assert(!res2.dm.text.includes(GHOST), 'the dead id is not pasted in as raw text either');
    assert(/officer will follow up/i.test(res2.dm.text), 'they get the officer fallback');
    assert(handlers.runnerMention({ createdBy: null }) === null, 'runnerMention() returns null, not a string, when there is nobody');
    assert(await handlers.resolveRunnerMention(ghostClient, { _id: 'x', createdBy: GHOST }) === null,
      'resolveRunnerMention() returns null when the fetch throws');
    assert(await handlers.resolveRunnerMention(base, { _id: 'x', createdBy: RUNNER_ID }) === `<@${RUNNER_ID}>`,
      'and a mention when it resolves');
  }

  // -------------------------------------------------------------------------
  section('H4. both boards surface the runner (spec §8)');
  // -------------------------------------------------------------------------
  {
    resetStore();
    const client = makeClient();
    const run = await newRun('SS', 24, { createdBy: RUNNER_ID });
    await bookThroughPaySelect(client, run, { userId: 'buyer4', method: 'paypal' });
    const fresh = await db.getRun(run._id);
    const booking = await db.getBooking(fresh.seats[0].bookingId);

    const publicFields = handlers.buildRunEmbed(fresh).toJSON().fields;
    const runnerField = publicFields.find(f => f.value.includes(`<@${RUNNER_ID}>`));
    assert(runnerField !== undefined, 'THE PUBLIC BOARD names the runner — a buyer sees who they will pay BEFORE booking');
    assert(/runner/i.test(runnerField.name), `and the field says so (got "${runnerField.name}")`);

    const pendingFields = handlers.buildBookingEmbed(booking, fresh).toJSON().fields;
    const pendingRunner = pendingFields.find(f => f.value.includes(`<@${RUNNER_ID}>`) && /runner/i.test(f.name));
    assert(pendingRunner !== undefined, 'THE PENDING BOARD names the runner — the confirming officer sees whose DMs the money went to');
    const methodField = pendingFields.find(f => f.name === 'Payment');
    assert(methodField && methodField.value.includes('PayPal'), 'and the method the buyer chose is on it, for the runner\'s benefit');

    // Null creator: neither board may render a broken mention.
    const orphan = await newRun('SSS', 24, { createdBy: null });
    await bookThroughPaySelect(client, orphan, { userId: 'buyer5' });
    const orphanRun = await db.getRun(orphan._id);
    const orphanBooking = await db.getBooking(orphanRun.seats[0].bookingId);

    const orphanPublic = handlers.buildRunEmbed(orphanRun).toJSON();
    const publicBlob = JSON.stringify(orphanPublic);
    assert(!publicBlob.includes('<@'), 'with no creator the public board renders NO mention');
    assert(!/<@(null|undefined)>/.test(publicBlob) && !/null|undefined/.test(orphanPublic.fields.map(f => f.value).join(' ')),
      'and no "null"/"undefined" text anywhere in its fields');
    const orphanRunnerField = orphanPublic.fields.find(f => /runner/i.test(f.name));
    assert(orphanRunnerField !== undefined && orphanRunnerField.value.trim().length > 0,
      'the Runner field is still present and non-empty — it explains itself instead of going blank');

    const orphanPending = handlers.buildBookingEmbed(orphanBooking, orphanRun).toJSON();
    const orphanPendingRunner = orphanPending.fields.find(f => /runner/i.test(f.name));
    assert(orphanPendingRunner !== undefined && !orphanPendingRunner.value.includes('<@'),
      'the pending board flags the missing runner to the officer rather than showing a dead mention');
    assert(/none|no runner/i.test(orphanPendingRunner.value), `and says so plainly (got "${orphanPendingRunner.value}")`);
  }

  // -------------------------------------------------------------------------
  section('I. GMT+7 date handling');
  // -------------------------------------------------------------------------
  {
    const d = handlers.parseGmt7('2026-08-30', '20:00');
    assert(d instanceof Date, '2026-08-30 20:00 parses');
    assert(d.toISOString() === '2026-08-30T13:00:00.000Z', 'GMT+7 20:00 is 13:00 UTC');
    assert(handlers.formatGmt7(d) === 'Sun 30 Aug 2026, 8:00 PM', `renders back as GMT+7 wall clock (got "${handlers.formatGmt7(d)}")`);
    assert(handlers.parseGmt7('2026-02-31', '20:00') === null, '2026-02-31 is rejected, not rolled over into March');
    assert(handlers.parseGmt7('2026-13-01', '20:00') === null, 'month 13 is rejected');
    assert(handlers.parseGmt7('2026-08-30', '24:00') === null, '24:00 is rejected');
    assert(handlers.parseGmt7('30-08-2026', '20:00') === null, 'DD-MM-YYYY is rejected rather than misread');
    const midnight = handlers.parseGmt7('2026-01-01', '00:15');
    assert(handlers.formatGmt7(midnight) === 'Thu 1 Jan 2026, 12:15 AM', 'past-midnight times render as 12:15 AM, not 0:15');
  }

  // -------------------------------------------------------------------------
  section('J. customId round-trip — run ids contain a colon');
  // -------------------------------------------------------------------------
  {
    // carryrun:0007 has its own ':', so every parser in handlers.route reads
    // from the END. A naive split()[2] would hand back "carryrun" and every
    // button on the pending board would silently 404.
    const runId = db.runIdFor(7);
    assert(runId === 'carryrun:0007', 'run ids are zero-padded and namespaced');

    const payId = `carry:pay:${runId}:3`;
    const parts = payId.split(':');
    assert(parts.slice(2, parts.length - 1).join(':') === runId, 'the pay-select customId round-trips the run id');
    assert(Number(parts[parts.length - 1]) === 3, 'and the seat index');

    // The IGN customId lost its trailing declaration flag when the Priest seat
    // was removed, so it is now parsed exactly like the pay-select one.
    const ignId = `carry:ign:${runId}:3`;
    const ip = ignId.split(':');
    assert(ip.slice(2, ip.length - 1).join(':') === runId, 'the IGN modal customId round-trips the run id');
    assert(Number(ip[ip.length - 1]) === 3, 'and the seat index');
    assert(ip.length === 5, 'the IGN customId is five segments — no declaration flag');
    assert(ignId.length <= 100, `every customId fits Discord's 100-char cap (longest is ${ignId.length})`);

    const bookingId = db.bookingIdFor(42);
    assert(`carry:paid:${bookingId}`.slice('carry:paid:'.length) === bookingId, 'officer button customIds round-trip the booking id');
  }

  // -------------------------------------------------------------------------
  section('K. command registration after retiring /partyfinder');
  // -------------------------------------------------------------------------
  {
    const fs = require('node:fs');
    const { Collection, REST } = require('discord.js');
    const { registerCommands } = require('../lib/registerCommands');

    const commands = new Collection();
    const dir = path.join(__dirname, '..', 'commands');
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const cmd = require(path.join(dir, file));
      if ('data' in cmd && 'execute' in cmd) commands.set(cmd.data.name, cmd);
    }

    // Intercept the REST call — nothing leaves the machine.
    let sent = null;
    const origPut = REST.prototype.put;
    REST.prototype.put = async function put(route, opts) { sent = opts.body; return sent; };
    const origEnv = { ...process.env };
    process.env.DISCORD_TOKEN = 'x'; process.env.CLIENT_ID = 'x'; process.env.GUILD_ID = 'x';
    await registerCommands(commands);
    REST.prototype.put = origPut;
    process.env.DISCORD_TOKEN = origEnv.DISCORD_TOKEN ?? '';
    process.env.CLIENT_ID = origEnv.CLIENT_ID ?? '';
    process.env.GUILD_ID = origEnv.GUILD_ID ?? '';

    const names = sent.map(c => c.name).sort();
    assert(commands.has('partyfinder'), '/partyfinder is STILL LOADED — the file was not deleted');
    assert(!names.includes('partyfinder'), 'but it is NO LONGER REGISTERED with Discord');
    assert(names.includes('carrypanel') && names.includes('carryrun'), '/carrypanel and /carryrun are registered');

    // The baseline this build started from: 29 registered commands including
    // partyfinder. Expected now: 29 - 1 + 2 = 30, with every other name intact.
    const BASELINE = ['activitycampaign', 'card', 'guildapplication', 'guildexpedition', 'guildroster',
      'guildsupport', 'gvgschedule', 'gvgvc', 'help', 'item', 'jobad', 'kudosboard', 'map', 'memberclasses',
      'monster', 'partyfinder', 'pet', 'petition', 'ping', 'polarityraid', 'profile', 'qna', 'refine',
      'roquiz', 'rune', 'shop', 'siege', 'skill', 'syncmembers'];
    const lost = BASELINE.filter(n => n !== 'partyfinder' && !names.includes(n));
    assert(lost.length === 0, `every other command still registers (${BASELINE.length - 1} of them)${lost.length ? ` — MISSING ${lost.join(', ')}` : ''}`);
    // The invariant this section actually cares about is that the retirement
    // removes EXACTLY ONE command and nothing else — expressed against the
    // loaded set rather than a literal, so an unrelated new command does not
    // turn this into a false failure. (It did once: /stickymessage was added
    // 2026-08-24 and the old `=== 30` literal went red for no real reason.)
    assert(names.length === commands.size - 1,
      `retiring /partyfinder removes exactly one command: ${commands.size} loaded, ${names.length} registered`);

    const carryrun = commands.get('carryrun').data.toJSON();
    assert(carryrun.options.map(o => o.name).sort().join(',') === 'close,create,delete,edit,list',
      '/carryrun exposes create / delete / close / edit (+ list)');
  }

  // -------------------------------------------------------------------------
  section('L. router isolation — inserting a router into interactionCreate is the risk');
  // -------------------------------------------------------------------------
  {
    // events/interactionCreate.js chains routers and stops at the first one
    // that returns true. A router that over-claims silently kills another
    // feature's buttons, and a router that under-claims kills its own. Both
    // directions are checked here against the REAL route() functions.
    const partyfinder = require('../partyfinder/handlers');
    const ticket = require('../ticket/handlers');
    const petition = require('../petition/handlers');

    const btn = (customId) => ({
      customId,
      isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
      async reply() { throw new Error(`route() ACTED on a foreign customId: ${customId}`); },
      async update() { throw new Error(`route() ACTED on a foreign customId: ${customId}`); },
      async showModal() { throw new Error(`route() ACTED on a foreign customId: ${customId}`); },
      async deferUpdate() { throw new Error(`route() ACTED on a foreign customId: ${customId}`); },
    });
    const sel = (customId) => ({ ...btn(customId), isButton: () => false, isStringSelectMenu: () => true, values: ['x'] });
    const mod = (customId) => ({ ...btn(customId), isButton: () => false, isModalSubmit: () => true });

    // Carry must not claim anybody else's ids.
    const foreign = ['ticket:open', 'ticket:accept:ticket:0001', 'partyfinder:start', 'pf:join:DPS:3',
      'pf:carryrespond:4', 'guildapp:start', 'quiz:answer:A', 'petition:sign', 'monsterquiz:join',
      'activitycampaign:yes', 'gvgrsvp:yes:k', 'jobapply:1'];
    let overclaimed = [];
    for (const id of foreign) {
      for (const mk of [btn, sel, mod]) {
        if (await handlers.route(mk(id))) overclaimed.push(id);
      }
    }
    assert(overclaimed.length === 0, `carry.route() claims NONE of the ${foreign.length} foreign customIds${overclaimed.length ? ` — over-claimed ${[...new Set(overclaimed)].join(', ')}` : ''}`);

    // And nobody else may claim carry's — partyfinder runs right after it and
    // has the widest customId surface in the bot.
    const mine = [`carry:pick`, `carry:tier`, `carry:run:SS`, `carry:pay:carryrun:0001:0`,
      `carry:ign:carryrun:0001:0`,
      `carry:paid:carrybooking:000001`, `carry:release:carrybooking:000001`, `carry:cancel:carrybooking:000001`];
    let stolen = [];
    for (const id of mine) {
      for (const mk of [btn, sel, mod]) {
        if (await partyfinder.route(mk(id))) stolen.push(`partyfinder:${id}`);
        if (await ticket.route(mk(id))) stolen.push(`ticket:${id}`);
        if (await petition.route(mk(id))) stolen.push(`petition:${id}`);
      }
    }
    assert(stolen.length === 0, `no other router claims a carry: customId${stolen.length ? ` — ${stolen.join(', ')}` : ''}`);

    // The retired module must still answer its own already-posted cards.
    let pfStillRoutes = false;
    try { await partyfinder.route(btn('pf:join:DPS:999')); } catch (e) { pfStillRoutes = /ACTED/.test(e.message); }
    assert(pfStillRoutes, 'retired /partyfinder still routes its own buttons — cards posted before the retirement keep working');
  }

  // -------------------------------------------------------------------------
  section('M. the booking modal asks WHERE THE BUYER HEARD ABOUT US (2026-09-02)');
  // -------------------------------------------------------------------------
  resetStore();
  {
    // ---- the modal payload, read as Discord will actually receive it -------
    const run = await newRun('SS');
    const ix = runSelectInteraction({ userId: 'shopper', runId: run._id, tierKey: 'SS' });
    assert(await handlers.route(ix), 'picking a timeslot opens the booking modal');
    const modal = ix.modals[0];

    assert(modal.title === 'Your booking details',
      `the title covers BOTH fields now, not just the IGN (got "${modal.title}")`);
    assert(modal.components.length === 2,
      `the modal carries EXACTLY TWO inputs (got ${modal.components.length})`);
    assert(modal.components.every(row => row.components.length === 1),
      'one input per action row, as Discord requires');

    const [ignInput, heardInput] = modal.components.map(row => row.components[0]);
    assert(ignInput.custom_id === 'carry_ign', 'the FIRST input is the IGN');
    assert(heardInput.custom_id === 'carry_heard_from',
      'the SECOND is the heard-from field — it sits BELOW the IGN, alongside it on one form');
    assert(ignInput.label === 'In-game name (IGN)', 'the IGN label is untouched');

    // Conrad's question is 75 characters and a Discord modal label caps at 45,
    // so it is split — question in the label, his follow-up in the placeholder.
    // Neither half is paraphrased, which is what these two assert.
    assert(heardInput.label === 'Where did you hear about our service?',
      `the label is the question verbatim (got "${heardInput.label}")`);
    assert(heardInput.placeholder === 'If YouTube, specify from which video.',
      `and his follow-up is the placeholder verbatim (got "${heardInput.placeholder}")`);
    assert('Where did you hear about our service? If YouTube, specify from which video.'.length > 45,
      'the unsplit question would NOT have fitted a label — the split is forced, not stylistic');
    assert(heardInput.label.length <= 45, `the label fits the 45-char cap (${heardInput.label.length})`);
    assert(heardInput.placeholder.length <= 100, `the placeholder fits the 100-char cap (${heardInput.placeholder.length})`);
    assert(heardInput.style === 1, 'it is a Short input, not a paragraph');
    assert(heardInput.max_length === 100, `capped at 100 characters (got ${heardInput.max_length})`);
    assert(heardInput.required === true, 'and it is REQUIRED');

    assert(db.buildSeats(TIERS.SS).every(s => s.heardFrom === null),
      'a new run starts with heardFrom null on every seat');
  }

  // ---- a normal submit carries the answer the whole way down --------------
  resetStore();
  {
    const client = makeClient();
    const run = await newRun('SS', 24, { createdBy: RUNNER_ID });
    const r = await bookThroughModal(client, run, { userId: 'buyerA', ign: 'Aria', heardFrom: 'YouTube' });

    assert(r.modalRouted, 'the modal submit is routed');
    assert(r.draft && r.draft.heardFrom === 'YouTube', 'the answer lands on the in-memory draft');

    const fresh = await db.getRun(run._id);
    const seat = fresh.seats[0];
    assert(seat.status === SEAT_STATUS.PENDING, 'the seat goes pending through the real router');
    assert(seat.heardFrom === 'YouTube', 'the answer is on the SEAT doc after the conditional take');

    const booking = await db.getBooking(seat.bookingId);
    assert(booking.heardFrom === 'YouTube', 'and on the BOOKING ledger doc');
    assert(booking.ign === 'Aria', 'the IGN still lands too — the new field did not displace it');

    // ---- the officer board, rendered ------------------------------------
    const embed = handlers.buildBookingEmbed(booking, fresh).toJSON();
    const fields = embed.fields;
    const hf = fields.find(f => /heard/i.test(f.name));
    assert(hf !== undefined, 'THE OFFICER PENDING BOARD shows the heard-from value');
    assert(hf.value === 'YouTube', `and shows it verbatim (got "${hf.value}")`);
    const ignIdx = fields.findIndex(f => f.name === 'IGN');
    assert(fields.indexOf(hf) === ignIdx + 1, 'it sits IMMEDIATELY BESIDE the IGN');
    assert(hf.inline === true && fields[ignIdx].inline === true,
      'both inline, so Discord renders them on one row with the buyer');
    assert(hf.value.length <= 1024, `the field is inside the 1024-char cap (${hf.value.length})`);
    assert(JSON.stringify(embed).length < 6000, `and the embed is nowhere near the 6000-char cap (${JSON.stringify(embed).length})`);

    // ---- and it is OFFICER-ONLY -----------------------------------------
    const publicBlob = JSON.stringify(handlers.buildRunEmbed(fresh).toJSON());
    assert(!publicBlob.includes('YouTube'),
      'THE PUBLIC BOARD does NOT carry it — the buyer beside them never reads how they found us');
    assert(!/heard/i.test(publicBlob), 'the public board has no heard-from field at all');
    assert(r.dm && !/YouTube/i.test(r.dm.text), 'and it is in nothing the BUYER receives');

    // ---- a buyer-supplied value cannot ping the channel ------------------
    const pingy = { ...booking, heardFrom: '@everyone told me' };
    const pingyValue = handlers.buildBookingEmbed(pingy, fresh).toJSON().fields.find(f => /heard/i.test(f.name)).value;
    assert(!/(^|[^​])@everyone/.test(pingyValue),
      `an @everyone in the answer is defused before it reaches the officer board (got "${pingyValue}")`);

    // ---- a value at the input cap survives intact ------------------------
    const long = 'F'.repeat(100);
    const longValue = handlers.buildBookingEmbed({ ...booking, heardFrom: long }, fresh).toJSON().fields.find(f => /heard/i.test(f.name)).value;
    assert(longValue === long, 'a 100-character answer renders in full, not truncated');

    // ---- the release path clears the seat, not the ledger ----------------
    await bookingsCol.updateOne({ _id: booking._id }, { $set: { pendingUntil: new Date(Date.now() - 1000) } });
    assert(await handlers.releaseHold(client, booking._id) === true, 'the hold lapses and releases');
    const afterRun = await db.getRun(run._id);
    assert(afterRun.seats[0].heardFrom === null, 'THE RELEASE PATH nulls heardFrom on the seat, exactly as it nulls the IGN');
    assert(afterRun.seats[0].ign === null, 'alongside the IGN itself');
    assert((await db.getBooking(booking._id)).heardFrom === 'YouTube',
      'but the BOOKING keeps it — the ledger is append-only in spirit (§4.2)');
  }

  // ---- whitespace only: refused the way an empty IGN is -------------------
  resetStore();
  {
    const client = makeClient();
    const run = await newRun('SS');
    const ws = await bookThroughModal(client, run, { userId: 'buyerB', heardFrom: '   ' });

    assert(ws.modalRouted, 'a whitespace-only answer is routed, not crashed on');
    assert(/where you heard/i.test(ws.modalReply?.content || ''),
      `the buyer is asked again, exactly as an empty IGN asks again (got "${ws.modalReply?.content || ''}")`);
    assert(ws.draft === null, 'no draft is opened by a blank answer');
    const stillOpen = await db.getRun(run._id);
    assert(stillOpen.seats[0].status === SEAT_STATUS.OPEN, 'and NO SEAT IS TAKEN');
    assert((await db.listBookingsForRun(run._id)).length === 0, 'nothing reaches the ledger either');
  }

  // ---- DEPLOY SAFETY: a modal opened BEFORE this field shipped ------------
  resetStore();
  {
    // The real production case: a buyer opens the form seconds before the
    // deploy and submits it seconds after. That submission has NO heard-from
    // input, and discord.js THROWS on a read of an absent custom id. An escaped
    // throw would take out the handler and cost a paying buyer their place.
    const client = makeClient();
    const run = await newRun('SS', 24, { createdBy: RUNNER_ID });

    let legacy = null;
    let crash = null;
    try {
      legacy = await bookThroughModal(client, run, { userId: 'buyerC', ign: 'Legacy', omitHeardFrom: true });
    } catch (err) { crash = err; }

    assert(crash === null, `route() SURVIVES a submit with only the IGN on it${crash ? ` — it threw: ${crash.message}` : ''}`);
    assert(legacy && legacy.modalRouted === true, 'the stale submit is routed normally');
    assert(legacy?.draft && legacy.draft.heardFrom === null, 'the absent answer becomes an explicit null on the draft');

    const fresh = await db.getRun(run._id);
    assert(fresh.seats[0].status === SEAT_STATUS.PENDING,
      'THE SALE STILL GOES THROUGH — the buyer does not lose their seat over our deploy timing');
    assert(fresh.seats[0].heardFrom === null, 'the seat records null rather than being left undefined');
    // Guarded reads: if the safe accessor regresses, this block must report
    // FAILURES rather than crash the harness and hide the checks below it.
    const booking = (await db.getBooking(fresh.seats[0].bookingId)) || {};
    assert(booking.heardFrom === null, 'and so does the booking');
    assert(booking.ign === 'Legacy', 'the IGN they DID give is recorded');
    assert(legacy?.dm != null, 'and they still get their payment DM');

    // NEGATIVE CONTROL. Prove the assertions above have teeth: the unguarded
    // read — getTextInputValue() straight, the way the IGN is read — genuinely
    // throws on this exact payload. If handleBookingModal went back to it, the
    // block above goes red instead of silently passing.
    const stale = bookingModalInteraction({
      userId: 'ctrl', runId: run._id, seatIndex: 1, fields: { carry_ign: 'Legacy' },
    });
    let naiveThrew = false;
    try { stale.fields.getTextInputValue('carry_heard_from'); } catch { naiveThrew = true; }
    assert(naiveThrew,
      'NEGATIVE CONTROL: an unguarded read of the absent field DOES throw — the safe accessor is load-bearing');
    assert(stale.fields.getTextInputValue('carry_ign') === 'Legacy',
      'while the field that IS present still reads back normally');

    // ---- how a legacy row renders to an officer --------------------------
    const legacyRow = { ...booking };
    delete legacyRow.heardFrom;   // a booking written before the field existed
    const legacyValue = handlers.buildBookingEmbed(legacyRow, fresh).toJSON().fields.find(f => /heard/i.test(f.name)).value;
    assert(legacyValue.trim().length > 0, 'a legacy booking does NOT render a blank cell');
    assert(/not recorded/i.test(legacyValue), `it says "not recorded" (got "${legacyValue}")`);
    assert(!/null|undefined/i.test(legacyValue), 'and never the literal text "null" or "undefined"');

    // NEGATIVE CONTROL for that render: the failure mode is real, not theoretical.
    assert(String(legacyRow.heardFrom) === 'undefined',
      'NEGATIVE CONTROL: naively stringifying the absent field yields "undefined" — precisely what the assertion above rules out');

    // A null (a submit that crossed the deploy) must read the same to an officer.
    const nullValue = handlers.buildBookingEmbed(booking, fresh).toJSON().fields.find(f => /heard/i.test(f.name)).value;
    assert(nullValue === legacyValue,
      'a null answer and an absent one look identical to an officer — one message, not two mysteries');
  }

  // -------------------------------------------------------------------------
  console.log('\n---- summary ----');
  if (failures === 0) console.log('ALL PASS');
  else console.error(`${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('SIM CRASHED:', err); process.exit(1); });
