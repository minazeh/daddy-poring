// ---------------------------------------------------------------------------
// Offline simulation for the POLARITY party read filter (roster/db.js).
//
// THE BUG THIS GUARDS. The web app cut the normal polarity raids from 8 parties
// to 5 on 2026-09-20 and HID the surplus documents instead of deleting them —
// `polarityParties` still holds 42 rows per guild, 12 of which (normal
// positions 5-7) are no longer on the board. daddy's hidden rows are empty, so
// render.js's `!isEmptyParty(p)` filter masked the problem; MUMMY's hold 25
// members, so an unfiltered read would render those 25 TWICE: once in their
// real party and once in a phantom party the website says does not exist.
// /profile reads the same getter and would have named the phantom party.
//
// No Discord connection, no Atlas. The `mongodb` module is stubbed at the
// require level, so this exercises the REAL roster/db.js getters — the query
// they build is recorded and then applied to in-memory documents shaped exactly
// like the collection. A copy of the filter would prove nothing.
//
//   node scripts/sim-polarity-db-filter.js
// ---------------------------------------------------------------------------

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks += 1; };
const eq = (a, b, label) => { assert.strictEqual(a, b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); checks += 1; };
const deep = (a, b, label) => { assert.deepStrictEqual(a, b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); checks += 1; };

const section = t => console.log(`\n── ${t}`);
const pass = t => console.log(`   ✓ ${t}`);

// ---------------------------------------------------------------------------
// Fixtures — the collection as production actually stores it: 42 polarity party
// rows per guild. Normal raids keep their positions 5-7 from the 8-party era.
// Mummy's hidden rows carry members; daddy's are empty.
// ---------------------------------------------------------------------------

const LEGACY_NORMAL_PARTY_COUNT = 8; // what the rows were written at
const VISIBLE_PARTY_COUNT = 5;       // what the web app shows now

function polarityPartyDocs(guild) {
  const out = [];
  const raids = [
    { kind: 'main', count: 2, parties: 5 },
    { kind: 'normal', count: 4, parties: LEGACY_NORMAL_PARTY_COUNT },
  ];
  for (const spec of raids) {
    for (let index = 0; index < spec.count; index++) {
      const raidId = `${guild}-polarity-${spec.kind}-${index}`;
      for (let position = 0; position < spec.parties; position++) {
        const hidden = spec.kind === 'normal' && position >= VISIBLE_PARTY_COUNT;
        // Mummy is the guild that still has people stranded in hidden rows.
        const memberIds = hidden
          ? (guild === 'mummy' ? [`${raidId}-stranded-${position}`] : [])
          : [`${raidId}-m${position}`];
        out.push({
          partyId: `${raidId}-p${position}`,
          type: guild,
          raidId,
          kind: spec.kind,
          name: `Party ${position + 1}`,
          memberIds,
          position,
          lockedSlots: [],
          updatedAt: new Date(),
        });
      }
    }
  }
  return out;
}

const SIEGE_RAID_KEYS = ['alpha', 'bravo', 'charlie', 'delta'];

function siegePartyDocs(guild) {
  const out = [];
  for (const raidKey of SIEGE_RAID_KEYS) {
    const raidId = `${guild}-siege-${raidKey}`;
    for (let position = 0; position < 8; position++) {
      out.push({
        partyId: `${raidId}-p${position}`,
        type: guild,
        raidId,
        raidKey,
        name: `Party ${position + 1}`,
        memberIds: [`${raidId}-m${position}`],
        position,
        lockedSlots: [],
        updatedAt: new Date(),
      });
    }
  }
  return out;
}

const COLLECTIONS = {
  polarityParties: [...polarityPartyDocs('daddy'), ...polarityPartyDocs('mummy')],
  siegeParties: [...siegePartyDocs('daddy'), ...siegePartyDocs('mummy')],
};

