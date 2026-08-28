// ---------------------------------------------------------------------------
// Offline simulation for the officer carry scheduler.
//
// Spec: docs/OFFICER_CARRY_SCHEDULER_SPEC.md §11.
//
// No Discord connection, no Atlas. A fake in-memory Mongo is injected through
// db._setCollectionForTests, the same seam carry/db.js and partyfinder/db.js
// expose.
//
// THE FAKE IS DELIBERATELY ATOMIC PER updateOne — its filter evaluation and its
// mutation happen in one synchronous block with no await between them, which is
// exactly the guarantee MongoDB gives for a single-document update. That is
// what makes the race test meaningful rather than decorative.
//
// And because a test that cannot fail proves nothing, check 4 is a NEGATIVE
// CONTROL: it swaps the conditional update for the read-then-write shape and
// asserts the slot OVER-FILLS. If that control ever stops over-filling, the
// harness has lost the ability to detect the bug it is guarding.
//
//   node scripts/sim-officercarry.js
// ---------------------------------------------------------------------------

const assert = require('assert');

const grid = require('../officercarry/grid');
const render = require('../officercarry/render');
const db = require('../officercarry/db');
const {
  DAYS,
  MAX_MEMBERS_PER_SLOT,
  EMBED_FIELD_VALUE_LIMIT,
  EMBED_TOTAL_LIMIT,
  SELECT_OPTION_LIMIT,
  IDS,
  NAMESPACE,
} = require('../officercarry/constants');

let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks += 1; };
const eq = (a, b, label) => { assert.strictEqual(a, b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); checks += 1; };

const section = t => console.log(`\n── ${t}`);
const pass = t => console.log(`   ✓ ${t}`);

// ---------------------------------------------------------------------------
// Fake Mongo. Implements only the operators this feature actually uses, so a
// silent no-op cannot masquerade as a pass.
// ---------------------------------------------------------------------------
const tick = () => new Promise(r => setImmediate(r));

function getPath(doc, path) {
  let cur = doc;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

/**
 * Mongo semantics for a dotted path that crosses an array of subdocuments:
 * `slots.X.members.userId` resolves to the set of userId values across the
 * array, and a scalar comparison matches if ANY element matches. This is the
 * behaviour the $ne double-join guard relies on.
 */
function resolveMaybeArrayField(doc, path) {
  const parts = path.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (cur === null || cur === undefined) return { values: [undefined] };
    if (Array.isArray(cur) && !/^\d+$/.test(part)) {
      return { values: cur.map(el => (el ? el[part] : undefined)) };
    }
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
  }
  return { values: [cur] };
}

function matchesFilter(doc, filter) {
  for (const [field, cond] of Object.entries(filter)) {
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('$exists' in cond) {
        const exists = getPath(doc, field) !== undefined;
        if (exists !== cond.$exists) return false;
      }
      if ('$ne' in cond) {
        const { values } = resolveMaybeArrayField(doc, field);
        if (values.some(v => v === cond.$ne)) return false;
      }
      if ('$lte' in cond) {
        const v = getPath(doc, field);
        if (!(v instanceof Date) || v.getTime() > cond.$lte.getTime()) return false;
      }
    } else {
      // Plain equality. Mongo matches if ANY element of an array-of-subdocs
      // has the value, which is what the leave/withdraw filters rely on.
      const { values } = resolveMaybeArrayField(doc, field);
      if (!values.some(v => (v instanceof Date && cond instanceof Date)
        ? v.getTime() === cond.getTime()
        : v === cond)) return false;
    }
  }
  return true;
}

