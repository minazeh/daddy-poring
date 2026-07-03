// ---------------------------------------------------------------------------
// Activity-campaign sticky engine + ISO-week helper.
//
// "Sticky" mechanism: Discord can't pin a message to the BOTTOM of a channel,
// so the bot fakes it — whenever a (non-bot) message lands in the campaign
// channel, the bot deletes its previous prompt and reposts a fresh one so the
// prompt stays the newest message. Reposts are debounced (REPOST_COOLDOWN_MS):
// a chat burst inside the window collapses into one trailing repost when the
// window closes, and a repost is skipped entirely if the prompt is already the
// newest message.
//
// State model: MongoDB (activitycampaign_config) is the source of truth; a
// small in-memory mirror (`cache`) makes the per-message hot path free of DB
// reads. The cache is populated on ready (resume) and on every start/stop/
// repost, so it survives restarts via the DB, not via memory.
//
// Deleting the bot's OWN previous prompt message is the feature working as
// designed (needs no Manage Messages permission — bots can always delete
// their own messages).
// ---------------------------------------------------------------------------

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('./db');
const {
  IDS,
  PROMPT_TEXT,
  BUTTON_YES_LABEL,
  BUTTON_NO_LABEL,
  REPOST_COOLDOWN_MS,
  WEEK_TZ_OFFSET_HOURS,
} = require('./constants');

// ---------------------------------------------------------------------------
// ISO-week key. The week rolls at MONDAY 00:00 in the campaign timezone
// (WEEK_TZ_OFFSET_HOURS — GMT+8 for the SEA server), NOT UTC: we shift the
// instant by the offset, then ISO-week it with UTC math so the Monday-start
// boundary lands at Monday 00:00 GMT+8 (= Sunday 16:00 UTC).
//
// Format: `2026-W29`. ISO-8601: weeks start Monday; week 1 is the week
// containing the year's first Thursday — so Jan 1–3 can belong to the previous
// ISO year's W52/W53 and Dec 29–31 to the next year's W01. The offset is fixed
// (no DST — GMT+8 has none) so the boundary never drifts.
// ---------------------------------------------------------------------------
function weekKeyForDate(d = new Date()) {
  // Shift into the campaign timezone, then read UTC fields = local wall clock.
  const shifted = new Date(d.getTime() + WEEK_TZ_OFFSET_HOURS * 3_600_000);
  // Work on a UTC-midnight copy of the local date so time-of-day never matters.
  const date = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
  const day = date.getUTCDay() || 7;              // Mon=1 … Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day);   // shift to this week's Thursday
  const isoYear = date.getUTCFullYear();          // Thursday's year = ISO year
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// The prompt payload — plain message content + one row of two buttons.
// Deliberately NOT an embed (Conrad's call: lightweight, non-intrusive).
// `promptText` is the body typed at /start (persisted in config); the
// PROMPT_TEXT constant is only a fallback if a stored value is ever absent.
// ---------------------------------------------------------------------------
function buildPromptMessage(promptText) {
  const content = (typeof promptText === 'string' && promptText.trim())
    ? promptText
    : PROMPT_TEXT;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.YES)
      .setLabel(BUTTON_YES_LABEL)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(IDS.NO)
      .setLabel(BUTTON_NO_LABEL)
      .setStyle(ButtonStyle.Secondary),
  );
  return { content, components: [row] };
}

// ---------------------------------------------------------------------------
// In-memory mirror of the config doc + repost bookkeeping.
// ---------------------------------------------------------------------------
let cache = { active: false, channelId: null, stickyMessageId: null, promptText: null };

let lastRepostAt = 0;      // Date.now() of the last repost attempt
let reposting = false;     // single-writer guard (race safety)
let pendingTimer = null;   // trailing debounce timer

function clearPendingTimer() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

// Test hook — resets module state between synthetic test cases.
function _resetStickyStateForTests() {
  cache = { active: false, channelId: null, stickyMessageId: null, promptText: null };
  lastRepostAt = 0;
  reposting = false;
  clearPendingTimer();
}

// Best-effort delete of one of the bot's own messages. Every failure mode
// (message already gone, channel deleted, no access) is non-fatal.
async function deleteMessageBestEffort(client, channelId, messageId) {
  if (!channelId || !messageId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) return;
    await channel.messages.delete(messageId);
  } catch { /* already gone / no access — ignore */ }
}

// ---------------------------------------------------------------------------
// Repost core. Posts a fresh prompt, records its id (DB + cache), then removes
// the old one. Post-first so the channel never sits promptless if the send
// fails. `reposting` guarantees a single writer; the post-completion check
// schedules a catch-up if chat outran us mid-repost.
// ---------------------------------------------------------------------------
async function repost(channel) {
  if (reposting) return;
  if (!cache.active || channel.id !== cache.channelId) return; // stopped/moved meanwhile
  // Skip if the prompt is already the newest message (nothing pushed it up —
  // e.g. a trailing debounce fired after an earlier repost already ran).
  if (cache.stickyMessageId && channel.lastMessageId === cache.stickyMessageId) return;

  reposting = true;
  lastRepostAt = Date.now();
  const oldId = cache.stickyMessageId;
  try {
    const msg = await channel.send(buildPromptMessage(cache.promptText));
    cache.stickyMessageId = msg.id;
    await db.setStickyMessageId(msg.id);
    await deleteMessageBestEffort(channel.client, channel.id, oldId);
  } catch (err) {
    console.warn('[activitycampaign/sticky] Repost failed (will retry on next trigger):', err?.message || err);
  } finally {
    reposting = false;
  }

  // Catch-up: if a message landed while we were sending, the prompt is no
  // longer newest and no other trigger is coming for it — schedule a trailing
  // repost (lands after the cooldown).
  if (
    cache.active &&
    channel.id === cache.channelId &&
    cache.stickyMessageId &&
    channel.lastMessageId !== cache.stickyMessageId
  ) {
    scheduleRepost(channel);
  }
}

