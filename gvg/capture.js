// ---------------------------------------------------------------------------
// GvG window capture — attendance tracking + roster flags + log posting.
//
// When a schedule fires (gvg/scheduler.js), startCapture():
//   1. selects the monitored VCs matching the schedule's guild target
//      (daddy → daddy-tagged, mummy → mummy-tagged, both → all),
//   2. SNAPSHOTS everyone currently in those VCs,
//   3. persists an in_progress gvg_attendance doc (restart-safe),
//   4. keeps tracking joins via voiceStateUpdate for `durationMin` minutes —
//      anyone present at ANY point in the window counts,
//   5. at window end, cross-checks the roster (roster/db.js: Daddy VC ⇒
//      member should have isMain, Mummy VC ⇒ isSub — wrong/unknown gets a ⚠
//      flag; roster down ⇒ label-only, no flags), posts the attendance log to
//      LOG_CHANNEL_ID, and finalizes the doc (status completed, full per-VC
//      result — web-app-ready).
//
// RESTART-SAFE: every join is $set into the in_progress doc immediately. On
// boot, resume() reloads any in_progress capture, re-snapshots the VCs (so
// anyone who joined while the bot was down is still counted), re-arms the end
// timer for the REMAINING time (or finalizes at once if the window already
// ended), and tracking continues.
//
// Scale guard (mirrors /activitycampaign status): the log embed caps each
// VC's inline name list by count + char budget; when anything is truncated
// the FULL attendance is attached as a text file. Embed field ≤ 1024, total
// ≤ 6000, content 2000 limits are all respected by construction.
// ---------------------------------------------------------------------------

const { EmbedBuilder, AttachmentBuilder, ChannelType } = require('discord.js');
const db = require('./db');
const rosterDb = require('../roster/db');
const {
  LOG_CHANNEL_ID,
  GVG_TZ_OFFSET_HOURS,
  GVG_TZ_LABEL,
  GUILD_LABELS,
  LOG_INLINE_MEMBER_CAP,
  LOG_FIELD_CHAR_BUDGET,
  LOG_EMBED_TOTAL_BUDGET,
} = require('./constants');

// captureId (string) → active capture state:
//   { captureId, schedule, guildId, startedAt, endsAt,
//     vcs: [{channelId,label,guild}], vcIndex: Map<channelId, vc>,
//     members: Map<channelId, Map<userId, rec>>, endTimer }
// rec = { userId, username, displayName, firstSeenAt, lastSeenAt }
const activeCaptures = new Map();

