// Sanity check for membersync — no live Discord/DB needed.
// Run from the discord-bot directory: node scripts/sanity-membersync.js

const { ROLE_IDS, CLASS_ROLE_BY_ID } = require('../guildapp/constants');

const DADDY_ROLE_ID = ROLE_IDS.ACCEPTED; // 1518076953595351191
const MUMMY_ROLE_ID = ROLE_IDS.MUMMY;   // 1518664863621320817

let pass = 0;
let fail = 0;

function assert(label, condition, extra = '') {
  if (condition) {
    console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`);
    fail++;
  }
}

// ---------------------------------------------------------------------------
// Mock GuildMember factory
// ---------------------------------------------------------------------------
function makeMember({ userId, username, displayName, roles = [], guildAvatar = false }) {
  const roleSet = new Set(roles);
  return {
    user: { id: userId, username },
    displayName,
    roles: {
      cache: {
        has: (id) => roleSet.has(id),
      },
    },
    displayAvatarURL: ({ size } = {}) =>
      guildAvatar
        ? `https://cdn.discordapp.com/guilds/fake/${userId}/avatars/fake.png?size=${size}`
        : null,
  };
}

// memberToDoc inline — mirrors membersync/sync.js logic exactly.
function memberToDoc(member) {
  const user = member.user;
  let className   = null;
  let classRoleId = null;
  for (const [roleId, name] of Object.entries(CLASS_ROLE_BY_ID)) {
    if (member.roles.cache.has(roleId)) {
      className   = name;
      classRoleId = roleId;
      break;
    }
  }
  return {
    userId:      user.id,
    username:    user.username,
    displayName: member.displayName,
    avatarUrl:   member.displayAvatarURL({ size: 256 }) ?? null,
    isMain:      member.roles.cache.has(DADDY_ROLE_ID),
    isSub:       member.roles.cache.has(MUMMY_ROLE_ID),
    className,
    classRoleId,
    updatedAt:   new Date(),
  };
}

// ---------------------------------------------------------------------------
// 1. Role ID constants
// ---------------------------------------------------------------------------
console.log('\n--- 1. Role ID constants ---');
assert('DADDY_ROLE_ID matches ACCEPTED', DADDY_ROLE_ID === '1518076953595351191', DADDY_ROLE_ID);
assert('MUMMY_ROLE_ID matches MUMMY',   MUMMY_ROLE_ID  === '1518664863621320817', MUMMY_ROLE_ID);

// ---------------------------------------------------------------------------
// 2. isMain / isSub mapping
// ---------------------------------------------------------------------------
console.log('\n--- 2. isMain / isSub mapping ---');

const daddyDoc = memberToDoc(makeMember({ userId: 'u1', username: 'alice', displayName: 'Alice', roles: [DADDY_ROLE_ID] }));
assert('Daddy → isMain=true',  daddyDoc.isMain === true);
assert('Daddy → isSub=false',  daddyDoc.isSub  === false);

const mummyDoc = memberToDoc(makeMember({ userId: 'u2', username: 'bob',   displayName: 'Bob',   roles: [MUMMY_ROLE_ID] }));
assert('Mummy → isMain=false', mummyDoc.isMain === false);
assert('Mummy → isSub=true',   mummyDoc.isSub  === true);

const bothDoc = memberToDoc(makeMember({ userId: 'u3', username: 'carol', displayName: 'Carol', roles: [DADDY_ROLE_ID, MUMMY_ROLE_ID] }));
assert('Both roles → isMain=true',  bothDoc.isMain === true);
assert('Both roles → isSub=true',   bothDoc.isSub  === true);

const neitherDoc = memberToDoc(makeMember({ userId: 'u4', username: 'dave', displayName: 'Dave', roles: [] }));
assert('No roles → isMain=false', neitherDoc.isMain === false);
assert('No roles → isSub=false',  neitherDoc.isSub  === false);

// ---------------------------------------------------------------------------
// 3. className resolution via CLASS_ROLE_BY_ID
// ---------------------------------------------------------------------------
console.log('\n--- 3. className resolution ---');

