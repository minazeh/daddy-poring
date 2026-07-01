// ---------------------------------------------------------------------------
// Invite-use tracker — resolves WHICH invite a joining member used.
//
// Technique: snapshot each guild's invite use-counts on boot, then on every join
// re-fetch and diff to find the code whose `uses` incremented (or a brand-new
// code that arrived already used). Best-effort throughout:
//   - Requires the GuildInvites intent + Manage Guild permission to fetch invites.
//   - If perms/intent are missing, fetches throw and we degrade to "unresolved".
//   - Vanity URLs and Discord-native onboarding don't surface a normal invite —
//     those resolve to null and the join is logged without an invite.
//
// In-memory only; rebuilt on every boot. Never throws to callers.
// ---------------------------------------------------------------------------

// guildId -> Map<inviteCode, uses>
const cache = new Map();

function snapshotFrom(invites) {
  const m = new Map();
  for (const inv of invites.values()) {
    m.set(inv.code, inv.uses ?? 0);
  }
  return m;
}

// Fetch + snapshot every guild's invites at boot. Called once from ready.
async function init(client) {
  if (!client?.guilds?.cache) return;
  for (const guild of client.guilds.cache.values()) {
    try {
      const invites = await guild.invites.fetch();
      cache.set(guild.id, snapshotFrom(invites));
    } catch (err) {
      // Missing Manage Guild / intent — leave this guild untracked.
      console.warn(`[auditlog:invites] Could not snapshot invites for guild ${guild.id} (need Manage Guild + GuildInvites intent):`, err?.message || err);
    }
  }
}

// On a member join, diff the live invites against the snapshot to find the used
// code. Returns { code, inviterTag } or null. Always refreshes the snapshot.
async function resolveUsedInvite(member) {
  const guild = member?.guild;
  if (!guild) return null;

  let live;
  try {
    live = await guild.invites.fetch();
  } catch {
    return null; // no perms / intent — cannot resolve
  }

  const before = cache.get(guild.id) || new Map();
  let used = null;

  for (const inv of live.values()) {
    const prev = before.get(inv.code);
    const now = inv.uses ?? 0;
    // Either an existing code whose uses went up, or a new code already used ≥1.
    if ((prev === undefined && now >= 1) || (prev !== undefined && now > prev)) {
      used = inv;
      break;
    }
  }

  // Refresh snapshot regardless so the next join diffs correctly.
  cache.set(guild.id, snapshotFrom(live));

  if (!used) return null;
  return {
    code: used.code,
    inviterTag: used.inviter ? (used.inviter.tag || used.inviter.username || used.inviter.id) : null,
  };
}

module.exports = { init, resolveUsedInvite };