function applyUpdate(doc, update) {
  let modified = false;
  if (update.$set) {
    for (const [field, value] of Object.entries(update.$set)) {
      const parts = field.split('.');
      let cur = doc;
      for (let i = 0; i < parts.length - 1; i += 1) cur = cur[parts[i]];
      cur[parts[parts.length - 1]] = value;
      modified = true;
    }
  }
  if (update.$push) {
    for (const [field, value] of Object.entries(update.$push)) {
      const arr = getPath(doc, field);
      assert.ok(Array.isArray(arr), `$push target ${field} must be an array`);
      arr.push(value);
      modified = true;
    }
  }
  if (update.$pull) {
    for (const [field, cond] of Object.entries(update.$pull)) {
      const arr = getPath(doc, field);
      if (!Array.isArray(arr)) continue;
      const before = arr.length;
      const kept = arr.filter(el => !Object.entries(cond).every(([k, v]) => el[k] === v));
      arr.length = 0; arr.push(...kept);
      if (arr.length !== before) modified = true;
    }
  }
  return modified;
}

function makeCollection() {
  const docs = new Map();
  return {
    _docs: docs,
    async createIndex() { return 'ok'; },

    async findOne(filter) {
      await tick();
      for (const doc of docs.values()) if (matchesFilter(doc, filter)) return clone(doc);
      return null;
    },

    find(filter) {
      return {
        async toArray() {
          await tick();
          return [...docs.values()].filter(d => matchesFilter(d, filter)).map(clone);
        },
      };
    },

    // ATOMIC: filter check and mutation share one synchronous block, with the
    // only await BEFORE it. This is the whole point of the harness.
    async updateOne(filter, update, options = {}) {
      await tick();
      let matched = 0; let modified = 0;
      for (const doc of docs.values()) {
        if (!matchesFilter(doc, filter)) continue;
        matched = 1;
        if (applyUpdate(doc, update)) modified = 1;
        break;
      }
      if (!matched && options.upsert && update.$setOnInsert) {
        const doc = clone({ _id: filter._id, ...update.$setOnInsert });
        docs.set(doc._id, doc);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: matched, modifiedCount: modified, upsertedCount: 0 };
    },
  };
}

function clone(o) {
  return JSON.parse(JSON.stringify(o), (k, v) =>
    (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v) : v));
}

const GUILD = '999';
const entry = (id, name) => ({ userId: id, displayName: name, at: new Date() });

async function freshWeek(now = new Date()) {
  const col = makeCollection();
  db._setCollectionForTests(col);
  const doc = await db.getOrCreateActiveWeek(GUILD, now);
  return { col, doc };
}

