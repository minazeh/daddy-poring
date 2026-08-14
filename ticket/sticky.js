// ---------------------------------------------------------------------------
// Per-ticket sticky engine.
//
// Same mechanism as activitycampaign/sticky.js: Discord can't pin a message to
// the BOTTOM of a channel, so the bot fakes it — whenever a (non-bot) message
// lands in a ticket channel, the bot posts a fresh sticky and deletes its
// previous one so the Mark-as-Resolved button stays the newest message.
// Reposts are debounced, and skipped entirely when the sticky is already newest.
//
// THE MATERIAL DIFFERENCE FROM THE CAMPAIGN ENGINE: that one tracks a single
// channel in one cache object. This tracks N open tickets at once, so the cache
// is a Map keyed by channel id with PER-CHANNEL debounce state — one busy
// ticket must not starve or stall another. The messageCreate hook is therefore
// a single Map.has(), which is free for the 99% of messages that are not in a
// ticket channel.
//
// RESTART SAFETY: the Map is a CACHE, NOT THE SOURCE OF TRUTH. Every entry is
// reconstructible from the tickets collection, and resume() rebuilds it on
// ready. Losing the process loses nothing.
//
// Deleting the bot's OWN previous sticky needs no Manage Messages permission —
// bots can always delete their own messages.
// ---------------------------------------------------------------------------

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('./db');
const { IDS, STICKY_TEXT, STICKY_BUTTON_LABEL, REPOST_COOLDOWN_MS } = require('./constants');

// channelId -> { ticketId, stickyMessageId, lastRepostAt, reposting, timer }
const watched = new Map();