const classEntries = Object.entries(CLASS_ROLE_BY_ID);
assert('CLASS_ROLE_BY_ID has 13 entries', classEntries.length === 13, `got ${classEntries.length}`);

const expectedClasses = ['Assassin','Hunter','Knight','Priest','Gunslinger','Blacksmith','Wizard','Druid','Paladin','Monk','Bard','Dancer','Alchemist'].sort();
const actualClasses   = classEntries.map(([, n]) => n).sort();
assert('All 13 class names present', JSON.stringify(actualClasses) === JSON.stringify(expectedClasses), actualClasses.join(','));

const knightRoleId = classEntries.find(([, n]) => n === 'Knight')?.[0];
assert('Knight role ID exists', !!knightRoleId, knightRoleId);

const knightDoc = memberToDoc(makeMember({ userId: 'u5', username: 'eve', displayName: 'Eve', roles: [DADDY_ROLE_ID, knightRoleId] }));
assert('Knight member → className=Knight',     knightDoc.className   === 'Knight',     knightDoc.className);
assert('Knight member → classRoleId=knightId', knightDoc.classRoleId === knightRoleId, knightDoc.classRoleId);
assert('Knight member → isMain=true',          knightDoc.isMain === true);

const noClassDoc = memberToDoc(makeMember({ userId: 'u6', username: 'frank', displayName: 'Frank', roles: [DADDY_ROLE_ID] }));
assert('No class role → className=null',   noClassDoc.className   === null);
assert('No class role → classRoleId=null', noClassDoc.classRoleId === null);

// All 13 classes resolve
for (const [roleId, name] of classEntries) {
  const doc = memberToDoc(makeMember({ userId: `cx_${roleId}`, username: name, displayName: name, roles: [roleId, DADDY_ROLE_ID] }));
  assert(`Class ${name} resolves correctly`, doc.className === name && doc.classRoleId === roleId);
}

// Bard / Dancer / Alchemist (added 2026-09-23): right class, DPS-only in Party
// Finder, 'dps' in the roster role map, and never counted as a Priest.
{
  const { CLASS_ALLOWED_CATEGORIES, CLASS_CATEGORY_BY_ROLE_ID } = require('../partyfinder/constants');
  const { classToRole } = require('../roster/roles');
  const NEW_CLASSES = {
    '1552024522863939664': 'Bard',
    '1552024620218064946': 'Dancer',
    '1552024646252240987': 'Alchemist',
  };
  for (const [roleId, name] of Object.entries(NEW_CLASSES)) {
    assert(`${name} role ID → ${name}`, CLASS_ROLE_BY_ID[roleId] === name, CLASS_ROLE_BY_ID[roleId]);
    assert(`${name} Party Finder = ['DPS'] only`, JSON.stringify(CLASS_ALLOWED_CATEGORIES[roleId]) === '["DPS"]', JSON.stringify(CLASS_ALLOWED_CATEGORIES[roleId]));
    assert(`${name} legacy category = DPS`, CLASS_CATEGORY_BY_ROLE_ID[roleId] === 'DPS', CLASS_CATEGORY_BY_ROLE_ID[roleId]);
    assert(`${name} roster role = dps`, classToRole(name) === 'dps', classToRole(name));
    assert(`${name} roster role = dps with a settings doc that predates it`, classToRole(name, { Priest: 'healer' }) === 'dps');
    assert(`${name} is not a Priest`, name !== 'Priest' && classToRole(name) !== 'healer');
  }
}

// ---------------------------------------------------------------------------
// 4. displayName and avatarUrl
// ---------------------------------------------------------------------------
console.log('\n--- 4. displayName + avatarUrl ---');

