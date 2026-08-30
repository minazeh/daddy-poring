// ---------------------------------------------------------------------------
// Offline simulation for /profile, covering the POLARITY and SIEGE columns
// added alongside the renamed GUILD LEAGUE one.
//
// No Discord connection, no Atlas. The resolvers are pure functions over plain
// documents shaped exactly like the collections roster/db.js reads, so this
// exercises the real code — buildProfileFields() is the same function execute()
// calls, not a copy of it.
//
// The three layouts render as ONE ROW of three inline columns. Discord packs
// inline fields three to a row, so the row's shape depends on all three being
// present and inline and contiguous; check 4 asserts exactly that, because a
// dropped or non-inline column silently reflows the whole row.
//
// The thing that can actually break the feature is Discord's 6,000-character
// embed cap: a member in BOTH guilds carries SIX columns, and six fields at the
// 1,024 per-field cap is 6,144 on their own. Check 6 is therefore a NEGATIVE
// CONTROL — it builds that worst case, asserts the UNTRIMMED embed really does
// exceed 6,000, and only then asserts the budget pass brings it back under. If
// the control ever stops exceeding the cap, this harness has lost the ability
// to detect the bug it is guarding.
//
//   node scripts/sim-profile.js
// ---------------------------------------------------------------------------

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  resolveGvgParty,
  resolveRaidLinkedParty,
  buildMemberMap,
  partyNameValue,
  partyMembersValue,
  layoutColumnValue,
  layoutFields,
  buildProfileFields,
  toEmbedFields,
  embedChars,
  fitFieldsToEmbed,
  SAFE_TOTAL,
  LIST_FIELD_CAP,
  MIN_LIST_CAP,
} = require('../commands/profile.js')._internals;

// Discord's documented hard limits. Named here rather than inlined so a failure
// message points at the actual rule being broken.
const EMBED_TOTAL_LIMIT = 6000;
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_FIELD_NAME_LIMIT = 256;
const EMBED_FIELD_COUNT_LIMIT = 25;

let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks += 1; };
const eq = (a, b, label) => { assert.strictEqual(a, b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); checks += 1; };

const section = t => console.log(`\n── ${t}`);
const pass = t => console.log(`   ✓ ${t}`);

const ME = 'u-me';

// ---------------------------------------------------------------------------
// Fixtures — documents shaped like the real collections.
// ---------------------------------------------------------------------------

function members(n, { nameLen = 8, cls = 'Rune Knight' } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    userId: i === 0 ? ME : `u-${i}`,
    username: `user${i}`,
    displayName: (i === 0 ? 'Me' : `M${i}`).padEnd(nameLen, 'x'),
    className: cls,
    isMain: true,
    isSub: true,
  }));
}

const memberIdsOf = docs => docs.map(m => m.userId);

// GvG: parties keyed by partyId, raidGroups link DOWN via partyIds.
function gvgFixture(docs) {
  return {
    parties: [
      { partyId: 'daddy-main-0', type: 'daddy', field: 'main', name: 'Party 1', memberIds: memberIdsOf(docs), position: 0 },
      { partyId: 'daddy-main-1', type: 'daddy', field: 'main', name: 'Party 2', memberIds: [], position: 1 },
    ],
    raidGroups: [
      { raidGroupId: 'rg-0', type: 'daddy', field: 'main', name: 'Raid Alpha', partyIds: ['daddy-main-0'], position: 0 },
    ],
    memberMap: buildMemberMap(docs),
  };
}

// Polarity: parties link UP via raidId, and carry a main/normal kind.
function polarityFixture(docs, kind = 'main') {
  const raidId = `daddy-polarity-${kind}-0`;
  return {
    raids: [{ raidId, type: 'daddy', kind, index: 0, name: kind === 'main' ? 'Main A' : 'Normal A', position: 0, leaderId: null }],
    parties: [{ partyId: `${raidId}-p0`, type: 'daddy', raidId, kind, name: 'Party 1', memberIds: memberIdsOf(docs), position: 0 }],
    memberMap: buildMemberMap(docs),
  };
}

// Siege: same raidId linkage as polarity, but no kind.
function siegeFixture(docs, raidKey = 'bravo') {
  const raidId = `daddy-siege-${raidKey}`;
  return {
    raids: [{ raidId, type: 'daddy', raidKey, name: 'Bravo', position: 1, leaderId: null }],
    parties: [{ partyId: `${raidId}-p2`, type: 'daddy', raidId, raidKey, name: 'Party 3', memberIds: memberIdsOf(docs), position: 2 }],
    memberMap: buildMemberMap(docs),
  };
}