// ---------------------------------------------------------------------------
// A minimal Mongo stand-in. Supports only what roster/db.js's read functions
// use: equality match, `$lt` on a number (type-bracketed, exactly as Mongo
// brackets it — a missing or non-numeric field does NOT match), sort, toArray.
// Every query it is handed is recorded so the assertions can inspect the filter
// the real code built.
// ---------------------------------------------------------------------------

const queryLog = [];

function matchesClause(value, clause) {
  if (clause !== null && typeof clause === 'object' && !Array.isArray(clause)) {
    for (const [op, operand] of Object.entries(clause)) {
      if (op === '$lt') {
        // Mongo brackets comparisons by BSON type: $lt: <number> never matches
        // a missing field or a non-numeric one.
        if (typeof value !== 'number') return false;
        if (!(value < operand)) return false;
      } else {
        throw new Error(`stub does not implement operator ${op}`);
      }
    }
    return true;
  }
  return value === clause;
}

function makeCursor(docs) {
  let out = docs.slice();
  const cursor = {
    sort(spec) {
      const keys = Object.entries(spec);
      out.sort((a, b) => {
        for (const [key, dir] of keys) {
          const av = a[key];
          const bv = b[key];
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
        }
        return 0;
      });
      return cursor;
    },
    async toArray() {
      return out;
    },
  };
  return cursor;
}

function makeCollection(name) {
  return {
    find(query) {
      queryLog.push({ collection: name, query });
      const docs = (COLLECTIONS[name] || []).filter(doc =>
        Object.entries(query).every(([field, clause]) => matchesClause(doc[field], clause)),
      );
      return makeCursor(docs);
    },
    async findOne(query) {
      queryLog.push({ collection: name, query, one: true });
      return (COLLECTIONS[name] || []).find(doc =>
        Object.entries(query).every(([field, clause]) => matchesClause(doc[field], clause)),
      ) || null;
    },
  };
}

class FakeMongoClient {
  constructor() { this.closed = false; }
  async connect() { return this; }
  db() { return { collection: makeCollection }; }
  async close() { this.closed = true; }
}

// Stub `mongodb` BEFORE roster/db.js is required, then load the real module.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mongodb') return { MongoClient: FakeMongoClient };
  return origLoad.call(this, request, ...rest);
};
process.env.MONGODB_URI = 'mongodb://sim.invalid/discordbot';
const rosterDb = require('../roster/db.js');
Module._load = origLoad;

// ---------------------------------------------------------------------------

