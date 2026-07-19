// ---------------------------------------------------------------------------
// Guild Event Reminder engine (Phase 1).
//
// A silent, self-bumping reminder sticky that appears 2 h before each scheduled
// Guild Event in Channel A (REMINDER_CHANNEL_ID) with "Let's go! / Can't make
// it" buttons, and is taken down at event start. User-facing copy always says
// "Guild Event", never "GvG".
//
// Modeled on activitycampaign/sticky.js — same repost-on-messageCreate +
// debounce + Mongo-state-as-source-of-truth pattern — but generalized from a
// single always-on global sticky to a SET of time-bounded, PER-OCCURRENCE
// stickies. Multiple concurrent reminders coexist in Channel A, each keyed by
// its occurrenceKey and each bumping independently on new chat.
//
// Division of labour with gvg/scheduler.js:
//   - scheduler owns the TIMERS: it fires onReminderStart at max(now, event−2h)
//     and onTakedown at event start, and re-arms both weekly (restart-safe via
//     armAll on boot).
//   - THIS module owns the STICKY (post/repost/delete), the in-memory RSVP map,
//     and the Mongo reminder state (gvg_reminders) that lets a sticky + its
//     take-down survive a restart.
//
// Deleting the bot's OWN prior sticky needs no Manage Messages permission.
//
// RSVP recording (Phase 1) is IN-MEMORY ONLY — no per-press DB write. The
// batched sync + tally live in Phase 2; the seams are marked below.
// ---------------------------------------------------------------------------

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const db = require('./db');
const rosterDb = require('../roster/db');
const capture = require('./capture'); // paginator primitives (limit math) — reused, not re-derived
const {
  REMINDER_CHANNEL_ID,
  TALLY_CHANNEL_ID,
  GVG_TZ_OFFSET_HOURS,
  GVG_TZ_LABEL,
  REMINDER_LEAD_MS,
  REMINDER_REPOST_COOLDOWN_MS,
  REMINDER_SYNC_INTERVAL_MS,
  RSVP_ID_PREFIX,
  RSVP_YES_LABEL,
  RSVP_NO_LABEL,
  RSVP_ACK_YES,
  RSVP_ACK_NO,
  RSVP_ACK_ERR,
  GUILD_LABELS,
  MAX_NAME_LINE_CHARS,
  MAX_EMBEDS_PER_MESSAGE,
} = require('./constants');

// ---------------------------------------------------------------------------
// Occurrence identity — `<scheduleId>:<YYYYMMDD in GMT+7>`. The date is the
// event's wall-clock date in the GvG timezone, so each week & each event is a
// fresh key (last week's answers never bleed in; no cleanup job needed).
// ---------------------------------------------------------------------------
function ymdInGvgTz(date) {
  const shifted = new Date(date.getTime() + GVG_TZ_OFFSET_HOURS * 3_600_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function occurrenceKeyFor(scheduleId, eventAt) {
  return `${String(scheduleId)}:${ymdInGvgTz(new Date(eventAt))}`;
}

// Display label for the copy — the schedule's friendly name, else its slot.
// Never contains "GvG" (user-facing rule).
function labelForSchedule(schedule) {
  return schedule.label || `${schedule.day} ${schedule.time} ${GVG_TZ_LABEL}`;
}

// ---------------------------------------------------------------------------
// In-memory state.
//   active : occurrenceKey → occ (one entry per reminder currently showing).
//     occ = { occurrenceKey, scheduleId, label, guild, eventAt(Date),
//             channelId, stickyMessageId,
//             lastRepostAt, reposting, pendingTimer,
//             tallyMessageId, tallySig }   (repost bookkeeping is per-occurrence
//     so concurrent stickies debounce independently. tallyMessageId + tallySig
//     are Phase-2 live-tally state — see the tally section below.)
//   rsvps : occurrenceKey → Map<userId, { response, guild, displayName }>.
//     Kept SEPARATE from `active` so a press still records even if the occ
//     isn't in memory (e.g. mid-restart) — nothing is lost on a repost.
//   dirty : Set<occurrenceKey> — occurrences with un-flushed presses. route()
//     adds; the sync loop drains. An occurrence not in `dirty` writes NOTHING.
// ---------------------------------------------------------------------------
const active = new Map();
const rsvps = new Map();
const dirty = new Set();

// The client is threaded into every scheduler/message hook, but the sync loop
// and finalFlush (stub signature is (occurrenceKey)) have no client param — so
// we stash the latest one whenever a hook runs. .fetch() is all the tally needs.
let botClient = null;

// The single module-level batched-sync interval (Phase 2). Lazily started on
// the first reminder posted / on resume; .unref()d so it never holds the
// process open; left running thereafter (cheap — it no-ops when `dirty` empty).
let syncTimer = null;

// Test hook — reset module state between synthetic cases.
function _resetForTests() {
  for (const occ of active.values()) {
    if (occ.pendingTimer) { clearTimeout(occ.pendingTimer); occ.pendingTimer = null; }
  }
  active.clear();
  rsvps.clear();
  dirty.clear();
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  botClient = null;
}

// ---------------------------------------------------------------------------
// Message payload — silent plain-text content + one row of two buttons. NOT an
// embed (this is a lightweight, non-intrusive reminder). allowedMentions is
// applied by the caller on send so it can never ping.
// ---------------------------------------------------------------------------
function buildReminderMessage(occ) {
  const unix = Math.floor(new Date(occ.eventAt).getTime() / 1000);
  const content =
    `⚔️ **Adventurers!** Guild Event **${occ.label}** kicks off ` +
    `<t:${unix}:R> (<t:${unix}:F>). Are you in?`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RSVP_ID_PREFIX}:yes:${occ.occurrenceKey}`)
      .setLabel(RSVP_YES_LABEL)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${RSVP_ID_PREFIX}:no:${occ.occurrenceKey}`)
      .setLabel(RSVP_NO_LABEL)
      .setStyle(ButtonStyle.Secondary),
  );
  return { content, components: [row], allowedMentions: { parse: [] } };
}