// ---------------------------------------------------------------------------
// The sticky payload. Plain content + one button — deliberately not an embed,
// so it stays visually quiet at the bottom of a conversation.
//
// The ticket id rides in the customId, so a sticky posted before a restart is
// fully actionable after it with no memory of having posted it.
// ---------------------------------------------------------------------------
function buildStickyMessage(ticketId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.RESOLVE}:${ticketId}`)
      .setLabel(STICKY_BUTTON_LABEL)
      .setStyle(ButtonStyle.Success),
  );
  return { content: STICKY_TEXT, components: [row] };
}

// The terminal notice that replaces the sticky once a ticket is resolved.
function buildResolvedNotice(resolverName) {
  return {
    content:
      `✅ **This ticket was marked resolved by ${resolverName}.**\n` +
      'The conversation has been saved to the transcript archive. This channel is now read-only ' +
      'and will be removed shortly.',
    components: [],
  };
}

function clearTimer(entry) {
  if (entry?.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

// Best-effort delete of one of the bot's own messages.
async function deleteMessageBestEffort(client, channelId, messageId) {
  if (!channelId || !messageId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) return;
    await channel.messages.delete(messageId);
  } catch { /* already gone / no access — ignore */ }
}

// ---------------------------------------------------------------------------
// Repost core. Post-first, then delete the old one, so the channel never sits
// without a resolve button if the send fails. `reposting` guarantees a single
// writer per channel; the post-completion check schedules a catch-up if chat
// outran us mid-repost.
// ---------------------------------------------------------------------------
async function repost(channel) {
  const entry = watched.get(channel.id);
  if (!entry || entry.reposting) return;
  // Already newest — nothing pushed it up (e.g. a trailing debounce firing
  // after an earlier repost already ran).
  if (entry.stickyMessageId && channel.lastMessageId === entry.stickyMessageId) return;

  entry.reposting = true;
  entry.lastRepostAt = Date.now();
  const oldId = entry.stickyMessageId;

  try {
    const msg = await channel.send(buildStickyMessage(entry.ticketId));
    entry.stickyMessageId = msg.id;
    await db.setStickyMessageId(entry.ticketId, msg.id);
    await deleteMessageBestEffort(channel.client, channel.id, oldId);
  } catch (err) {
    console.warn(`[ticket/sticky] Repost failed in ${channel.id} (retries on next message):`, err?.message || err);
  } finally {
    entry.reposting = false;
  }

  // Catch-up: a message landed while we were sending, so the sticky is no
  // longer newest and no other trigger is coming for it.
  if (
    watched.has(channel.id) &&
    entry.stickyMessageId &&
    channel.lastMessageId !== entry.stickyMessageId
  ) {
    scheduleRepost(channel);
  }
}

// Debounce gate: immediate when the cooldown has elapsed, otherwise one
// trailing repost when the window closes. Never more than one timer per channel.
function scheduleRepost(channel) {
  const entry = watched.get(channel.id);
  if (!entry) return;

  const elapsed = Date.now() - entry.lastRepostAt;
  if (elapsed >= REPOST_COOLDOWN_MS) {
    void repost(channel);
    return;
  }
  if (entry.timer) return; // trailing repost already queued
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void repost(channel);
  }, REPOST_COOLDOWN_MS - elapsed);
  // Never keep the process alive just for a sticky repost.
  if (typeof entry.timer.unref === 'function') entry.timer.unref();
}

// ---------------------------------------------------------------------------
// messageCreate hook — called ADDITIVELY from events/messageCreate.js.
// Cheap: one Map lookup for the overwhelming majority of messages. Never throws
// (the caller also guards).
// ---------------------------------------------------------------------------
function onMessage(message) {
  if (watched.size === 0) return;
  if (!watched.has(message.channelId)) return;
  if (message.author?.bot) return;   // caller filters too — belt and suspenders
  if (!db.isReady()) return;         // degraded: skip reposting entirely
  scheduleRepost(message.channel);
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

// Start watching a freshly created ticket channel and post the first sticky.
async function start(channel, ticketId) {
  watched.set(channel.id, {
    ticketId,
    stickyMessageId: null,
    lastRepostAt: 0,
    reposting: false,
    timer: null,
  });

  const msg = await channel.send(buildStickyMessage(ticketId));
  const entry = watched.get(channel.id);
  if (entry) entry.stickyMessageId = msg.id;
  await db.setStickyMessageId(ticketId, msg.id);
  return msg;
}

// Stop watching a channel and replace the sticky with the terminal notice.
// Best-effort: this runs after the transcript is already safely posted.
async function finish(channel, ticket, resolverName) {
  const entry = watched.get(channel.id);
  clearTimer(entry);
  watched.delete(channel.id);

  const oldId = entry?.stickyMessageId ?? ticket.stickyMessageId ?? null;
  try {
    await channel.send(buildResolvedNotice(resolverName));
    await deleteMessageBestEffort(channel.client, channel.id, oldId);
  } catch (err) {
    console.warn(`[ticket/sticky] Could not post resolved notice in ${channel.id}:`, err?.message || err);
  }
}

// Drop a channel from the watch set without touching Discord — used when the
// channel has been deleted out from under us.
function forget(channelId) {
  const entry = watched.get(channelId);
  clearTimer(entry);
  watched.delete(channelId);
}

// ---------------------------------------------------------------------------
// ready.js hook. Rebuilds the watch Map from Mongo — the Map is a cache, so
// this is the ONLY thing standing between a restart and a dead resolve button.
//
// For each accepted ticket: if the channel is gone, mark the ticket orphaned
// (rather than retrying forever); otherwise re-watch it and repost the sticky
// so it sits at the bottom after downtime. Never throws.
// ---------------------------------------------------------------------------
async function resume(client) {
  try {
    const tickets = await db.listAcceptedTickets();
    let restored = 0;
    let orphaned = 0;

    for (const ticket of tickets) {
      if (!ticket.channelId) {
        await db.markOrphaned(ticket._id);
        orphaned++;
        continue;
      }

      let channel = null;
      try {
        channel = await client.channels.fetch(ticket.channelId);
      } catch { /* fetch failed — treated as gone below */ }

      if (!channel?.isTextBased?.()) {
        await db.markOrphaned(ticket._id);
        orphaned++;
        console.warn(`[ticket/sticky] Resume: channel for ${ticket._id} is gone — marked orphaned.`);
        continue;
      }

      watched.set(channel.id, {
        ticketId: ticket._id,
        stickyMessageId: ticket.stickyMessageId ?? null,
        lastRepostAt: 0,
        reposting: false,
        timer: null,
      });

      // Repost so the button is at the bottom again after downtime. The old
      // sticky (if any) is deleted by repost()'s post-then-delete sequence.
      try {
        await repost(channel);
      } catch (err) {
        console.warn(`[ticket/sticky] Resume repost failed for ${ticket._id}:`, err?.message || err);
      }
      restored++;
    }

    if (restored || orphaned) {
      console.log(`[ticket/sticky] Resumed ${restored} open ticket channel(s); ${orphaned} orphaned.`);
    }
    return restored;
  } catch (err) {
    console.warn('[ticket/sticky] Resume failed (stickies retry on next message):', err?.message || err);
    return 0;
  }
}

// Test hook — resets module state between synthetic cases.
function _resetForTests() {
  for (const entry of watched.values()) clearTimer(entry);
  watched.clear();
}

module.exports = {
  buildStickyMessage,
  buildResolvedNotice,
  onMessage,
  start,
  finish,
  forget,
  resume,
  _resetForTests,
  _watched: watched,
};