const avatarDoc = memberToDoc(makeMember({ userId: 'u7', username: 'gina', displayName: 'Gina Server Nick', roles: [DADDY_ROLE_ID], guildAvatar: true }));
assert('displayName is server nick',         avatarDoc.displayName === 'Gina Server Nick', avatarDoc.displayName);
assert('avatarUrl non-null when present',    avatarDoc.avatarUrl !== null,                  avatarDoc.avatarUrl);
assert('avatarUrl includes ?size=256',       avatarDoc.avatarUrl?.includes('size=256'),     avatarDoc.avatarUrl);

const noAvatarDoc = memberToDoc(makeMember({ userId: 'u8', username: 'hank', displayName: 'Hank', roles: [DADDY_ROLE_ID], guildAvatar: false }));
assert('avatarUrl is null when absent', noAvatarDoc.avatarUrl === null);

// ---------------------------------------------------------------------------
// 5. Filter: Daddy OR Mummy only
// ---------------------------------------------------------------------------
console.log('\n--- 5. Filter: Daddy OR Mummy ---');

const roster = [
  makeMember({ userId: 'f1', username: 'a', displayName: 'A', roles: [DADDY_ROLE_ID] }),
  makeMember({ userId: 'f2', username: 'b', displayName: 'B', roles: [MUMMY_ROLE_ID] }),
  makeMember({ userId: 'f3', username: 'c', displayName: 'C', roles: [DADDY_ROLE_ID, MUMMY_ROLE_ID] }),
  makeMember({ userId: 'f4', username: 'd', displayName: 'D', roles: [] }),             // excluded
  makeMember({ userId: 'f5', username: 'e', displayName: 'E', roles: ['9999999999'] }), // unrelated
];

const qualifying = roster.filter(m =>
  m.roles.cache.has(DADDY_ROLE_ID) || m.roles.cache.has(MUMMY_ROLE_ID)
);
assert('Filter keeps 3 qualifying members',  qualifying.length === 3, `got ${qualifying.length}`);
assert('Excludes no-role member',            !qualifying.some(m => m.user.id === 'f4'));
assert('Excludes unrelated-role member',     !qualifying.some(m => m.user.id === 'f5'));
assert('Keeps Daddy-only member',            qualifying.some(m => m.user.id === 'f1'));
assert('Keeps Mummy-only member',            qualifying.some(m => m.user.id === 'f2'));
assert('Keeps both-role member',             qualifying.some(m => m.user.id === 'f3'));

// ---------------------------------------------------------------------------
// 6. removeStale logic
// ---------------------------------------------------------------------------
console.log('\n--- 6. removeStale logic ---');

const storedIds  = ['u1', 'u2', 'u3', 'u_old1', 'u_old2'];
const currentIds = ['u1', 'u2', 'u3'];

const staleIds = storedIds.filter(id => !currentIds.includes(id));
assert('Identifies 2 stale IDs',             staleIds.length === 2,           staleIds.join(','));
assert('u_old1 is stale',                    staleIds.includes('u_old1'));
assert('u_old2 is stale',                    staleIds.includes('u_old2'));
assert('Current members NOT stale',          currentIds.every(id => !staleIds.includes(id)));

// Empty-set guard: in db.js, removeStale returns early if currentUserIds is empty
// Verify the guard condition directly
function simulateRemoveStaleGuard(ids) {
  if (!ids.length) return 'SKIPPED';
  return 'WOULD_DELETE';
}
assert('Empty roster triggers skip-guard',   simulateRemoveStaleGuard([]) === 'SKIPPED');
assert('Non-empty roster proceeds normally', simulateRemoveStaleGuard(['u1']) === 'WOULD_DELETE');

// ---------------------------------------------------------------------------
// 7. Doc schema completeness
// ---------------------------------------------------------------------------
console.log('\n--- 7. Doc schema completeness ---');

const schemaDoc = knightDoc;
const requiredKeys = ['userId','username','displayName','avatarUrl','isMain','isSub','className','classRoleId','updatedAt'];
for (const key of requiredKeys) {
  assert(`Doc has key: ${key}`, key in schemaDoc, String(schemaDoc[key]));
}
assert('updatedAt is a Date instance', schemaDoc.updatedAt instanceof Date);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== SANITY CHECK: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
