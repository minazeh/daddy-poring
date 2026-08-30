// ---------------------------------------------------------------------------
// Offline simulation for /profile, covering the addition of the POLARITY and
// SIEGE party blocks alongside the existing GvG one.
//
// No Discord connection, no Atlas. The resolvers are pure functions over plain
// documents shaped exactly like the collections roster/db.js reads, so this
// exercises the real code — buildProfileFields() is the same function execute()
// calls, not a copy of it.
//
// The thing that can actually break this feature is Discord's 6,000-character
// embed cap: a member in BOTH guilds now carries SIX member lists, and six
// fields at the 1,024 per-field cap is 6,144 on their own. Check 6 is therefore
// a NEGATIVE CONTROL — it builds that worst case, asserts the UNTRIMMED embed
// really does exceed 6,000, and only then asserts the budget pass brings it
// back under. If the control ever stops exceeding the cap, this harness has
// lost the ability to detect the bug it is guarding.
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
function layoutsFor(docs, { polarity = true, siege = true, inPolarity = true, inSiege = true, kind = 'main' } = {}) {
  const pol = polarityFixture(docs, kind);
  const sg = siegeFixture(docs);
  if (!inPolarity) pol.parties[0].memberIds = pol.parties[0].memberIds.filter(id => id !== ME);
  if (!inSiege) sg.parties[0].memberIds = sg.parties[0].memberIds.filter(id => id !== ME);
  return {
    gvg: resolveGvgParty(gvgFixture(docs), ME),
    polarity: polarity ? resolveRaidLinkedParty(pol, ME) : null,
    siege: siege ? resolveRaidLinkedParty(sg, ME) : null,
    hasPolarity: polarity,
    hasSiege: siege,
  };
}

const names = fields => fields.map(f => f.name);