// Debounce gate: immediate repost when the cooldown has elapsed, otherwise one
// trailing repost when the window closes (never more than one timer pending).
function scheduleRepost(channel) {
  const elapsed = Date.now() - lastRepostAt;
  if (elapsed >= REPOST_COOLDOWN_MS) {
    void repost(channel);
    return;
  }
  if (pendingTimer) return; // trailing repost already queued
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void repost(channel);
  }, REPOST_COOLDOWN_MS - elapsed);
  // Never keep the process alive just for a sticky repost.
  if (typeof pendingTimer.unref === 'function') pendingTimer.unref();
}

// ---------------------------------------------------------------------------
// messageCreate hook (called ADDITIVELY from events/messageCreate.js). Cheap:
// pure in-memory checks for the 99% of messages that aren't in the campaign
// channel; never throws (caller also guards).
// ---------------------------------------------------------------------------
function onMessage(message) {
  if (!cache.active || !cache.channelId) return;
  if (message.channelId !== cache.channelId) return;
  if (message.author?.bot) return; // caller filters too — belt and suspenders
  if (!db.isReady()) return;       // degraded: skip reposting entirely
  scheduleRepost(message.channel);
}

// ---------------------------------------------------------------------------
// Command surface.
// ---------------------------------------------------------------------------

// Start (or MOVE) the campaign into `channel` with `promptText` (the body typed
// in the /start modal). Deletes the previous sticky wherever it was, activates
// the config with the new text, posts the prompt, records its id. Returns
// { moved, previousChannelId } so the command can word its confirm.
async function start(channel, promptText) {
  // Snapshot the previous state BEFORE any writes — never rely on the fetched
  // doc after db.activate() has run.
  const prev = await db.getConfig();
  const prevActive = Boolean(prev?.active);
  const prevChannelId = prev?.channelId ?? null;
  const prevStickyMessageId = prev?.stickyMessageId ?? null;
  const moved = Boolean(prevActive && prevChannelId && prevChannelId !== channel.id);

  // Remove the old prompt (same channel or old channel — a fresh one is
  // posted below either way).
  if (prevActive && prevStickyMessageId) {
    await deleteMessageBestEffort(channel.client, prevChannelId, prevStickyMessageId);
  }

  await db.activate(channel.guildId, channel.id, promptText);
  cache = { active: true, channelId: channel.id, stickyMessageId: null, promptText };
  clearPendingTimer();
  lastRepostAt = 0;

  const msg = await channel.send(buildPromptMessage(promptText));
  cache.stickyMessageId = msg.id;
  await db.setStickyMessageId(msg.id);

  return { moved, previousChannelId: moved ? prevChannelId : null };
}

// Stop the campaign: delete the current sticky, mark inactive. Returns true
// if there was an active campaign to stop.
async function stop(client) {
  const cfg = await db.getConfig();
  clearPendingTimer();
  if (!cfg?.active) {
    cache = { active: false, channelId: null, stickyMessageId: null, promptText: null };
    return false;
  }
  await deleteMessageBestEffort(client, cfg.channelId, cfg.stickyMessageId);
  await db.deactivate();
  cache = { active: false, channelId: null, stickyMessageId: null, promptText: null };
  return true;
}

// ready.js hook: rebuild the in-memory mirror from the DB and, if a campaign
// is active, immediately repost the prompt so it's visible right after a
// restart (the pre-restart sticky is deleted best-effort). Never throws.
async function resume(client) {
  try {
    const cfg = await db.getConfig();
    if (!cfg?.active || !cfg.channelId) {
      cache = { active: false, channelId: null, stickyMessageId: null, promptText: null };
      return false;
    }
    cache = {
      active: true,
      channelId: cfg.channelId,
      stickyMessageId: cfg.stickyMessageId ?? null,
      promptText: cfg.promptText ?? null,
    };

    const channel = await client.channels.fetch(cfg.channelId);
    if (!channel?.isTextBased?.()) {
      console.warn('[activitycampaign/sticky] Resume: campaign channel missing or not text-based — sticky paused until /activitycampaign start.');
      return false;
    }
    await deleteMessageBestEffort(client, cfg.channelId, cfg.stickyMessageId);
    const msg = await channel.send(buildPromptMessage(cfg.promptText));
    cache.stickyMessageId = msg.id;
    await db.setStickyMessageId(msg.id);
    console.log(`[activitycampaign/sticky] Resumed active campaign in #${channel.name ?? cfg.channelId} — sticky reposted.`);
    return true;
  } catch (err) {
    console.warn('[activitycampaign/sticky] Resume failed (campaign stays active; sticky retries on next message):', err?.message || err);
    return false;
  }
}

module.exports = {
  weekKeyForDate,
  buildPromptMessage,
  onMessage,
  start,
  stop,
  resume,
  // exported for tests / simulation
  _resetStickyStateForTests,
};