(async () => {
  console.log('\n============================================================');
  console.log('POLARITY PARTY READ FILTER — offline simulation');
  console.log('============================================================');

  section('0. the stub connects and the real getters are live');
  eq(await rosterDb.initSchema(), true, 'initSchema() succeeds against the stub');
  ok(rosterDb.isReady(), 'isReady() is true');
  eq(typeof rosterDb.getPolarityParties, 'function', 'getPolarityParties is exported');
  pass('roster/db.js is running against the in-memory collection');

  section('1. the stored collection really does hold the hidden rows');
  eq(COLLECTIONS.polarityParties.filter(p => p.type === 'daddy').length, 42, 'daddy stores 42 polarity party rows');
  eq(COLLECTIONS.polarityParties.filter(p => p.type === 'mummy').length, 42, 'mummy stores 42 polarity party rows');
  const storedHidden = COLLECTIONS.polarityParties.filter(p => p.kind === 'normal' && p.position >= VISIBLE_PARTY_COUNT);
  eq(storedHidden.length, 24, '24 hidden rows across both guilds (12 each)');
  const strandedTotal = storedHidden
    .filter(p => p.type === 'mummy')
    .reduce((s, p) => s + p.memberIds.length, 0);
  ok(strandedTotal > 0, 'mummy has members stranded in hidden rows — the case that breaks');
  eq(
    storedHidden.filter(p => p.type === 'daddy').reduce((s, p) => s + p.memberIds.length, 0),
    0,
    'daddy has none — which is why only mummy would have shown the fault',
  );
  pass(`the fixture mirrors production: 42 rows/guild, ${strandedTotal} stranded in mummy`);

  section('2. getPolarityParties returns ONLY the visible positions');
  for (const guild of ['daddy', 'mummy']) {
    const rows = await rosterDb.getPolarityParties(guild);
    eq(rows.length, 30, `${guild}: 30 parties returned, not 42`);
    ok(rows.every(p => p.position < VISIBLE_PARTY_COUNT), `${guild}: no row at position ${VISIBLE_PARTY_COUNT}+`);
    ok(rows.every(p => p.type === guild), `${guild}: guild scoping still holds`);
    deep(
      rows.filter(p => /-p[5-9]$/.test(p.partyId)).map(p => p.partyId),
      [],
      `${guild}: no hidden partyId comes back`,
    );
  }
  pass('the 12 hidden rows per guild are filtered out at the read');

  section('3. the stranded members are no longer double-listed');
  const mummyRows = await rosterDb.getPolarityParties('mummy');
  const seated = mummyRows.flatMap(p => p.memberIds);
  eq(new Set(seated).size, seated.length, 'no member id appears twice in the returned board');
  const strandedIds = storedHidden
    .filter(p => p.type === 'mummy')
    .flatMap(p => p.memberIds);
  deep(
    strandedIds.filter(id => seated.includes(id)),
    [],
    'no phantom-party member reaches the renderer',
  );
  pass(`${strandedIds.length} stranded mummy members dropped from the read, none duplicated`);

  section('4. ordering is unchanged — raid then slot position');
  const ordered = mummyRows.map(p => `${p.raidId}|${p.position}`);
  deep(ordered, ordered.slice().sort(), 'still sorted by raidId then position');
  pass('sort order survives the filter');

  section('5. SIEGE is untouched — 8 parties per raid, no bound applied');
  for (const guild of ['daddy', 'mummy']) {
    const rows = await rosterDb.getSiegeParties(guild);
    eq(rows.length, 32, `${guild}: all 32 siege parties returned`);
    ok(rows.some(p => p.position >= VISIBLE_PARTY_COUNT), `${guild}: siege positions 5-7 still come back`);
  }
  const siegeQueries = queryLog.filter(q => q.collection === 'siegeParties');
  ok(
    siegeQueries.every(q => !('position' in q.query)),
    'no position filter is ever applied to siegeParties',
  );
  pass('the siege read is byte-for-byte the same query it always was');

  section('6. the query itself, not just its result');
  const polarityQueries = queryLog.filter(q => q.collection === 'polarityParties');
  ok(polarityQueries.length > 0, 'the polarity read was actually exercised');
  ok(
    polarityQueries.every(q => q.query.position && q.query.position.$lt === VISIBLE_PARTY_COUNT),
    `every polarityParties read carries position: { $lt: ${VISIBLE_PARTY_COUNT} }`,
  );
  pass('the bound is in the query, so Atlas does the filtering');

  section('7. the constant is documented and points at the web app');
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'roster', 'db.js'), 'utf8');
  ok(/const POLARITY_VISIBLE_PARTY_COUNT = \d+;/.test(dbSrc), 'the bound is a named constant, not a literal');
  ok(
    dbSrc.includes('projects/daddy-poring-web/src/lib/polarity.ts'),
    'the comment names the web app file as the source of truth',
  );
  ok(/lockstep/i.test(dbSrc), 'the comment states the two repos must move in lockstep');
  pass('a future change to POLARITY_NORMAL_PARTY_COUNT has a signpost here');

  section('8. still read-only — nothing writes polarityParties');
  const writeOps = /\.(insert|update|delete|replace|bulkWrite|findOneAnd|drop)/.exec(dbSrc);
  eq(writeOps, null, 'roster/db.js contains no write operation at all');
  pass('the bot cannot mutate the web-owned collection');

  await rosterDb.close();

  console.log('\n============================================================');
  console.log(`ALL GREEN — ${checks} assertions passed.`);
  console.log('============================================================\n');
})().catch(err => {
  console.error('\nFAILED:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