(async () => {
  console.log('\n/profile — polarity + siege blocks\n' + '='.repeat(60));

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

    const emptyParty = { party: { name: 'Party 9', memberIds: [] }, raidName: 'Bravo', memberMap: new Map() };
    eq(partyMembersValue(emptyParty), '—', 'an empty party renders an em dash, never a blank value');

    // A raid the member is in that has no matching raid doc.
    const orphan = resolveRaidLinkedParty(
      { raids: [], parties: [{ partyId: 'x', raidId: 'gone', name: 'Party 1', memberIds: [ME] }], memberMap: buildMemberMap(docs) },
      ME,
    );
    eq(orphan.raidName, 'Unassigned', 'a party whose raid doc is missing reads Unassigned, not undefined');
    pass('every absence path produces a printable value');
  }

  // -------------------------------------------------------------------------
  section('3. Field labels, order, and the main-raid marker');
  {
    const docs = members(5);
    const primary = layoutsFor(docs);
    const fields = buildProfileFields({
      username: 'conrad', ign: 'Conrad', jobClass: 'Rune Knight', powerText: '152400',
      kudos: { total: 12, rank: 3, totalRecipients: 40, givenToday: 1 }, kudosLimit: 5,
      primary, secondary: null,
    });

    assert.deepStrictEqual(names(fields), [
      'Username', 'In-game Name',
      'Kudos', 'Rank', 'Given Today',
      'Party Name', 'Job Class', 'Power', 'Party Members',
      'Polarity Party', 'Polarity Members',
      'Siege Party', 'Siege Members',
    ], 'single-guild field order');
    checks += 1;

    const byName = Object.fromEntries(fields.map(f => [f.name, f.value]));
    eq(byName['Party Name'], 'Party 1 (Raid Alpha)', 'GvG value is unchanged from before this feature');
    ok(byName['Polarity Party'].startsWith('Party 1 (Main A)'), 'polarity value is "Party (Raid)"');
    ok(byName['Polarity Party'].includes('Main raid (top power)'),
      'a MAIN polarity raid says so — it is the top-power group');
    eq(byName['Siege Party'], 'Party 3 (Bravo)', 'siege value is "Party (Raid)" with no marker');

    // A normal-kind polarity raid must NOT claim to be a main raid.
    const normal = layoutsFor(docs, { kind: 'normal' });
    ok(!partyNameValue(normal.polarity).includes('Main raid'),
      'a NORMAL polarity raid carries no main-raid marker');

    // The three columns still sit on one row.
    for (const n of ['Party Name', 'Job Class', 'Power']) {
      ok(fields.find(f => f.name === n).inline === true, `${n} stays inline`);
    }
    ok(fields.find(f => f.name === 'Polarity Party').inline === false,
      'the polarity block is full-width, not squeezed into a column');
    pass('labels, order and the main-raid marker are right; the existing row is untouched');
  }

  // -------------------------------------------------------------------------
  section('4. A layout that is not set up is omitted; one you are not in says so');
  {
    const docs = members(5);

    // Web app never seeded the siege collections for this guild.
    const noSiege = layoutsFor(docs, { siege: false });
    const f1 = layoutFields(noSiege);
    ok(names(f1).some(n => n.startsWith('Polarity')), 'polarity block present when seeded');
    ok(!names(f1).some(n => n.startsWith('Siege')),
      'an unseeded siege contributes NO fields at all — not an empty one');

    // Seeded, but this member is not in a siege party.
    const outOfSiege = layoutsFor(docs, { inSiege: false });
    const f2 = layoutFields(outOfSiege);
    eq(f2.find(f => f.name === 'Siege Party').value, '—',
      'a seeded siege the member is not in shows an explicit em dash — "not assigned" is an answer');
    ok(!names(f2).includes('Siege Members'),
      'no member list is emitted for a party the member is not in');

    // Neither layout seeded → the profile is exactly what it was before.
    const neither = layoutsFor(docs, { polarity: false, siege: false });
    eq(layoutFields(neither).length, 0,
      'with neither layout seeded, /profile adds zero fields — unchanged from before');

    // Half-seeded: parties exist, raid docs do not. The member IS assigned, so
    // the block must still show rather than be hidden behind the raid count.
    const halfSeeded = {
      gvg: null,
      polarity: resolveRaidLinkedParty(
        { raids: [], parties: [{ partyId: 'x', raidId: 'gone', name: 'Party 1', memberIds: [ME] }], memberMap: buildMemberMap(docs) },
        ME,
      ),
      siege: null,
      hasPolarity: false || true, // what loadGuildLayouts computes: raids.length > 0 || !!polarity
      hasSiege: false,
    };
    const f3 = layoutFields(halfSeeded);
    eq(f3.find(f => f.name === 'Polarity Party').value, 'Party 1 (Unassigned)',
      'a real assignment is shown even when the raid docs are missing');
    pass('seeded-vs-assigned are treated as different questions');
  }

  // -------------------------------------------------------------------------
  section('5. Both guilds — the full 19-field profile');
  {
    const docs = members(5);
    const fields = buildProfileFields({
      username: 'conrad', ign: 'Conrad', jobClass: 'Rune Knight', powerText: '152400',
      kudos: { total: 12, rank: 3, totalRecipients: 40, givenToday: 1 }, kudosLimit: 5,
      primary: layoutsFor(docs), secondary: layoutsFor(docs),
    });

    eq(fields.length, 19, 'both guilds, all three layouts, member in every one');
    ok(fields.length <= EMBED_FIELD_COUNT_LIMIT,
      `${fields.length} fields is within Discord's ${EMBED_FIELD_COUNT_LIMIT}-field cap`);

    const mummy = names(fields).filter(n => n.endsWith(' (Mummy)'));
    assert.deepStrictEqual(mummy, [
      'Party Name (Mummy)', 'Party Members (Mummy)',
      'Polarity Party (Mummy)', 'Polarity Members (Mummy)',
      'Siege Party (Mummy)', 'Siege Members (Mummy)',
    ], 'the secondary guild gets all three layouts, each suffixed');
    checks += 1;

    eq(new Set(names(fields)).size, fields.length, 'no duplicate field names across the two guilds');

    // At the real party size of 5 the budget pass must be inert.
    const before = fields.map(f => f.value);
    const total = fitFieldsToEmbed('Your Profile', fields, 'Member Since: Mon Jan 01 2024');
    assert.deepStrictEqual(fields.map(f => f.value), before,
      'at partySize 5 nothing is trimmed — a normal profile renders in full');
    checks += 1;
    ok(total < 1500, `a realistic full profile measures ${total} chars, far inside the cap`);
    pass(`19 fields, ${total} chars, nothing trimmed`);
  }

  // -------------------------------------------------------------------------
  section('6. NEGATIVE CONTROL — the worst case really does blow the 6,000 cap');
  {
    // 40-member parties with 32-char display names (Discord's nickname limit)
    // and a long class name. Six such lists is what the budget pass exists for.
    const docs = members(40, { nameLen: 32, cls: 'Arch Bishop Transcendent' });
    const build = () => buildProfileFields({
      username: 'conrad'.padEnd(32, 'x'), ign: 'Conrad'.padEnd(32, 'x'),
      jobClass: 'Arch Bishop Transcendent', powerText: '152400',
      kudos: { total: 12, rank: 3, totalRecipients: 40, givenToday: 1 }, kudosLimit: 5,
      primary: layoutsFor(docs), secondary: layoutsFor(docs),
    });

    const title = 'Your Profile';
    const footer = 'Member Since: Mon Jan 01 2024';

    // The control: measure WITHOUT the budget pass.
    const untrimmed = build();
    const lists = untrimmed.filter(f => f.isList);
    eq(lists.length, 6, 'the worst case carries six member lists');
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

    // Truncated lists must say they were truncated rather than quietly stop.
    const trimmedList = fields.find(f => f.isList);
    ok(/\+\d+ more$/.test(trimmedList.value),
      'a truncated member list ends with a "+N more" trailer, so nothing vanishes silently');

    // The floor holds even if the non-list content were pathological.
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

    // The mention must render without pinging — unchanged, but it is the kind
    // of thing an edit to this file could quietly drop.
    ok(src.includes("allowedMentions: { parse: [] }"), 'the greeting mention still does not ping');

    // toEmbedFields must strip the bookkeeping keys EmbedBuilder would reject.
    const stripped = toEmbedFields([{ name: 'A', value: 'b', inline: false, isList: true, ctx: {} }]);
    assert.deepStrictEqual(Object.keys(stripped[0]).sort(), ['inline', 'name', 'value'],
      'toEmbedFields hands EmbedBuilder only name/value/inline');
    checks += 1;
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