// Best-effort delete of one of the bot's own messages (mirror the campaign).
async function deleteMessageBestEffort(client, channelId, messageId) {
  if (!channelId || !messageId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) return;
    await channel.messages.delete(messageId);
  } catch { /* already gone / no access — ignore */ }
}

// ===========================================================================
// Phase 2 — batched sync to gvg_attendance_intent + the live tally (Channel B).
// ===========================================================================

// scheduleId is the ObjectId hex before the first ':' (occurrenceKey =
// `<scheduleId>:<YYYYMMDD>`; neither part contains another ':').
function scheduleIdFromKey(occurrenceKey) {
  const i = occurrenceKey.indexOf(':');
  return i < 0 ? occurrenceKey : occurrenceKey.slice(0, i);
}

// Resolve an occurrence's metadata (label, guild, eventAt, tallyMessageId) —
// from memory when active, else from its Mongo reminder doc (active OR
// inactive). Returns null if unknown / store down.
async function occMetaFor(occurrenceKey) {
  const live = active.get(occurrenceKey);
  if (live) return live;
  try {
    const doc = await db.getReminder(occurrenceKey);
    if (!doc) return null;
    return {
      occurrenceKey,
      scheduleId: doc.scheduleId,
      label: doc.label,
      guild: doc.guild || 'both',
      eventAt: new Date(doc.eventAt),
      tallyMessageId: doc.tallyMessageId ?? null,
      tallySig: undefined,
      _detached: true, // not the live `active` occ — don't cache sig back
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Batched intent flush — coalesce an occurrence's in-memory RSVPs into ONE
// bulkWrite upsert. Writes only "on-roster" responders (guild resolved):
//   - guild 'daddy'/'mummy' → stored as-is.
//   - guild 'both'          → stored under 'daddy' (the §3 schema is a single
//     guild + a unique (occurrenceKey,userId) key, so one doc per member; the
//     in-memory tally still counts a 'both' member under BOTH sections).
//   - guild null (roster down / not on roster) → OMITTED from the intent (the
//     web-app party builder renders from the roster, so a non-roster responder
//     has no pool member to grey; they still appear in the bot tally).
// Never throws. Does NOT drop memory (members can still change until start).
// ---------------------------------------------------------------------------
async function flushIntent(occurrenceKey) {
  if (!db.isReady()) return false;
  const byUser = rsvps.get(occurrenceKey);
  if (!byUser || byUser.size === 0) return false;

  const meta = await occMetaFor(occurrenceKey);
  const eventAt = meta ? new Date(meta.eventAt) : null;
  const scheduleId = meta?.scheduleId || scheduleIdFromKey(occurrenceKey);
  const now = new Date();

  const docs = [];
  for (const [userId, rec] of byUser) {
    let g = rec.guild;
    if (g === 'both') g = 'daddy';
    if (g !== 'daddy' && g !== 'mummy') continue; // null → omitted (see header)
    docs.push({
      occurrenceKey,
      scheduleId,
      guild: g,
      userId,
      displayName: rec.displayName,
      response: rec.response,
      eventAt,
      updatedAt: now,
    });
  }
  if (!docs.length) return false;
  await db.bulkUpsertAttendanceIntent(docs);
  return true;
}

// ---------------------------------------------------------------------------
// Tally rendering (Channel B) — embed + .txt, segregated Daddy / Mummy (§7).
// ---------------------------------------------------------------------------

// Slugify a label for the .txt filename (lowercase, non-alphanumerics → '-').
function slugify(label) {
  const s = String(label || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'event';
}

function tallyFileName(occ) {
  return `guild-event-${slugify(occ.label)}-${ymdInGvgTz(new Date(occ.eventAt))}.txt`;
}

// Bucket responders into sections per the schedule's guild scope (§7):
//   - single-guild event ('daddy'/'mummy'): ONE section; ALL responders fold in
//     (incl. null-guild / cross-guild presses — the event itself is single-guild).
//   - 'both': Daddy + Mummy sections; a 'both' responder lands in BOTH; a
//     null-guild responder goes to a small separate "Unlisted" section.
// Going = names collected for the .txt (embed shows count only); Can't = names
// shown inline in the embed. Both lists sorted for a stable, scannable tally.
function computeTallySections(occ, byUser) {
  const scope = occ.guild || 'both';
  const mk = () => ({ going: [], cant: [] });
  const daddy = mk(), mummy = mk(), unlisted = mk();
  const put = (bucket, rec) => {
    (rec.response === 'yes' ? bucket.going : bucket.cant).push(rec.displayName);
  };

  for (const rec of byUser.values()) {
    if (scope === 'daddy') { put(daddy, rec); continue; }
    if (scope === 'mummy') { put(mummy, rec); continue; }
    // scope 'both' → split by the responder's own affiliation.
    if (rec.guild === 'daddy') put(daddy, rec);
    else if (rec.guild === 'mummy') put(mummy, rec);
    else if (rec.guild === 'both') { put(daddy, rec); put(mummy, rec); }
    else put(unlisted, rec); // null → Unlisted
  }
  const sortBucket = (b) => {
    b.going.sort((a, c) => a.localeCompare(c));
    b.cant.sort((a, c) => a.localeCompare(c));
  };
  [daddy, mummy, unlisted].forEach(sortBucket);

  const sections = [];
  if (scope === 'daddy') sections.push({ key: 'daddy', label: 'Daddy', ...daddy });
  else if (scope === 'mummy') sections.push({ key: 'mummy', label: 'Mummy', ...mummy });
  else {
    sections.push({ key: 'daddy', label: 'Daddy', ...daddy });
    sections.push({ key: 'mummy', label: 'Mummy', ...mummy });
    if (unlisted.going.length || unlisted.cant.length) {
      sections.push({ key: 'unlisted', label: 'Unlisted', ...unlisted });
    }
  }
  return sections;
}

// A cheap signature of the RENDERED counts (+ finalized/removed flags) so a
// flush with no count change skips the edit (spec §6.2 "only when counts
// changed"). A yes↔no flip changes a count, so it's caught.
function tallySignature(sections, { finalized = false, removed = false } = {}) {
  const tag = removed ? 'R' : finalized ? 'F' : '-';
  return `${tag}|${sections.map(s => `${s.key}:${s.going.length}:${s.cant.length}`).join(',')}`;
}

// The complete segregated record (all Going + all Can't names per guild),
// refreshed on every flush and finalized at event start.
function buildTallyFile(occ, sections, { finalized = false, removed = false } = {}) {
  const status = removed ? 'EVENT REMOVED' : finalized ? 'FINAL (event started)' : 'live';
  const lines = [
    `Guild Event — ${occ.label}`,
    `Event start: ${new Date(occ.eventAt).toISOString()}`,
    `Status: ${status}`,
    '',
  ];
  for (const sec of sections) {
    lines.push(`== ${sec.label} — ${sec.going.length} going, ${sec.cant.length} can't ==`);
    lines.push(`-- Going (${sec.going.length}) --`);
    if (!sec.going.length) lines.push('  (none)');
    for (const n of sec.going) lines.push(`  [going] ${n}`);
    lines.push(`-- Can't make it (${sec.cant.length}) --`);
    if (!sec.cant.length) lines.push('  (none)');
    for (const n of sec.cant) lines.push(`  [can't] ${n}`);
    lines.push('');
  }
  return lines.join('\n');
}

// Build the tally message payload (embeds + .txt). REUSES capture.js's
// paginator (chunkNamesIntoFields + packFieldsIntoEmbeds) — no bespoke limit
// math. The "Can't" list paginates across fields/embeds; a hard guard caps at
// 10 embeds/message (the .txt always carries the complete record).
function buildTallyMessage(occ, sections, { finalized = false, removed = false } = {}) {
  const unix = Math.floor(new Date(occ.eventAt).getTime() / 1000);
  const color = removed ? 0xED4245 : 0x5865F2;

  const title = `${removed ? '⚠️ Event removed — ' : ''}Guild Event — ${occ.label}`.slice(0, MAX_NAME_LINE_CHARS);
  const descLines = [];
  if (removed) descLines.push('⚠️ **This event was removed.** Final tally retained below.');
  else if (finalized) descLines.push(`Kicked off <t:${unix}:R> — **final tally**.`);
  else descLines.push(`Kicks off <t:${unix}:R> (<t:${unix}:F>)`);
  descLines.push('');
  for (const sec of sections) {
    descLines.push(`**${sec.label}** — ✅ ${sec.going.length} going · 😔 ${sec.cant.length} can't`);
  }

  const summary = new EmbedBuilder()
    .setTitle(title)
    .setDescription(descLines.join('\n'))
    .setColor(color)
    .setFooter({ text: 'Full roster & party view in the app.' })
    .setTimestamp(new Date());

  // Per-section "Can't make it" name lists (inline). Going is count-only.
  const cantFields = [];
  for (const sec of sections) {
    if (!sec.cant.length) continue;
    const lines = sec.cant.map(n => String(n).slice(0, MAX_NAME_LINE_CHARS));
    const header = `😔 ${sec.label} — Can't make it (${sec.cant.length})`;
    const contHeader = `${sec.label} …(cont.)`;
    cantFields.push(...capture.chunkNamesIntoFields(header, contHeader, lines));
  }
  const contentEmbeds = capture.packFieldsIntoEmbeds(cantFields, { color });

  let embeds = [summary, ...contentEmbeds];
  if (embeds.length > MAX_EMBEDS_PER_MESSAGE) {
    // Beyond ~2000 can't-names (never at 400-scale) — keep the summary + as many
    // can't-embeds as fit; the .txt still holds the complete record.
    console.warn(`[gvg/reminder] Tally for ${occ.occurrenceKey} needs ${embeds.length} embeds (>10); truncating to fit — full record is in the .txt.`);
    embeds = embeds.slice(0, MAX_EMBEDS_PER_MESSAGE);
  }

  const fileText = buildTallyFile(occ, sections, { finalized, removed });
  const file = new AttachmentBuilder(Buffer.from(fileText, 'utf8'), { name: tallyFileName(occ) });
  return { embeds, file, fileText };
}

// ---------------------------------------------------------------------------
// refreshTally — post (first flush) or edit-in-place (later flushes) the
// occurrence's Channel-B tally. Skips the edit when counts are unchanged unless
// `finalized`/`removed` force it. New occurrence = new message (old ones are
// never touched). Never throws.
// ---------------------------------------------------------------------------
async function refreshTally(client, occurrenceKey, { finalized = false, removed = false } = {}) {
  client = client || botClient;
  if (!client) return false;
  if (!db.isReady()) return false; // need Mongo to persist the message id

  const occ = await occMetaFor(occurrenceKey);
  if (!occ) return false;

  const byUser = rsvps.get(occurrenceKey) || new Map();
  const sections = computeTallySections(occ, byUser);
  const sig = tallySignature(sections, { finalized, removed });

  const force = finalized || removed;
  if (!force && occ.tallyMessageId && occ.tallySig === sig) return false; // no change

  let channel;
  try {
    channel = await client.channels.fetch(TALLY_CHANNEL_ID);
  } catch {
    return false; // Channel B unreachable — retry next tick
  }
  if (!channel?.isTextBased?.()) {
    console.warn(`[gvg/reminder] Tally channel ${TALLY_CHANNEL_ID} missing or not text-based — tally not updated for ${occurrenceKey}.`);
    return false;
  }

  const { embeds, file } = buildTallyMessage(occ, sections, { finalized, removed });
  try {
    if (!occ.tallyMessageId) {
      const msg = await channel.send({ embeds, files: [file], allowedMentions: { parse: [] } });
      occ.tallyMessageId = msg.id;
      occ.tallySig = sig;
      await db.setReminderTallyMessageId(occurrenceKey, msg.id);
    } else {
      // Replace attachments (attachments:[] clears the old .txt) + re-upload.
      await channel.messages.edit(occ.tallyMessageId, {
        embeds, files: [file], attachments: [], allowedMentions: { parse: [] },
      });
      occ.tallySig = sig;
    }
  } catch (err) {
    // Edit target gone (message deleted) → repost once so the tally survives.
    console.warn(`[gvg/reminder] Tally ${occ.tallyMessageId ? 'edit' : 'post'} failed for ${occurrenceKey}:`, err?.message || err);
    if (occ.tallyMessageId) {
      try {
        const msg = await channel.send({ embeds, files: [file], allowedMentions: { parse: [] } });
        occ.tallyMessageId = msg.id;
        occ.tallySig = sig;
        await db.setReminderTallyMessageId(occurrenceKey, msg.id);
      } catch { /* degrade — retry next tick */ }
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The single batched-sync interval. Drains `dirty`: for each occurrence, one
// intent bulkWrite + one tally refresh. Re-queues on failure (keeps buffering).
// A press arriving during a tick re-adds the key → next tick picks it up.
// ---------------------------------------------------------------------------
async function syncTick() {
  if (dirty.size === 0) return;
  const keys = [...dirty];
  dirty.clear();
  for (const key of keys) {
    try {
      await flushIntent(key);
      await refreshTally(botClient, key, {});
    } catch (err) {
      console.warn('[gvg/reminder] Sync tick failed for', key, '-', err?.message || err);
      dirty.add(key); // retry next tick
    }
  }
}

function startSyncLoop(client) {
  if (client) botClient = client;
  if (syncTimer) return;
  syncTimer = setInterval(() => { void syncTick(); }, REMINDER_SYNC_INTERVAL_MS);
  if (typeof syncTimer.unref === 'function') syncTimer.unref();
  console.log(`[gvg/reminder] Batched sync loop started (${Math.round(REMINDER_SYNC_INTERVAL_MS / 1000)}s).`);
}

// ---------------------------------------------------------------------------
// finalFlush — the GUARANTEED catch-all (event start / take-down / delete /
// resume-of-an-ended-window). One final intent bulkWrite + a finalized tally,
// THEN it's safe to drop the occurrence from memory (the caller does that).
// This covers the <2h / short-window case where the 10s timer may never fire.
// Never throws.
// ---------------------------------------------------------------------------
async function finalFlush(occurrenceKey, client) {
  dirty.delete(occurrenceKey); // superseded by this final write
  try {
    await flushIntent(occurrenceKey);
  } catch (err) {
    console.warn('[gvg/reminder] finalFlush intent write failed:', err?.message || err);
  }
  try {
    await refreshTally(client || botClient, occurrenceKey, { finalized: true });
  } catch (err) {
    console.warn('[gvg/reminder] finalFlush tally refresh failed:', err?.message || err);
  }
  return true;
}

// ---------------------------------------------------------------------------
// annotateTallyRemoved — edit the occurrence's tally to "⚠️ Event removed" and
// RETAIN it (never delete). Called on delete-mid-window, after finalFlush.
// Never throws.
// ---------------------------------------------------------------------------
async function annotateTallyRemoved(occurrenceKey, client) {
  await refreshTally(client || botClient, occurrenceKey, { removed: true });
  return true;
}

// ---------------------------------------------------------------------------
// Post the sticky for an occurrence and record its message id (Mongo + memory).
// Post-first so the channel never sits promptless if a send fails; the old
// sticky (if any) is removed after.
// ---------------------------------------------------------------------------
async function postSticky(client, occ, oldStickyMessageId = null) {
  const channel = await client.channels.fetch(occ.channelId);
  if (!channel?.isTextBased?.()) {
    console.warn(`[gvg/reminder] Reminder channel ${occ.channelId} missing or not text-based — sticky not posted for ${occ.occurrenceKey}.`);
    return false;
  }
  const msg = await channel.send(buildReminderMessage(occ));
  occ.stickyMessageId = msg.id;
  await db.setReminderStickyMessageId(occ.occurrenceKey, msg.id);
  if (oldStickyMessageId && oldStickyMessageId !== msg.id) {
    await deleteMessageBestEffort(client, occ.channelId, oldStickyMessageId);
  }
  return true;
}

// ---------------------------------------------------------------------------
// scheduler hook — reminder-start (fires at max(now, event−2h)). Posts the
// sticky and registers the occurrence as active. IDEMPOTENT: if the occurrence
// is already active (resume re-posted it, or an immediate re-fire on boot),
// this is a no-op so we never double-post. Never throws.
// ---------------------------------------------------------------------------
async function onReminderStart(client, schedule, eventAt) {
  try {
    botClient = client;
    if (!db.isReady()) {
      console.warn('[gvg/reminder] Reminder-start skipped — store not ready.');
      return;
    }
    startSyncLoop(client); // lazy start — the batched sync/tally beat is now live
    const scheduleId = String(schedule._id);
    const occurrenceKey = occurrenceKeyFor(scheduleId, eventAt);

    // Already showing (resume / duplicate fire) — nothing to do.
    if (active.has(occurrenceKey)) return;

    const occ = {
      occurrenceKey,
      scheduleId,
      label: labelForSchedule(schedule),
      guild: schedule.guild || 'both',
      eventAt: new Date(eventAt),
      channelId: REMINDER_CHANNEL_ID,
      stickyMessageId: null,
      tallyMessageId: null,
      tallySig: undefined,
      lastRepostAt: 0,
      reposting: false,
      pendingTimer: null,
    };

    // Persist BEFORE posting so a crash mid-post still leaves a resumable doc.
    await db.upsertReminder({
      occurrenceKey,
      scheduleId,
      label: occ.label,
      guild: occ.guild,
      eventAt: occ.eventAt,
      channelId: occ.channelId,
      stickyMessageId: null,
    });
    active.set(occurrenceKey, occ);

    const posted = await postSticky(client, occ);
    if (posted) {
      console.log(`[gvg/reminder] Reminder UP — "${occ.label}" (${occurrenceKey}) → event ${occ.eventAt.toISOString()}.`);
    }
  } catch (err) {
    console.warn('[gvg/reminder] onReminderStart failed:', err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// scheduler hook — take-down (fires at event start). Deletes the sticky, fires
// the Phase-2 final flush, deactivates the Mongo doc, and clears memory. Never
// throws. `annotateRemoved` distinguishes a normal take-down (false) from a
// delete-mid-window removal (true → also annotate the tally).
// ---------------------------------------------------------------------------
async function takeDown(client, occurrenceKey, { annotateRemoved = false } = {}) {
  const occ = active.get(occurrenceKey);

  // Delete the sticky (from memory state, else fall back to the Mongo doc).
  let stickyMessageId = occ?.stickyMessageId ?? null;
  let channelId = occ?.channelId ?? REMINDER_CHANNEL_ID;
  if (!stickyMessageId) {
    try {
      const docs = await db.getActiveReminders();
      const doc = docs.find(d => d.occurrenceKey === occurrenceKey);
      if (doc) { stickyMessageId = doc.stickyMessageId; channelId = doc.channelId || channelId; }
    } catch { /* degrade — best-effort delete below just no-ops */ }
  }
  await deleteMessageBestEffort(client, channelId, stickyMessageId);

  // Guaranteed final flush (Phase 2) — do it BEFORE dropping memory. This is the
  // catch-all that makes the <2h/short-window case safe.
  try { await finalFlush(occurrenceKey, client); } catch (err) {
    console.warn('[gvg/reminder] finalFlush failed:', err?.message || err);
  }
  if (annotateRemoved) {
    try { await annotateTallyRemoved(occurrenceKey, client); } catch (err) {
      console.warn('[gvg/reminder] annotateTallyRemoved failed:', err?.message || err);
    }
  }

  // Deactivate the Mongo doc (retained, active:false) and clear memory.
  try { await db.deactivateReminder(occurrenceKey); } catch (err) {
    console.warn('[gvg/reminder] deactivateReminder failed:', err?.message || err);
  }
  if (occ?.pendingTimer) { clearTimeout(occ.pendingTimer); occ.pendingTimer = null; }
  active.delete(occurrenceKey);
  rsvps.delete(occurrenceKey);
}

async function onTakedown(client, schedule, eventAt) {
  try {
    const occurrenceKey = occurrenceKeyFor(String(schedule._id), eventAt);
    if (!active.has(occurrenceKey)) {
      // Nothing showing (e.g. reminder never posted, or DB was down) — still
      // best-effort clean up any lingering Mongo doc/sticky.
      const docs = await db.getActiveReminders().catch(() => []);
      if (!docs.some(d => d.occurrenceKey === occurrenceKey)) return;
    }
    await takeDown(client, occurrenceKey, { annotateRemoved: false });
    console.log(`[gvg/reminder] Reminder DOWN — ${occurrenceKey} (event start).`);
  } catch (err) {
    console.warn('[gvg/reminder] onTakedown failed:', err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Delete-mid-window (CRITICAL) — called by /gvgschedule remove for a schedule
// that may have an active reminder. Cancels via the sticky/take-down side:
// deletes the sticky, final-flushes, annotates the tally as removed, and clears
// state for EVERY active occurrence of that schedule. The scheduler's timers
// are cancelled separately by the command (scheduler.cancelSchedule). Never
// throws into the command path.
// ---------------------------------------------------------------------------
async function teardownForSchedule(client, scheduleId) {
  const id = String(scheduleId);
  try {
    const keys = [];
    for (const occ of active.values()) {
      if (occ.scheduleId === id) keys.push(occ.occurrenceKey);
    }
    // Also catch a doc that's active in Mongo but not in memory (e.g. store
    // recovered after the reminder posted but before this process saw it).
    try {
      const docs = await db.getActiveReminders();
      for (const doc of docs) {
        if (doc.scheduleId === id && !keys.includes(doc.occurrenceKey)) keys.push(doc.occurrenceKey);
      }
    } catch { /* degrade */ }

    for (const key of keys) {
      await takeDown(client, key, { annotateRemoved: true });
    }
    return keys.length;
  } catch (err) {
    console.warn('[gvg/reminder] teardownForSchedule failed (schedule removal continues):', err?.message || err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Sticky repost — per-occurrence, mirrors the campaign's post-first + debounce.
// ---------------------------------------------------------------------------
async function repost(client, occ, channel) {
  if (occ.reposting) return;
  if (!active.has(occ.occurrenceKey)) return; // taken down meanwhile
  // Skip if this sticky is already the newest message (nothing pushed it up).
  if (occ.stickyMessageId && channel.lastMessageId === occ.stickyMessageId) return;

  occ.reposting = true;
  occ.lastRepostAt = Date.now();
  const oldId = occ.stickyMessageId;
  try {
    await postSticky(client, occ, oldId);
  } catch (err) {
    console.warn(`[gvg/reminder] Repost failed for ${occ.occurrenceKey} (retries on next trigger):`, err?.message || err);
  } finally {
    occ.reposting = false;
  }

  // Catch-up: a message landed while we were sending → schedule a trailing repost.
  if (active.has(occ.occurrenceKey) && occ.stickyMessageId && channel.lastMessageId !== occ.stickyMessageId) {
    scheduleRepost(client, occ, channel);
  }
}

function scheduleRepost(client, occ, channel) {
  const elapsed = Date.now() - occ.lastRepostAt;
  if (elapsed >= REMINDER_REPOST_COOLDOWN_MS) {
    void repost(client, occ, channel);
    return;
  }
  if (occ.pendingTimer) return; // trailing repost already queued
  occ.pendingTimer = setTimeout(() => {
    occ.pendingTimer = null;
    void repost(client, occ, channel);
  }, REMINDER_REPOST_COOLDOWN_MS - elapsed);
  if (typeof occ.pendingTimer.unref === 'function') occ.pendingTimer.unref();
}

// ---------------------------------------------------------------------------
// messageCreate hook (called ADDITIVELY from events/messageCreate.js). Cheap:
// pure in-memory checks unless this is Channel A with ≥1 active reminder. Each
// active sticky bumps independently. Never throws (caller also guards).
// ---------------------------------------------------------------------------
function onMessage(message) {
  if (message?.client) botClient = message.client;
  if (active.size === 0) return;
  if (message.channelId !== REMINDER_CHANNEL_ID) return;
  if (message.author?.bot) return; // caller filters too — belt and suspenders
  if (!db.isReady()) return;       // degraded: skip reposting entirely
  for (const occ of active.values()) {
    if (occ.channelId !== message.channelId) continue;
    scheduleRepost(message.client, occ, message.channel);
  }
}

// ---------------------------------------------------------------------------
// RSVP button routing (gvgrsvp:<yes|no>:<occurrenceKey>). Returns true if this
// module owned the interaction (repo router convention). Ephemeral ack; the
// public sticky is never edited/replied-to publicly. NO DB write in Phase 1 —
// the response is held in memory only.
// ---------------------------------------------------------------------------
async function route(interaction) {
  if (!interaction.isButton?.()) return false;
  const id = interaction.customId || '';
  if (!id.startsWith(`${RSVP_ID_PREFIX}:`)) return false;

  // gvgrsvp:<response>:<occurrenceKey> — occurrenceKey itself contains a ':'
  // (scheduleId:YYYYMMDD), so re-join everything after the response token.
  const body = id.slice(`${RSVP_ID_PREFIX}:`.length);
  const firstColon = body.indexOf(':');
  if (firstColon < 0) return false;
  const response = body.slice(0, firstColon);
  const occurrenceKey = body.slice(firstColon + 1);
  if ((response !== 'yes' && response !== 'no') || !occurrenceKey) return false;

  try {
    const userId = interaction.user.id;
    const displayName =
      interaction.member?.displayName ??
      interaction.user.globalName ??
      interaction.user.username;

    // Guild affiliation from roster: isMain⇒daddy, isSub⇒mummy, both⇒both.
    // Read-only; degrades to null if roster is down / member not found.
    let guild = null;
    if (rosterDb.isReady?.()) {
      try {
        const member = await rosterDb.getMember(userId);
        const isMain = Boolean(member?.isMain);
        const isSub = Boolean(member?.isSub);
        if (isMain && isSub) guild = 'both';
        else if (isMain) guild = 'daddy';
        else if (isSub) guild = 'mummy';
      } catch (err) {
        console.warn('[gvg/reminder] Roster lookup failed for RSVP:', err?.message || err);
      }
    }

    // In-memory record — keyed occurrenceKey → userId. Re-press overwrites
    // (idempotent). Kept even if the occurrence isn't currently in `active`.
    let byUser = rsvps.get(occurrenceKey);
    if (!byUser) { byUser = new Map(); rsvps.set(occurrenceKey, byUser); }
    byUser.set(userId, { response, guild, displayName });

    // Mark dirty so the next sync tick flushes this occurrence (intent write +
    // tally refresh within ~REMINDER_SYNC_INTERVAL_MS). Ensure the loop is up
    // (belt-and-suspenders — normally started at reminder-start / resume).
    dirty.add(occurrenceKey);
    startSyncLoop(interaction.client);

    await interaction.reply({
      content: response === 'yes' ? RSVP_ACK_YES : RSVP_ACK_NO,
      ephemeral: true,
    });
  } catch (err) {
    console.warn('[gvg/reminder] Failed to record RSVP:', err?.message || err);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.reply({ content: RSVP_ACK_ERR, ephemeral: true }); } catch { /* ignore */ }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// resume(client) — boot recovery for active reminders (mirrors the campaign's
// resume + gvg/capture's "window already over → finalize now"). For each active
// Mongo doc:
//   - event already started while the bot was down → take it down now
//     (delete sticky + final flush + deactivate), so no stale sticky lingers.
//   - still in window → rebuild in-memory state, delete the pre-restart sticky,
//     and re-post a fresh one so it's visible again. onReminderStart then
//     no-ops for these (already active), avoiding a double post when armAll
//     immediately re-fires an in-window reminder-start timer.
// Never throws to the boot path.
// ---------------------------------------------------------------------------
async function resume(client) {
  botClient = client;
  let docs = [];
  try {
    docs = await db.getActiveReminders();
  } catch (err) {
    console.warn('[gvg/reminder] Resume scan failed:', err?.message || err);
    return 0;
  }

  // Lazy-start the batched sync loop on resume (spec §6.1) — even if the only
  // active reminders are mid-window, presses must flush without waiting for a
  // fresh reminder-start.
  if (docs.length) startSyncLoop(client);

  let restored = 0;
  for (const doc of docs) {
    try {
      const eventAt = new Date(doc.eventAt);
      if (eventAt.getTime() <= Date.now()) {
        // Window ended during downtime → final flush (intent + finalized tally)
        // then take it down (best-effort cleanup).
        await deleteMessageBestEffort(client, doc.channelId || REMINDER_CHANNEL_ID, doc.stickyMessageId);
        try { await finalFlush(doc.occurrenceKey, client); } catch { /* degrade */ }
        await db.deactivateReminder(doc.occurrenceKey).catch(() => {});
        console.log(`[gvg/reminder] Resume: "${doc.label}" (${doc.occurrenceKey}) already started → taken down.`);
        continue;
      }

      const occ = {
        occurrenceKey: doc.occurrenceKey,
        scheduleId: doc.scheduleId,
        label: doc.label,
        guild: doc.guild || 'both',
        eventAt,
        channelId: doc.channelId || REMINDER_CHANNEL_ID,
        stickyMessageId: doc.stickyMessageId ?? null,
        // Re-attach the persisted tally message so edits survive restart (no
        // duplicate post). tallySig is left undefined so the first post-restart
        // flush re-renders once (harmless) then settles.
        tallyMessageId: doc.tallyMessageId ?? null,
        tallySig: undefined,
        lastRepostAt: 0,
        reposting: false,
        pendingTimer: null,
      };
      active.set(occ.occurrenceKey, occ);
      // Re-post fresh (delete the pre-restart sticky), like the campaign.
      await postSticky(client, occ, doc.stickyMessageId);
      restored += 1;
      console.log(`[gvg/reminder] Resumed reminder "${occ.label}" (${occ.occurrenceKey}) — sticky reposted.`);
    } catch (err) {
      console.warn(`[gvg/reminder] Failed to resume reminder ${doc?.occurrenceKey}:`, err?.message || err);
    }
  }
  return restored;
}

module.exports = {
  occurrenceKeyFor,
  ymdInGvgTz,
  labelForSchedule,
  buildReminderMessage,
  onReminderStart,
  onTakedown,
  teardownForSchedule,
  onMessage,
  route,
  resume,
  // Phase 2 — batched sync + live tally
  finalFlush,
  annotateTallyRemoved,
  refreshTally,
  flushIntent,
  startSyncLoop,
  // exported for tests / simulation
  computeTallySections,
  tallySignature,
  buildTallyMessage,
  buildTallyFile,
  tallyFileName,
  syncTick,
  _active: active,
  _rsvps: rsvps,
  _dirty: dirty,
  _resetForTests,
};
