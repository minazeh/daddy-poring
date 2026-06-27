// ---------------------------------------------------------------------------
// Member-sync core — fetches the active Daddy/Mummy roster from every guild
// the bot is in and upserts the result to MongoDB.
//
// Designed to be called from two places:
//   1. The hourly setInterval in membersync/index.js (timer-driven).
//   2. The /syncmembers slash command handler (officer-triggered).
//
// syncMembers(client) never throws — all errors are logged and swallowed so
// neither the timer nor a command interaction can crash the bot.
// ---------------------------------------------------------------------------

const { ROLE_IDS, CLASS_ROLE_BY_ID } = require('../guildapp/constants');
const db = require('./db');

const DADDY_ROLE_ID = ROLE_IDS.ACCEPTED; // "Daddy" — Main Guild
const MUMMY_ROLE_ID = ROLE_IDS.MUMMY;   // "Mummy" — Second Guild (sub)

// ---------------------------------------------------------------------------
// Map a GuildMember to the stored doc schema.
// Returns the doc object ready for upsertMembers().
// ---------------------------------------------------------------------------
function memberToDoc(member) {
  const user = member.user;

  // Resolve class role: find the first role the member holds that appears in
  // CLASS_ROLE_BY_ID. Members should only have one class role, but we take the
  // first match if somehow multiple are present.
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
    displayName: member.displayName,          // server nickname, falls back to username
    avatarUrl:   member.displayAvatarURL({ size: 256 }) ?? null,
    isMain:      member.roles.cache.has(DADDY_ROLE_ID),
    isSub:       member.roles.cache.has(MUMMY_ROLE_ID),
    className,
    classRoleId,
    updatedAt:   new Date(),
  };
}

// ---------------------------------------------------------------------------
// syncMembers(client)
//   Iterates every guild the bot belongs to, fetches the full member list,
//   filters to those holding Daddy OR Mummy role, maps to the doc schema,
//   upserts to MongoDB, and removes stale docs.
//
//   Returns { total, main, sub } on success; returns { total:0, main:0, sub:0 }
//   on error (after logging).
// ---------------------------------------------------------------------------
async function syncMembers(client) {
  if (!db.isReady()) {
    console.warn('[membersync] sync skipped — DB not ready.');
    return { total: 0, main: 0, sub: 0 };
  }

  let totalAll = 0;
  let totalMain = 0;
  let totalSub  = 0;

  try {
    for (const guild of client.guilds.cache.values()) {
      try {
        // Fetch all guild members (requires GuildMembers intent, already set).
        await guild.members.fetch();

        // Filter: must hold Daddy OR Mummy role (or both).
        const qualifying = guild.members.cache.filter(m =>
          m.roles.cache.has(DADDY_ROLE_ID) || m.roles.cache.has(MUMMY_ROLE_ID)
        );

        const docs = qualifying.map(memberToDoc);
        const ids  = docs.map(d => d.userId);

        const mainCount = docs.filter(d => d.isMain).length;
        const subCount  = docs.filter(d => d.isSub).length;

        await db.upsertMembers(docs);
        await db.removeStale(ids);

        totalAll  += docs.length;
        totalMain += mainCount;
        totalSub  += subCount;

        console.log(
          `[membersync] guild "${guild.name}" — synced ${docs.length} members ` +
          `(${mainCount} main / ${subCount} sub)`
        );
      } catch (guildErr) {
        console.warn(`[membersync] Failed to sync guild "${guild.name}":`, guildErr?.message || guildErr);
      }
    }

    console.log(
      `[membersync] synced ${totalAll} (${totalMain} main / ${totalSub} sub)`
    );
    return { total: totalAll, main: totalMain, sub: totalSub };
  } catch (err) {
    console.warn('[membersync] Unexpected sync error:', err?.message || err);
    return { total: 0, main: 0, sub: 0 };
  }
}

module.exports = { syncMembers };