// ===========================================================================
(async function main() {
  console.log('Officer carry scheduler — offline simulation');
  console.log('='.repeat(60));

  // -------------------------------------------------------------------------
  section('1. The grid is exactly what the spec says');
  eq(grid.allSlotKeys().length, 108, '108 slots per week');
  for (const d of DAYS) {
    const keys = grid.slotKeysForDay(d.key);
    eq(keys.length, d.weekend ? 24 : 12, `${d.key} slot count`);
    eq(keys[keys.length - 1], `${d.key}:2330`, `${d.key} last slot is 23:30`);
    eq(keys[0], d.weekend ? `${d.key}:1200` : `${d.key}:1800`, `${d.key} first slot`);
  }
  ok(!grid.allSlotKeys().some(k => k.endsWith(':2400')), 'no 00:00 slot exists');
  eq(new Set(grid.allSlotKeys()).size, 108, 'every slot key is unique');
  eq(grid.parseSlotKey('mon:1200'), null, 'weekday 12:00 is off-window and rejected');
  ok(grid.parseSlotKey('sat:1200'), 'weekend 12:00 is valid');
  eq(grid.parseSlotKey('mon:1807'), null, 'off-grid minute rejected');
  eq(grid.parseSlotKey('mon:2400'), null, 'midnight rejected');
  eq(grid.parseSlotKey('xxx:1800'), null, 'unknown day rejected');
  eq(grid.parseSlotKey('../etc'), null, 'junk rejected');
  pass('108 slots, correct windows, off-grid keys refused');

  // -------------------------------------------------------------------------
  section('2. Week boundary in GMT+7, across month and year rollovers');
  const sunLate  = new Date(Date.UTC(2026, 8, 6, 16, 30));   // Sun 06 Sep 23:30 GMT+7
  const monEarly = new Date(Date.UTC(2026, 8, 6, 17, 30));   // Mon 07 Sep 00:30 GMT+7
  ok(grid.weekKey(sunLate) !== grid.weekKey(monEarly), 'Sun 23:30 and Mon 00:30 GMT+7 are different weeks');
  eq(grid.weekStartAt(sunLate).toISOString(), '2026-08-30T17:00:00.000Z', 'week starts Mon 00:00 GMT+7');
  eq(grid.weekEndAt(sunLate).getTime() - grid.weekStartAt(sunLate).getTime(), 7 * 86400000, 'week is exactly 7 days');
  eq(grid.weekStartAt(monEarly).toISOString(), '2026-09-06T17:00:00.000Z', 'next week starts a week later');
  // A slot at Sunday 23:30 must fall inside its own week, not the next one.
  const ws = grid.weekStartAt(sunLate);
  const lastSlot = grid.slotStartAt('sun', 23 * 60 + 30, ws);
  ok(lastSlot >= ws && lastSlot < grid.weekEndAt(sunLate), 'Sun 23:30 slot lies inside its week');
  // Month rollover.
  ok(grid.weekKey(new Date(Date.UTC(2026, 7, 30, 17, 1))) === grid.weekKey(new Date(Date.UTC(2026, 8, 1, 0, 0))),
    'a week spanning 31 Aug / 1 Sep keeps one key');
  // ISO year rollover — 1 Jan 2027 belongs to ISO week 2026-W53.
  eq(grid.weekKey(new Date(Date.UTC(2027, 0, 1, 0, 0))), '2026-W53', '1 Jan 2027 is ISO 2026-W53');
  eq(grid.weekKey(new Date(Date.UTC(2027, 0, 4, 0, 0))), '2027-W01', '4 Jan 2027 is ISO 2027-W01');
  pass('boundaries, month rollover and ISO year rollover all correct');

  // -------------------------------------------------------------------------
  section('3. THE RACE — four simultaneous joins on one slot');
  {
    const { doc } = await freshWeek();
    const KEY = 'wed:2000';
    await db.addOfficerSlot(doc._id, KEY, entry('officer-1', 'Kaito'));

    const results = await Promise.all(
      ['m1', 'm2', 'm3', 'm4'].map(id => db.claimMemberSlot(doc._id, KEY, entry(id, id.toUpperCase()))),
    );
    const winners = results.filter(r => r === 'ok').length;
    const refused = results.filter(r => r === 'full').length;

    eq(winners, MAX_MEMBERS_PER_SLOT, 'exactly 3 winners');
    eq(refused, 1, 'exactly 1 refusal, and it says "full"');

    const after = await db.getWeekById(doc._id);
    eq(after.slots[KEY].members.length, MAX_MEMBERS_PER_SLOT, 'slot holds exactly 3 members');
    pass('the cap holds under a 4-way race — 3 in, 1 told the slot is full');
  }

  // -------------------------------------------------------------------------
  section('4. NEGATIVE CONTROL — read-then-write must over-fill');
  {
    const { col, doc } = await freshWeek();
    const KEY = 'wed:2000';
    await db.addOfficerSlot(doc._id, KEY, entry('officer-1', 'Kaito'));

    // The bug this feature was written to avoid: check, yield, then push.
    const naiveJoin = async (id) => {
      const d = await col.findOne({ _id: doc._id });
      if ((d.slots[KEY].members?.length || 0) >= MAX_MEMBERS_PER_SLOT) return 'full';
      await tick();                                   // the window a real await opens
      await col.updateOne(
        { _id: doc._id },
        { $push: { [`slots.${KEY}.members`]: entry(id, id) } },
      );
      return 'ok';
    };

    await Promise.all(['n1', 'n2', 'n3', 'n4'].map(naiveJoin));
    const after = await col.findOne({ _id: doc._id });

    ok(after.slots[KEY].members.length > MAX_MEMBERS_PER_SLOT,
      `read-then-write OVER-FILLS (seated ${after.slots[KEY].members.length}) — the harness can detect the bug`);
    pass(`control over-filled to ${after.slots[KEY].members.length} — check 3 is meaningful, not decorative`);
  }

  // -------------------------------------------------------------------------
  section('5. A slot with no officer cannot be joined');
  {
    const { doc } = await freshWeek();
    const KEY = 'thu:1900';
    const r = await db.claimMemberSlot(doc._id, KEY, entry('m1', 'Rin'));
    eq(r, 'no-officer', 'join refused with no officer on the slot');
    const after = await db.getWeekById(doc._id);
    eq(after.slots[KEY].members.length, 0, 'nothing was written');
    pass('availability creates a slot; joining only ever fills one');
  }

  // -------------------------------------------------------------------------
  section('6. Officer withdrawing mid-flow closes the join window');
  {
    const { doc } = await freshWeek();
    const KEY = 'fri:2100';
    await db.addOfficerSlot(doc._id, KEY, entry('officer-1', 'Kaito'));
    // The member's select is open. The officer withdraws before they choose.
    await db.removeOfficerSlot(doc._id, KEY, 'officer-1');
    const r = await db.claimMemberSlot(doc._id, KEY, entry('m1', 'Rin'));
    eq(r, 'no-officer', 'the stale select cannot seat anyone');
    pass('the officer guard lives in the join filter, so the window is closed');
  }

  // -------------------------------------------------------------------------
  section('7. No double-join, no double-availability');
  {
    const { doc } = await freshWeek();
    const KEY = 'mon:1830';
    await db.addOfficerSlot(doc._id, KEY, entry('officer-1', 'Kaito'));
    eq(await db.claimMemberSlot(doc._id, KEY, entry('m1', 'Rin')), 'ok', 'first join succeeds');
    eq(await db.claimMemberSlot(doc._id, KEY, entry('m1', 'Rin')), 'already', 'second join refused');
    eq(await db.addOfficerSlot(doc._id, KEY, entry('officer-1', 'Kaito')), 'already', 'double availability refused');

    const after = await db.getWeekById(doc._id);
    eq(after.slots[KEY].members.length, 1, 'still one member');
    eq(after.slots[KEY].officers.length, 1, 'still one officer');

    // A double-click race must not seat the same person twice either.
    const { doc: d2 } = await freshWeek();
    await db.addOfficerSlot(d2._id, KEY, entry('officer-1', 'Kaito'));
    const dbl = await Promise.all([
      db.claimMemberSlot(d2._id, KEY, entry('m9', 'Dup')),
      db.claimMemberSlot(d2._id, KEY, entry('m9', 'Dup')),
    ]);
    eq(dbl.filter(r => r === 'ok').length, 1, 'a double-click seats exactly once');
    pass('idempotent under repeat and under a double-click race');
  }

  // -------------------------------------------------------------------------
  section('8. Leaving, and officer withdrawal semantics');
  {
    const { doc } = await freshWeek();
    const KEY = 'sat:1400';
    await db.addOfficerSlot(doc._id, KEY, entry('officer-1', 'Kaito'));
    await db.addOfficerSlot(doc._id, KEY, entry('officer-2', 'Ren'));
    await db.claimMemberSlot(doc._id, KEY, entry('m1', 'Rin'));

    // One officer leaving while another remains keeps the slot open.
    await db.removeOfficerSlot(doc._id, KEY, 'officer-1');
    let after = await db.getWeekById(doc._id);
    eq(after.slots[KEY].officers.length, 1, 'second officer still covering');
    eq(await db.claimMemberSlot(doc._id, KEY, entry('m2', 'Mika')), 'ok', 'slot still joinable');

    // The last officer leaving closes it.
    await db.removeOfficerSlot(doc._id, KEY, 'officer-2');
    eq(await db.claimMemberSlot(doc._id, KEY, entry('m3', 'Sora')), 'no-officer', 'slot closed');

    // Members are NOT silently removed — they are still on record to be told.
    after = await db.getWeekById(doc._id);
    eq(after.slots[KEY].members.length, 2, 'joined members are still recorded, not wiped');

    eq(await db.leaveMemberSlot(doc._id, KEY, 'm1'), true, 'member can leave');
    eq(await db.leaveMemberSlot(doc._id, KEY, 'nobody'), false, 'leaving a slot you are not on is a no-op');
    pass('cover survives one officer leaving; the last one closes it without wiping members');
  }

  // -------------------------------------------------------------------------
  section('9. The weekly roll archives, and a missed boundary catches up once');
  {
    const col = makeCollection();
    db._setCollectionForTests(col);

    // A week that ended three days ago — the bot was down across the boundary.
    const longAgo = new Date(Date.UTC(2026, 7, 24, 0, 0));   // Mon 24 Aug
    const old = await db.getOrCreateActiveWeek(GUILD, longAgo);
    await db.addOfficerSlot(old._id, 'mon:1800', entry('officer-1', 'Kaito'));
    await db.claimMemberSlot(old._id, 'mon:1800', entry('m1', 'Rin'));
    await db.setPanel(old._id, 'chan-1', 'msg-1');

    const now = new Date(Date.UTC(2026, 8, 9, 0, 0));        // Wed 09 Sep, weeks later
    let expired = await db.listExpiredActiveWeeks(now);
    eq(expired.length, 1, 'exactly one stale week is due, not one per missed week');

    eq(await db.archiveWeek(old._id), true, 'first roll wins');
    eq(await db.archiveWeek(old._id), false, 'a second concurrent roll loses — idempotent');

    const archived = await db.getWeekById(old._id);
    ok(archived, 'the old week STILL EXISTS — archived, not deleted');
    eq(archived.status, 'archived', 'status flipped to archived');
    eq(archived.slots['mon:1800'].members.length, 1, 'its slot data is intact and still on record');

    const fresh = await db.getOrCreateActiveWeek(GUILD, now);
    eq(fresh.weekKey, grid.weekKey(now), 'the new week is the CURRENT one, not the one after the archived one');
    ok(fresh._id !== old._id, 'a genuinely new document');
    eq(fresh.slots['mon:1800'].members.length, 0, 'the new week starts empty');

    await db.adoptPanelFrom(archived, fresh._id);
    const adopted = await db.getWeekById(fresh._id);
    eq(adopted.panelMessageId, 'msg-1', 'the board keeps its permalink across the roll');

    expired = await db.listExpiredActiveWeeks(now);
    eq(expired.length, 0, 'nothing is due a second time');
    pass('rolled once, archived not deleted, landed on the current week, board kept its link');
  }

  // -------------------------------------------------------------------------
  section('10. Embed and select budgets in the worst case');
  {
    const { doc } = await freshWeek();
    // Every one of the 108 slots open and full, with long display names.
    for (const key of grid.allSlotKeys()) {
      await db.addOfficerSlot(doc._id, key, entry('o1', 'Wolfgang-Amadeus-Longname'));
      await db.addOfficerSlot(doc._id, key, entry('o2', 'Second-Officer-Longname'));
      for (const m of ['a', 'b', 'c']) {
        await db.claimMemberSlot(doc._id, key, entry(`m-${m}`, `Member-${m}-Longname`));
      }
    }
    const full = await db.getWeekById(doc._id);
    const embed = render.panelEmbed(full).toJSON();

    for (const f of embed.fields) {
      ok(f.value.length <= EMBED_FIELD_VALUE_LIMIT, `field "${f.name}" is ${f.value.length} <= ${EMBED_FIELD_VALUE_LIMIT}`);
    }
    const size = render.embedSize(embed);
    ok(size <= EMBED_TOTAL_LIMIT, `whole embed is ${size} <= ${EMBED_TOTAL_LIMIT}`);
    eq(embed.fields.length, 7, 'one field per day');

    // Selects must fit Discord's 25-option cap on the biggest day.
    for (const d of DAYS) {
      const row = render.slotSelect(full, d.key, 'x', { openOnly: true }).toJSON();
      const n = row.components[0].options.length;
      ok(n <= SELECT_OPTION_LIMIT, `${d.key} slot select has ${n} <= ${SELECT_OPTION_LIMIT} options`);
    }
    const dayRow = render.daySelect(full, 'y', { openOnly: true }).toJSON();
    eq(dayRow.components[0].options.length, 7, 'day select offers all 7 days when all are open');
    pass(`worst case renders at ${size} chars, every field and select inside its cap`);
  }

  // -------------------------------------------------------------------------
  section('11. Namespace isolation and whole-bot load');
  {
    const ids = Object.values(IDS);
    ok(ids.every(v => v.startsWith(NAMESPACE)), 'every customId sits under occarry:');
    eq(new Set(ids).size, ids.length, 'no duplicate customIds');

    // No other module may claim this namespace.
    const fs = require('fs'); const path = require('path');
    const root = path.join(__dirname, '..');
    // Comments are stripped before scanning. events/interactionCreate.js
    // legitimately NAMES the namespace in the comment above its router line,
    // and exempting the whole directory to accommodate that would stop the
    // check seeing real code there. Stripping comments keeps events/ in scope.
    const stripComments = src => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && !['node_modules', '.git', 'data', 'docs', 'scripts', 'officercarry'].includes(d.name))
      .map(d => d.name);
    const offenders = [];
    for (const dir of dirs) {
      for (const f of fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js'))) {
        const rel = `${dir}/${f}`;
        const code = stripComments(fs.readFileSync(path.join(root, dir, f), 'utf8'));
        if (code.includes(NAMESPACE)) offenders.push(rel);
      }
    }
    eq(offenders.length, 0, `no other module has occarry: in live code (found: ${offenders.join(', ')})`);
    // And prove the stripper cannot pass everything vacuously.
    ok(stripComments('const a = "occarry:x"; // comment').includes(NAMESPACE),
      'the comment stripper still sees the namespace in real code');

    // The command loads and declares both subcommands.
    const cmd = require('../commands/officercarry');
    const json = cmd.data.toJSON();
    eq(json.name, 'officercarry', 'command name');
    eq(json.options.length, 2, 'panel + reset subcommands');

    // Every command file still loads — this feature broke nothing.
    const commandFiles = fs.readdirSync(path.join(root, 'commands')).filter(f => f.endsWith('.js'));
    for (const f of commandFiles) require(path.join(root, 'commands', f));
    ok(commandFiles.length >= 31, `${commandFiles.length} commands load, including the new one`);

    require('../events/interactionCreate');
    require('../events/ready');
    ok(true, 'both edited event files load');
    pass(`namespace is exclusively ours; ${commandFiles.length} commands and both events load`);
  }

  // -------------------------------------------------------------------------
  section('12. No pending state exists anywhere in the module (spec §0)');
  {
    const fs = require('fs'); const path = require('path');
    const dir = path.join(__dirname, '..', 'officercarry');
    const banned = /\b(pendingUntil|holdUntil|reserveSlot|expireHold|PENDING_DRAFTS|markPaid)\b/;
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      ok(!banned.test(src), `${f} carries no hold/pending/expiry machinery`);
    }
    // A join must land in `members` directly, with no status field to be stuck in.
    const { doc } = await freshWeek();
    await db.addOfficerSlot(doc._id, 'tue:1800', entry('o1', 'Kaito'));
    await db.claimMemberSlot(doc._id, 'tue:1800', entry('m1', 'Rin'));
    const after = await db.getWeekById(doc._id);
    const m = after.slots['tue:1800'].members[0];
    eq(m.userId, 'm1', 'the member is in the slot immediately');
    ok(!('status' in m), 'a member entry has no status field to be pending in');
    eq(Object.keys(m).sort().join(','), 'at,displayName,userId', 'entry is exactly {userId, displayName, at}');
    pass('joins are immediate and final — nothing can hold, expire or un-commit one');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`ALL GREEN — ${checks} assertions passed.`);
})().catch(err => {
  console.error(`\n✗ FAILED after ${checks} assertions\n`);
  console.error(err);
  process.exit(1);
});