// A loadGuildLayouts()-shaped result, assembled from the fixtures above.
function layoutsFor(docs, { inPolarity = true, inSiege = true, kind = 'main' } = {}) {
  const pol = polarityFixture(docs, kind);
  const sg = siegeFixture(docs);
  if (!inPolarity) pol.parties[0].memberIds = pol.parties[0].memberIds.filter(id => id !== ME);
  if (!inSiege) sg.parties[0].memberIds = sg.parties[0].memberIds.filter(id => id !== ME);
  return {
    gvg: resolveGvgParty(gvgFixture(docs), ME),
    polarity: resolveRaidLinkedParty(pol, ME),
    siege: resolveRaidLinkedParty(sg, ME),
  };
}

const names = fields => fields.map(f => f.name);

// Discord's row packing, modelled: inline fields accumulate three to a row; a
// non-inline field breaks the current row and takes a full row of its own.
//
// This is the check that matters for a three-column layout. Asserting the three
// columns are inline and adjacent is NOT sufficient — if the row above them
// holds only two inline fields, Discord pulls the first column up to fill it
// and orphans the other two. Only packing reveals that.
function packRows(fields) {
  const rows = [];
  let row = [];
  for (const f of fields) {
    if (!f.inline) {
      if (row.length) { rows.push(row); row = []; }
      rows.push([f]);
      continue;
    }
    row.push(f);
    if (row.length === 3) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  return rows.map(r => r.map(f => f.name));
}

const baseArgs = {
  username: 'conrad', ign: 'Conrad', jobClass: 'Rune Knight', powerText: '152400',
  kudos: { total: 12, rank: 3, totalRecipients: 40, givenToday: 1 }, kudosLimit: 5,
};

(async () => {
  console.log('\n/profile — Guild League | Polarity | Siege\n' + '='.repeat(60));

  // -------------------------------------------------------------------------
  section('1. The two linkages resolve, and they are genuinely different');
  {
    const docs = members(5);

    const gvg = resolveGvgParty(gvgFixture(docs), ME);
    ok(gvg, 'GvG party resolves for a member who is in one');
    eq(gvg.party.name, 'Party 1', 'GvG party name');
    eq(gvg.raidName, 'Raid Alpha', 'GvG raid found by scanning raidGroups.partyIds');

    const pol = resolveRaidLinkedParty(polarityFixture(docs), ME);
    eq(pol.party.name, 'Party 1', 'polarity party name');
    eq(pol.raidName, 'Main A', 'polarity raid found by party.raidId lookup');
    eq(pol.kind, 'main', 'polarity kind carried through');

    const sg = resolveRaidLinkedParty(siegeFixture(docs), ME);
    eq(sg.party.name, 'Party 3', 'siege party name');
    eq(sg.raidName, 'Bravo', 'siege raid found by party.raidId lookup');
    eq(sg.kind, undefined, 'siege carries no kind — there is no main/normal split');

    // The linkages are not interchangeable: a polarity party has no entry in
    // any raidGroup.partyIds, so the GvG resolver could not find its raid.
    const polAsGvg = resolveGvgParty(
      { parties: polarityFixture(docs).parties, raidGroups: gvgFixture(docs).raidGroups, memberMap: buildMemberMap(docs) },
      ME,
    );
    eq(polAsGvg.raidName, 'Unassigned',
      'the GvG resolver cannot name a polarity raid — the two linkages are distinct');
    pass('partyIds-scan and raidId-lookup both work and are not the same mechanism');
  }

  // -------------------------------------------------------------------------
  section('2. Not in a party, and empty parties');
  {
    const docs = members(5);
    const others = docs.filter(m => m.userId !== ME);

    const noGvg = resolveGvgParty(
      { parties: [{ partyId: 'p', name: 'Party 1', memberIds: memberIdsOf(others) }], raidGroups: [], memberMap: buildMemberMap(docs) },
      ME,
    );
    eq(noGvg, null, 'resolver returns null when the member is in no party');
    eq(partyNameValue(null), '—', 'null context renders an em dash, not a crash');
    eq(partyMembersValue(null), '—', 'null context member list renders an em dash');
    eq(layoutColumnValue(null), '—', 'a null column renders an em dash — never a blank field value');

    const emptyParty = { party: { name: 'Party 9', memberIds: [] }, raidName: 'Bravo', memberMap: new Map() };
    ok(layoutColumnValue(emptyParty).endsWith('—'), 'an empty party shows its name and an em dash for members');

    // A raid the member is in that has no matching raid doc.
    const orphan = resolveRaidLinkedParty(
      { raids: [], parties: [{ partyId: 'x', raidId: 'gone', name: 'Party 1', memberIds: [ME] }], memberMap: buildMemberMap(docs) },
      ME,
    );
    eq(orphan.raidName, 'Unassigned', 'a party whose raid doc is missing reads Unassigned, not undefined');
    ok(layoutColumnValue(orphan).startsWith('**Party 1** (Unassigned)'),
      'a real assignment still shows even when the raid docs are missing');
    pass('every absence path produces a printable value');
  }

  // -------------------------------------------------------------------------
  section('3. Field labels and order — "Guild League", not "Party"');
  {
    const docs = members(5);
    const fields = buildProfileFields({ ...baseArgs, primary: layoutsFor(docs), secondary: null });

    assert.deepStrictEqual(names(fields), [
      'Username',
      'In-game Name', 'Job Class', 'Power',
      'Kudos', 'Rank', 'Given Today',
      'Guild League', 'Polarity', 'Siege',
    ], 'single-guild field order');
    checks += 1;

    // The rename must be complete — no "Party" label may survive anywhere.
    for (const n of names(fields)) {
      ok(!/^Party/.test(n), `no field is still labelled "${n}"`);
    }

    const byName = Object.fromEntries(fields.map(f => [f.name, f.value]));
    ok(byName['Guild League'].startsWith('**Party 1** (Raid Alpha)'), 'Guild League column heads with its party and raid');
    ok(byName['Guild League'].includes('1. Mexxxxxx - Rune Knight'), 'Guild League column carries its member list');
    ok(byName['Polarity'].startsWith('**Party 1** (Main A)'), 'Polarity column heads with its party and raid');
    ok(byName['Polarity'].includes('Main raid (top power)'),
      'a MAIN polarity raid says so — it is the top-power group');
    ok(byName['Siege'].startsWith('**Party 3** (Bravo)'), 'Siege column heads with its party and raid');
    ok(!byName['Siege'].includes('Main raid'), 'the siege column carries no main-raid marker');

    // A normal-kind polarity raid must NOT claim to be a main raid.
    const normal = layoutsFor(docs, { kind: 'normal' });
    ok(!layoutColumnValue(normal.polarity).includes('Main raid'),
      'a NORMAL polarity raid carries no main-raid marker');
    pass('labels renamed, order right, party and members share one column');
  }

  // -------------------------------------------------------------------------
  section('4. The layout row is three inline columns, always');
  {
    const docs = members(5);

    // THE ASSERTION THAT MATTERS: pack the fields the way Discord does and
    // require the three columns to occupy a row of their OWN. Adjacent-and-
    // inline is not enough — an incomplete row above pulls the first column up
    // into it and orphans the other two onto the next line, which is exactly
    // what the first cut of this feature did.
    const fields = buildProfileFields({ ...baseArgs, primary: layoutsFor(docs), secondary: null });
    const rows = packRows(fields);
    assert.deepStrictEqual(rows, [
      ['Username'],
      ['In-game Name', 'Job Class', 'Power'],
      ['Kudos', 'Rank', 'Given Today'],
      ['Guild League', 'Polarity', 'Siege'],
    ], 'the three layouts occupy one row of their own');
    checks += 1;

    // Every inline row above the layout row must be FULL, or the packing shifts.
    for (const r of rows.slice(0, -1)) {
      ok(r.length === 3 || r.length === 1,
        `row [${r.join(' | ')}] is either a full three or a full-width single — a two leaks the next row`);
    }

    // Same guarantee with kudos unavailable, which removes a whole row.
    const noKudos = packRows(buildProfileFields({ ...baseArgs, kudos: null, primary: layoutsFor(docs), secondary: null }));
    assert.deepStrictEqual(noKudos[noKudos.length - 1], ['Guild League', 'Polarity', 'Siege'],
      'the layout row survives kudos being unavailable');
    checks += 1;

    // And with both guilds: two clean layout rows, one per guild.
    const both = packRows(buildProfileFields({ ...baseArgs, primary: layoutsFor(docs), secondary: layoutsFor(docs) }));
    assert.deepStrictEqual(both.slice(-2), [
      ['Guild League', 'Polarity', 'Siege'],
      ['Guild League (Mummy)', 'Polarity (Mummy)', 'Siege (Mummy)'],
    ], 'each guild gets its own clean three-column row');
    checks += 1;

    for (const f of fields.filter(x => x.isList)) ok(f.inline === true, `${f.name} is inline`);

    // Absent layouts do NOT drop their column, or the row would collapse to two
    // and the next guild's columns would slide up beside the survivors.
    const partial = layoutFields(layoutsFor(docs, { inPolarity: false, inSiege: false }));
    eq(partial.length, 3, 'a member in neither polarity nor siege still gets three columns');
    eq(partial.find(f => f.name === 'Polarity').value, '—', 'the empty polarity column is an em dash');
    eq(partial.find(f => f.name === 'Siege').value, '—', 'the empty siege column is an em dash');

    // Roster unavailable entirely (null layouts) — same shape, no crash.
    const none = layoutFields(null);
    eq(none.length, 3, 'a null layout set still yields three columns');
    for (const f of none) eq(f.value, '—', `${f.name} is an em dash when the roster is unavailable`);
    pass('the row keeps its shape through every absence');
  }

  // -------------------------------------------------------------------------
  section('5. Both guilds — two rows of three, 13 fields');
  {
    const docs = members(5);
    const fields = buildProfileFields({ ...baseArgs, primary: layoutsFor(docs), secondary: layoutsFor(docs) });

    eq(fields.length, 13, 'both guilds, all three layouts');
    ok(fields.length <= EMBED_FIELD_COUNT_LIMIT,
      `${fields.length} fields is within Discord's ${EMBED_FIELD_COUNT_LIMIT}-field cap`);

    const mummy = names(fields).filter(n => n.endsWith(' (Mummy)'));
    assert.deepStrictEqual(mummy, ['Guild League (Mummy)', 'Polarity (Mummy)', 'Siege (Mummy)'],
      'the secondary guild gets its own three-column row, each suffixed');
    checks += 1;

    eq(new Set(names(fields)).size, fields.length, 'no duplicate field names across the two guilds');

    // Six columns, six inline, two clean rows of three.
    const cols = fields.filter(f => f.isList);
    eq(cols.length, 6, 'six layout columns in total');
    for (const f of cols) ok(f.inline === true, `${f.name} is inline`);

    // At the real party size of 5 the budget pass must be inert.
    const before = fields.map(f => f.value);
    const total = fitFieldsToEmbed('Your Profile', fields, 'Member Since: Mon Jan 01 2024');
    assert.deepStrictEqual(fields.map(f => f.value), before,
      'at partySize 5 nothing is trimmed — a normal profile renders in full');
    checks += 1;
    ok(total < 1500, `a realistic full profile measures ${total} chars, far inside the cap`);
    pass(`13 fields, two rows of three, ${total} chars, nothing trimmed`);
  }

  // -------------------------------------------------------------------------
  section('6. NEGATIVE CONTROL — the worst case really does blow the 6,000 cap');
  {
    // 40-member parties with 32-char display names (Discord's nickname limit)
    // and a long class name. Six such columns is what the budget pass is for.
    const docs = members(40, { nameLen: 32, cls: 'Arch Bishop Transcendent' });
    const build = () => buildProfileFields({
      ...baseArgs,
      username: 'conrad'.padEnd(32, 'x'), ign: 'Conrad'.padEnd(32, 'x'),
      jobClass: 'Arch Bishop Transcendent',
      primary: layoutsFor(docs), secondary: layoutsFor(docs),
    });

    const title = 'Your Profile';
    const footer = 'Member Since: Mon Jan 01 2024';

    // The control: measure WITHOUT the budget pass.
    const untrimmed = build();
    eq(untrimmed.filter(f => f.isList).length, 6, 'the worst case carries six columns');
    const rawTotal = embedChars(title, untrimmed, footer);
    ok(rawTotal > EMBED_TOTAL_LIMIT,
      `CONTROL: untrimmed the worst case measures ${rawTotal} chars, over the ${EMBED_TOTAL_LIMIT} cap ` +
      '— so this harness can detect the bug it guards');

    // The real path.
    const fields = build();
    const total = fitFieldsToEmbed(title, fields, footer);
    ok(total <= SAFE_TOTAL, `trimmed to ${total} chars, within the ${SAFE_TOTAL} safety threshold`);
    ok(total <= EMBED_TOTAL_LIMIT, `trimmed embed is inside Discord's ${EMBED_TOTAL_LIMIT}-char cap`);
    ok(fields.length <= EMBED_FIELD_COUNT_LIMIT, 'worst case still within the 25-field cap');

    for (const f of fields) {
      ok(f.value.length > 0 && f.value.length <= EMBED_FIELD_VALUE_LIMIT,
        `"${f.name}" value is non-empty and within ${EMBED_FIELD_VALUE_LIMIT} chars (${f.value.length})`);
      ok(f.name.length <= EMBED_FIELD_NAME_LIMIT, `"${f.name}" name within ${EMBED_FIELD_NAME_LIMIT} chars`);
    }

    // Trimming must not eat the heading — a column with no party name is unreadable.
    const trimmed = fields.find(f => f.isList);
    ok(trimmed.value.startsWith('**Party'), 'a trimmed column still leads with its party heading');
    ok(/\+\d+ more$/.test(trimmed.value),
      'a truncated member list ends with a "+N more" trailer, so nothing vanishes silently');

    // The columns stay inline through the trim — the row must survive it.
    for (const f of fields.filter(x => x.isList)) ok(f.inline === true, `${f.name} is still inline after trimming`);

    ok(MIN_LIST_CAP > 0 && MIN_LIST_CAP < LIST_FIELD_CAP, 'the per-list floor is a real, smaller bound');
    pass(`control fires at ${rawTotal} chars; the budget pass lands it at ${total}`);
  }

  // -------------------------------------------------------------------------
  section('7. The command stays read-only and Discord-safe');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'profile.js'), 'utf8');

    for (const write of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne', 'bulkWrite', 'findOneAndUpdate']) {
      ok(!src.includes(write), `/profile never calls ${write} — the roster collections are web-owned`);
    }

    // Only the getters roster/db.js actually exposes.
    const dbCalls = [...src.matchAll(/rosterDb\.(\w+)/g)].map(m => m[1]);
    const allowed = new Set(['isReady', 'getMembers', 'getParties', 'getRaidGroups', 'getPolarityRaids', 'getPolarityParties', 'getSiegeRaids', 'getSiegeParties', 'getMember', 'getPower']);
    for (const c of new Set(dbCalls)) ok(allowed.has(c), `rosterDb.${c} is a known read-only getter`);

    const rosterExports = Object.keys(require('../roster/db'));
    for (const c of new Set(dbCalls)) ok(rosterExports.includes(c), `rosterDb.${c} actually exists on roster/db`);

    ok(src.includes("allowedMentions: { parse: [] }"), 'the greeting mention still does not ping');

    // toEmbedFields must strip the bookkeeping keys EmbedBuilder would reject,
    // and must preserve inline — losing it would collapse the three-column row.
    const stripped = toEmbedFields([{ name: 'A', value: 'b', inline: true, isList: true, ctx: {} }]);
    assert.deepStrictEqual(Object.keys(stripped[0]).sort(), ['inline', 'name', 'value'],
      'toEmbedFields hands EmbedBuilder only name/value/inline');
    checks += 1;
    eq(stripped[0].inline, true, 'toEmbedFields preserves inline — the row depends on it');
    pass('read-only, and only real getters are called');
  }

  // -------------------------------------------------------------------------
  section('8. The whole bot still loads with the edited command');
  {
    const dir = path.join(__dirname, '..', 'commands');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    const seen = new Map();
    for (const f of files) {
      const cmd = require(path.join(dir, f));
      if (!cmd?.data?.name) continue;
      ok(!seen.has(cmd.data.name), `no duplicate command name: ${cmd.data.name}`);
      seen.set(cmd.data.name, f);
    }
    ok(seen.get('profile') === 'profile.js', '/profile is registered from profile.js');
    ok(seen.size >= 25, `${seen.size} commands load — the rest of the bot is unaffected`);
    pass(`${seen.size} commands load cleanly, no duplicates`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`ALL GREEN — ${checks} assertions passed.`);
})().catch(err => {
  console.error(`\n✗ FAILED after ${checks} assertions\n`);
  console.error(err);
  process.exit(1);
});
