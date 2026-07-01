// ---------------------------------------------------------------------------
// Short-lived correlation stores used to disambiguate gateway events that carry
// no actor against the audit-log stream that does.
//
// TWO problems this solves:
//
// 1. guildMemberRemove fires for a voluntary leave AND for a kick AND for a ban.
//    The audit handler marks recent kicks/bans here; the leave handler waits a
//    beat, then checks — if the removal was a kick/ban it stays silent (the audit
//    handler already logged it) and only logs genuine voluntary leaves.
//
// 2. messageDelete (gateway) carries the deleted content but not WHO deleted it.
//    A moderator deleting someone else's message produces a MessageDelete audit
//    entry (with executor) — recorded here so the gateway handler can attribute
//    the deleter. Self-deletes produce no audit entry → attributed "unknown".
//
// All entries auto-expire; timers are unref'd so they never keep the process
// alive. Everything is in-memory and best-effort.
// ---------------------------------------------------------------------------

const REMOVAL_TTL_MS = 6000;   // window to correlate a leave with a kick/ban
const MSGDEL_TTL_MS  = 6000;   // window to correlate a delete with a mod action

// userId -> { type: 'kick' | 'ban', at: number }
const recentRemovals = new Map();

// `${authorId}:${channelId}` -> { actor: string, at: number }
const recentModDeletes = new Map();

function armExpiry(map, key, ttl) {
  const t = setTimeout(() => {
    const e = map.get(key);
    if (e && Date.now() - e.at >= ttl) map.delete(key);
  }, ttl + 200);
  if (typeof t.unref === 'function') t.unref();
}

// --- kick/ban vs leave -----------------------------------------------------

function markRemoval(userId, type) {
  if (!userId) return;
  recentRemovals.set(userId, { type, at: Date.now() });
  armExpiry(recentRemovals, userId, REMOVAL_TTL_MS);
}

// Returns 'kick' | 'ban' | null and consumes the marker.
function consumeRemoval(userId) {
  const e = recentRemovals.get(userId);
  if (!e) return null;
  recentRemovals.delete(userId);
  if (Date.now() - e.at > REMOVAL_TTL_MS) return null;
  return e.type;
}

// --- mod message-delete attribution ----------------------------------------

function markModDelete(authorId, channelId, actorLabel) {
  if (!authorId || !channelId) return;
  recentModDeletes.set(`${authorId}:${channelId}`, { actor: actorLabel, at: Date.now() });
  armExpiry(recentModDeletes, `${authorId}:${channelId}`, MSGDEL_TTL_MS);
}

// Returns the actor label string or null, and consumes the marker.
function consumeModDelete(authorId, channelId) {
  const key = `${authorId}:${channelId}`;
  const e = recentModDeletes.get(key);
  if (!e) return null;
  recentModDeletes.delete(key);
  if (Date.now() - e.at > MSGDEL_TTL_MS) return null;
  return e.actor;
}

module.exports = {
  markRemoval,
  consumeRemoval,
  markModDelete,
  consumeModDelete,
  REMOVAL_TTL_MS,
  MSGDEL_TTL_MS,
};