// Fast no-op guard for the voiceStateUpdate event (fires constantly).
function hasActiveCaptures() {
  return activeCaptures.size > 0;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

// A member record from a GuildMember (voice snapshot or voiceStateUpdate).
function recOf(member, now) {
  return {
    userId: member.id,
    username: member.user?.username ?? member.id,
    displayName: member.displayName ?? member.user?.username ?? member.id,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

// 'HH:MM' wall-clock GMT+7 for a Date (file/embed detail lines).
function hhmmTz(date) {
  const shifted = new Date(date.getTime() + GVG_TZ_OFFSET_HOURS * 3_600_000);
  const p = n => String(n).padStart(2, '0');
  return `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}`;
}

// ---------------------------------------------------------------------------
// Snapshot the CURRENT occupants of one capture's VCs into its member maps
// (used at window start AND on restart-resume). New members are persisted;
// already-known members keep their original firstSeenAt. Channel fetch
// failures (deleted VC, missing perms) are logged and skipped — the rest of
// the capture still works.
// ---------------------------------------------------------------------------
async function snapshotVcs(client, capture) {
  const now = new Date();
  for (const vc of capture.vcs) {
    let channel = null;
    try {
      channel = await client.channels.fetch(vc.channelId);
    } catch (err) {
      console.warn(`[gvg/capture] Could not fetch VC ${vc.channelId} ("${vc.label}") — skipping snapshot:`, err?.message || err);
      continue;
    }
    if (!channel || !channel.isVoiceBased?.() || !channel.members) continue;

    for (const member of channel.members.values()) {
      if (member.user?.bot) continue; // bots don't attend GvG
      const chanMap = capture.members.get(vc.channelId);
      if (!chanMap.has(member.id)) {
        const rec = recOf(member, now);
        chanMap.set(member.id, rec);
        // Persist immediately — restart-safe. Fire-and-forget with catch.
        db.setCaptureMember(capture.captureId, vc.channelId, rec).catch(err =>
          console.warn('[gvg/capture] Persist member failed:', err?.message || err));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// startCapture(client, schedule) — the scheduler's fire handler.
// ---------------------------------------------------------------------------
async function startCapture(client, schedule) {
  const target = schedule.guild || 'both';
  const vcs = (await db.getVoiceChannelsForTarget(target)).map(v => ({
    channelId: v.channelId, label: v.label, guild: v.guild,
  }));

  const slotLabel = `${schedule.label ? schedule.label + ' — ' : ''}${schedule.day} ${schedule.time} ${GVG_TZ_LABEL} (${GUILD_LABELS[target] || target})`;

  if (!vcs.length) {
    console.warn(`[gvg/capture] Schedule fired but no monitored VCs match target "${target}" — nothing to capture (${slotLabel}). Add VCs with /gvgvc add.`);
    return null;
  }

  const startedAt = new Date();
  const durationMin = schedule.durationMin || 60;
  const endsAt = new Date(startedAt.getTime() + durationMin * 60_000);

  const capture = {
    captureId: null,
    schedule: {
      id: String(schedule._id || ''),
      day: schedule.day,
      time: schedule.time,
      guild: target,
      durationMin,
      label: schedule.label || null,
    },
    guildId: schedule.guildId || null,
    startedAt,
    endsAt,
    vcs,
    vcIndex: new Map(vcs.map(v => [v.channelId, v])),
    members: new Map(vcs.map(v => [v.channelId, new Map()])),
    endTimer: null,
  };

  // Persist the in_progress doc FIRST (empty members) so even a crash during
  // the snapshot leaves a resumable record.
  capture.captureId = await db.createCapture({
    schedule: capture.schedule,
    guildId: capture.guildId,
    startedAt,
    endsAt,
    vcs,
    members: {},
  });
  if (!capture.captureId) {
    console.warn(`[gvg/capture] Could not persist capture (DB not ready) — skipping window (${slotLabel}).`);
    return null;
  }

  activeCaptures.set(capture.captureId, capture);
  await snapshotVcs(client, capture);
  armEndTimer(client, capture);

  console.log(`[gvg/capture] Window OPEN — ${slotLabel}; ${vcs.length} VC(s), ${countUnique(capture)} present at start; ends ${endsAt.toISOString()}.`);
  return capture.captureId;
}

// Arm (or re-arm on resume) the end-of-window timer.
function armEndTimer(client, capture) {
  if (capture.endTimer) clearTimeout(capture.endTimer);
  const delay = Math.max(0, capture.endsAt.getTime() - Date.now());
  capture.endTimer = setTimeout(() => {
    endCapture(client, capture).catch(err =>
      console.warn('[gvg/capture] endCapture failed:', err?.message || err));
  }, delay);
  if (typeof capture.endTimer.unref === 'function') capture.endTimer.unref();
}

// Unique attendees across all of a capture's VCs.
function countUnique(capture) {
  const ids = new Set();
  for (const chanMap of capture.members.values()) {
    for (const id of chanMap.keys()) ids.add(id);
  }
  return ids.size;
}

// ---------------------------------------------------------------------------
// voiceStateUpdate hook — events/voiceStateUpdate.js delegates here.
// Joins to a monitored VC during a window add the member (first-seen now);
// leaves update lastSeenAt. No active window → immediate no-op.
// ---------------------------------------------------------------------------
function handleVoiceStateUpdate(oldState, newState) {
  if (!hasActiveCaptures()) return;

  const now = new Date();
  const member = newState.member || oldState.member;
  if (!member || member.user?.bot) return;
  const joinedChannelId = newState.channelId && newState.channelId !== oldState.channelId
    ? newState.channelId : null;
  const leftChannelId = oldState.channelId && oldState.channelId !== newState.channelId
    ? oldState.channelId : null;
  if (!joinedChannelId && !leftChannelId) return; // mute/deaf/etc — irrelevant

  for (const capture of activeCaptures.values()) {
    // JOIN into a monitored VC → record (first join wins firstSeenAt).
    if (joinedChannelId && capture.vcIndex.has(joinedChannelId)) {
      const chanMap = capture.members.get(joinedChannelId);
      if (!chanMap.has(member.id)) {
        const rec = recOf(member, now);
        chanMap.set(member.id, rec);
        db.setCaptureMember(capture.captureId, joinedChannelId, rec).catch(err =>
          console.warn('[gvg/capture] Persist join failed:', err?.message || err));
      } else {
        const rec = chanMap.get(member.id);
        rec.lastSeenAt = now; // rejoined the same VC
        db.setCaptureMemberLastSeen(capture.captureId, joinedChannelId, member.id, now).catch(() => {});
      }
    }
    // LEAVE from a monitored VC → bump lastSeenAt (presence already counted).
    if (leftChannelId && capture.vcIndex.has(leftChannelId)) {
      const chanMap = capture.members.get(leftChannelId);
      const rec = chanMap?.get(member.id);
      if (rec) {
        rec.lastSeenAt = now;
        db.setCaptureMemberLastSeen(capture.captureId, leftChannelId, member.id, now).catch(() => {});
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Roster cross-check. Daddy-tagged VC → flag anyone whose roster doc is
// missing or has isMain !== true; Mummy-tagged → isSub !== true. If the
// roster store is down, returns rosterAvailable:false and NO flags
// (label-only log). Roster lookups are cached per userId within one compile.
// ---------------------------------------------------------------------------
async function compileResult(capture) {
  const rosterAvailable = rosterDb.isReady();
  const rosterCache = new Map(); // userId → member doc | null

  async function lookup(userId) {
    if (rosterCache.has(userId)) return rosterCache.get(userId);
    let doc = null;
    try {
      doc = await rosterDb.getMember(userId);
    } catch (err) {
      console.warn('[gvg/capture] Roster lookup failed:', err?.message || err);
    }
    rosterCache.set(userId, doc);
    return doc;
  }

  const result = [];
  for (const vc of capture.vcs) {
    const chanMap = capture.members.get(vc.channelId) || new Map();
    const members = [];
    for (const rec of chanMap.values()) {
      let onRoster = null;
      let flagged = false;
      if (rosterAvailable) {
        const doc = await lookup(rec.userId);
        onRoster = Boolean(vc.guild === 'mummy' ? doc?.isSub : doc?.isMain);
        flagged = !onRoster;
      }
      members.push({ ...rec, onRoster, flagged });
    }
    // Alphabetical by display name — stable, scannable log.
    members.sort((a, b) => a.displayName.localeCompare(b.displayName));
    result.push({
      channelId: vc.channelId,
      label: vc.label,
      guild: vc.guild,
      count: members.length,
      flaggedCount: members.filter(m => m.flagged).length,
      members,
    });
  }
  return { rosterAvailable, result };
}

// ---------------------------------------------------------------------------
// Attendance-log builder — embed + optional full-list file (scale guard).
// Exported for synthetic tests.
// ---------------------------------------------------------------------------
function buildLog(capture, result, rosterAvailable) {
  const s = capture.schedule;
  const title = `GvG Attendance — ${s.day} ${s.time} ${GVG_TZ_LABEL} (${GUILD_LABELS[s.guild] || s.guild})`;

  const uniqueIds = new Set();
  let totalFlagged = 0;
  for (const vc of result) {
    for (const m of vc.members) uniqueIds.add(m.userId);
    totalFlagged += vc.flaggedCount;
  }

  const startTs = Math.floor(capture.startedAt.getTime() / 1000);
  const endTs = Math.floor(capture.endsAt.getTime() / 1000);
  const descLines = [
    ...(s.label ? [`**${s.label}**`] : []),
    `Window: <t:${startTs}:f> → <t:${endTs}:t> (${s.durationMin} min)`,
    `Attended: **${uniqueIds.size}** unique member(s) across ${result.length} VC(s)`,
    rosterAvailable
      ? (totalFlagged > 0 ? `⚠ = not on that VC's guild roster (${totalFlagged} flagged)` : 'Roster check: all attendees matched their VC ✅')
      : '⚠️ Roster unavailable — names only, no wrong-VC flags this run.',
  ];

  // Per-field char budget: stay under Discord's 1024/field AND keep the whole
  // embed under ~6000 even with many VCs.
  const fieldBudget = Math.max(200, Math.min(
    LOG_FIELD_CHAR_BUDGET,
    Math.floor(LOG_EMBED_TOTAL_BUDGET / Math.max(1, result.length)),
  ));

  let truncated = false;
  const fields = result.map(vc => {
    const name = `${vc.label} (${GUILD_LABELS[vc.guild] || vc.guild}) — ${vc.count} present`
      .slice(0, 256);
    if (!vc.members.length) return { name, value: '_(no one attended)_', inline: false };

    const shown = [];
    let len = 0;
    for (const m of vc.members) {
      if (shown.length >= LOG_INLINE_MEMBER_CAP) break;
      const line = `${m.flagged ? '⚠ ' : ''}${m.displayName}`;
      if (len + line.length + 1 > fieldBudget) break;
      shown.push(line);
      len += line.length + 1;
    }
    const extra = vc.members.length - shown.length;
    if (extra > 0) truncated = true;
    const value = (shown.join('\n') || '…') + (extra > 0 ? `\n… +${extra} more (full list attached)` : '');
    return { name, value: value.slice(0, 1024), inline: false };
  });

  const embed = new EmbedBuilder()
    .setTitle(title.slice(0, 256))
    .setDescription(descLines.join('\n'))
    .setColor(0x5865F2)
    .setTimestamp(capture.endsAt);
  for (const f of fields.slice(0, 25)) embed.addFields(f);

  const payload = { embeds: [embed] };

  // Anything truncated inline → attach the complete attendance as text.
  if (truncated) {
    const fileLines = [
      title,
      ...(s.label ? [s.label] : []),
      `Window: ${capture.startedAt.toISOString()} -> ${capture.endsAt.toISOString()} (${s.durationMin} min)`,
      rosterAvailable ? 'Flag legend: [!] = not on that VC\'s guild roster' : 'Roster unavailable — no flags.',
      '',
    ];
    for (const vc of result) {
      fileLines.push(`== ${vc.label} (${GUILD_LABELS[vc.guild] || vc.guild}) — ${vc.count} present${vc.flaggedCount ? `, ${vc.flaggedCount} flagged` : ''} ==`);
      if (!vc.members.length) fileLines.push('(no one attended)');
      for (const m of vc.members) {
        fileLines.push(`${m.flagged ? '[!] ' : '    '}${m.displayName} (@${m.username}) — first seen ${hhmmTz(new Date(m.firstSeenAt))} ${GVG_TZ_LABEL}`);
      }
      fileLines.push('');
    }
    payload.files = [new AttachmentBuilder(
      Buffer.from(fileLines.join('\n'), 'utf8'),
      { name: 'gvg-attendance.txt' },
    )];
  }

  return payload;
}

// ---------------------------------------------------------------------------
// End of window: compile roster-checked result, post the log, finalize doc.
// ---------------------------------------------------------------------------
async function endCapture(client, capture) {
  if (capture.endTimer) { clearTimeout(capture.endTimer); capture.endTimer = null; }
  activeCaptures.delete(capture.captureId);

  const { rosterAvailable, result } = await compileResult(capture);
  const payload = buildLog(capture, result, rosterAvailable);

  let postedMessageId = null;
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel?.isTextBased?.()) {
      const msg = await channel.send(payload);
      postedMessageId = msg?.id || null;
    } else {
      console.warn(`[gvg/capture] Log channel ${LOG_CHANNEL_ID} is not a text channel — attendance not posted (still persisted).`);
    }
  } catch (err) {
    console.warn(`[gvg/capture] Could not post attendance log to ${LOG_CHANNEL_ID} (check View/Send/Embed/Attach perms):`, err?.message || err);
  }

  await db.completeCapture(capture.captureId, { rosterAvailable, result, postedMessageId });
  console.log(`[gvg/capture] Window CLOSED — ${capture.schedule.day} ${capture.schedule.time} ${GVG_TZ_LABEL}; ${result.reduce((n, v) => n + v.count, 0)} attendance rows, posted=${Boolean(postedMessageId)}.`);
}

// ---------------------------------------------------------------------------
// resume(client) — boot recovery for in_progress captures. Reloads the
// collected member sets, RE-SNAPSHOTS current VC occupants (anyone who joined
// while the bot was down still counts, first-seen = resume time), then either
// finalizes immediately (window already over) or re-arms the end timer for
// the remaining time and keeps tracking. Never throws to the boot path.
// ---------------------------------------------------------------------------
async function resume(client) {
  let docs = [];
  try {
    docs = await db.getInProgressCaptures();
  } catch (err) {
    console.warn('[gvg/capture] Resume scan failed:', err?.message || err);
    return 0;
  }

  for (const doc of docs) {
    try {
      const capture = {
        captureId: String(doc._id),
        schedule: doc.schedule,
        guildId: doc.guildId || null,
        startedAt: new Date(doc.startedAt),
        endsAt: new Date(doc.endsAt),
        vcs: doc.vcs || [],
        vcIndex: new Map((doc.vcs || []).map(v => [v.channelId, v])),
        members: new Map((doc.vcs || []).map(v => {
          const stored = (doc.members || {})[v.channelId] || {};
          return [v.channelId, new Map(Object.entries(stored).map(([uid, rec]) => [uid, {
            ...rec,
            firstSeenAt: new Date(rec.firstSeenAt),
            lastSeenAt: new Date(rec.lastSeenAt),
          }]))];
        })),
        endTimer: null,
      };

      if (capture.endsAt.getTime() <= Date.now()) {
        // Window ended while the bot was down — finalize with what was collected.
        console.log(`[gvg/capture] Resuming capture ${capture.captureId}: window already over → finalizing now.`);
        await endCapture(client, capture);
      } else {
        activeCaptures.set(capture.captureId, capture);
        await snapshotVcs(client, capture); // catch joins missed during downtime
        armEndTimer(client, capture);
        const remainMin = Math.round((capture.endsAt.getTime() - Date.now()) / 60000);
        console.log(`[gvg/capture] Resumed capture ${capture.captureId}: ~${remainMin} min remaining, ${countUnique(capture)} collected so far.`);
      }
    } catch (err) {
      console.warn(`[gvg/capture] Failed to resume capture ${doc?._id}:`, err?.message || err);
    }
  }
  return docs.length;
}

module.exports = {
  hasActiveCaptures,
  startCapture,
  handleVoiceStateUpdate,
  endCapture,
  resume,
  // exported for synthetic tests
  buildLog,
  compileResult,
  snapshotVcs,
  _activeCapturesForTests: activeCaptures,
};
