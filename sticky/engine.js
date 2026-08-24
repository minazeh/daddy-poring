// ---------------------------------------------------------------------------
// General-purpose sticky message engine.
//
// Same mechanism as ticket/sticky.js and activitycampaign/sticky.js: Discord
// cannot pin a message to the BOTTOM of a channel, so the bot fakes it —
// whenever a (non-bot) message lands in a watched channel, the bot posts a
// fresh copy of the sticky and deletes its previous one, so the sticky stays
// the newest message. Reposts are debounced, and skipped entirely when the
// sticky is already newest.
//
// MODELLED ON ticket/sticky.js, NOT activitycampaign/sticky.js. The campaign
// engine tracks a SINGLE channel in one cache object; this (like the ticket
// engine) tracks N channels at once, so the cache is a Map keyed by channel id
// with PER-CHANNEL debounce state — one busy channel must never starve or
// stall a quiet one. The messageCreate hook is therefore a single Map.has(),
// which is free for the overwhelming majority of messages in the server.
//
// RESTART SAFETY: the Map is a CACHE, NOT THE SOURCE OF TRUTH. Every entry is
// reconstructible from the sticky_messages collection, and sticky/resume.js
// rebuilds it on ready. Losing the process loses nothing.
//
// NO SELF-TRIGGER: the bot's own repost must never trigger another repost, or
// the engine spins forever against its own output. Three independent guards
// stand in the way, and the sim proves all three:
//   1. events/messageCreate.js returns on `message.author?.bot` before any
//      hook runs;
//   2. onMessage() below repeats that check (belt and braces, so a direct
//      caller cannot bypass it);
//   3. repost() skips when the sticky is ALREADY the newest message, which is
//      precisely the state its own send leaves the channel in.
//
// Deleting the bot's OWN previous sticky needs no Manage Messages permission —
// bots can always delete their own messages.
// ---------------------------------------------------------------------------

const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const {
  PLAIN_CONTENT_MAX,
  TITLE_MAX,
  DEFAULT_COLOR,
  REPOST_COOLDOWN_MS,
  ERR_UNKNOWN_CHANNEL,
} = require('./constants');

// channelId -> { guildId, content, title, color, stickyMessageId,
//                lastRepostAt, reposting, timer }
const watched = new Map();

// ---------------------------------------------------------------------------
// Colour input parsing.
//
// Invalid hex is NOT an error (spec §4.1) — it falls back to the house blurple
// and the confirmation says so. Accepts `#5865F2`, `5865F2`, `0x5865F2` and the
// 3-digit shorthand `#58F`. Anything else is a fallback, not a rejection.
// ---------------------------------------------------------------------------
const HEX_RE = /^(?:#|0x)?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseColorInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { color: null, supplied: false, invalid: false };

  const m = HEX_RE.exec(s);
  if (!m) return { color: null, supplied: true, invalid: true };

  let hex = m[1];
  // Expand the 3-digit shorthand: 58f -> 5588ff.
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return { color: parseInt(hex, 16), supplied: true, invalid: false };
}

// ---------------------------------------------------------------------------
// THE LENGTH TRAP (spec §4.1). Decides plain-vs-embed for one sticky.
//
//   no title, content <= 2000   -> plain text (markdown renders natively and it
//                                  stays visually quiet at the bottom of chat)
//   no title, content  > 2000   -> TITLELESS EMBED. A plain message caps at
//                                  2,000 but a modal Paragraph accepts 4,000,
//                                  so this content is UNPOSTABLE as plain text.
//                                  It is promoted, never refused and NEVER
//                                  TRUNCATED — 4,000 fits inside the 4,096
//                                  embed-description cap with room to spare.
//   title given                 -> embed, with the supplied colour or blurple.
//
// Pure function of the stored document — the same decision is reached on the
// first post and on every repost after any restart.
// ---------------------------------------------------------------------------
function formatFor({ content, title }) {
  const hasTitle = typeof title === 'string' && title.trim().length > 0;
  const len = String(content ?? '').length;
  if (hasTitle) return { mode: 'embed', hasTitle: true, promoted: false, length: len };
  if (len > PLAIN_CONTENT_MAX) return { mode: 'embed', hasTitle: false, promoted: true, length: len };
  return { mode: 'plain', hasTitle: false, promoted: false, length: len };
}

// ---------------------------------------------------------------------------
// The sticky payload.
//
// allowedMentions is EMPTY on purpose. A sticky reposts every time the channel
// is used; a live @everyone or role mention inside one would re-ping the server
// on every single repost. The mention still RENDERS in the text — it just never
// notifies. Nothing the officer typed is altered.
// ---------------------------------------------------------------------------
function buildStickyPayload(doc) {
  const fmt = formatFor(doc);
  const content = String(doc.content ?? '');

  if (fmt.mode === 'plain') {
    return { content, allowedMentions: { parse: [] } };
  }

  const embed = new EmbedBuilder()
    .setDescription(content)
    // Colour applies to embeds only; a titleless promotion gets the default
    // (spec §4: the colour field is "ignored unless a title is given").
    .setColor(fmt.hasTitle ? (doc.color ?? DEFAULT_COLOR) : DEFAULT_COLOR);

  if (fmt.hasTitle) embed.setTitle(String(doc.title).slice(0, TITLE_MAX));

  return { embeds: [embed], allowedMentions: { parse: [] } };
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

function clearTimer(entry) {
  if (entry?.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

// Best-effort delete of one of the bot's own messages. Every failure mode
// (already gone, channel deleted, no access) is non-fatal.
async function deleteMessageBestEffort(client, channelId, messageId) {
  if (!channelId || !messageId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) return;
    await channel.messages.delete(messageId);
  } catch { /* already gone / no access — ignore */ }
}

// Was this failure "the channel no longer exists"? That is the ONE error that
// retires a watch (spec §6). Everything else — missing permissions, a rate
// limit, a blip — is transient and must retry on the next message rather than
// throw away the officer's sticky.
function isUnknownChannel(err) {
  return Number(err?.code) === ERR_UNKNOWN_CHANNEL;
}

// Drop the watch AND the record. Used only when the channel itself is gone.
async function retireChannel(channelId, reason) {
  forget(channelId);
  try {
    await db.remove(channelId);
  } catch { /* store unreachable — resume() reconciles on the next boot */ }
  console.warn(`[sticky/engine] Dropped sticky for ${channelId} — ${reason}.`);
}

// ---------------------------------------------------------------------------
// Repost core. Post-first, then delete the old one, so the channel never sits
// without its sticky if the send fails. `reposting` guarantees a single writer
// per channel; the post-completion check schedules a catch-up if chat outran us
// mid-repost.
// ---------------------------------------------------------------------------
async function repost(channel) {
  const entry = watched.get(channel.id);
  if (!entry || entry.reposting) return;

  // ALREADY NEWEST — nothing pushed it up. This is also the guard that stops
  // the engine reacting to its own output: right after a repost, the sticky IS
  // the newest message, so a trailing debounce firing behind it does nothing.
  if (entry.stickyMessageId && channel.lastMessageId === entry.stickyMessageId) return;

  entry.reposting = true;
  entry.lastRepostAt = Date.now();
  const oldId = entry.stickyMessageId;

  try {
    const msg = await channel.send(buildStickyPayload(entry));
    entry.stickyMessageId = msg.id;
    await db.setMessageId(channel.id, msg.id);
    await deleteMessageBestEffort(channel.client, channel.id, oldId);
  } catch (err) {
    entry.reposting = false;
    if (isUnknownChannel(err)) {
      // The channel is gone. Retire the watch AND the record rather than
      // retrying forever (spec §6).
      await retireChannel(channel.id, 'the channel no longer exists');
      return;
    }
    console.warn(`[sticky/engine] Repost failed in ${channel.id} (retries on next message):`, err?.message || err);
    return;
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

// Debounce gate: immediate when the cooldown has elapsed, otherwise ONE
// trailing repost when the window closes. Never more than one timer per
// channel, and the state lives on the channel's own entry — so a channel in a
// burst cannot delay a repost in a quiet channel next door.
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
//
// Cheap: `watched.size === 0` then ONE Map lookup, and that is the whole cost
// for every message in the server that is not in a sticky channel. Never
// throws (the caller also guards).
// ---------------------------------------------------------------------------
function onMessage(message) {
  if (watched.size === 0) return;
  if (!watched.has(message.channelId)) return;
  if (message.author?.bot) return;   // caller filters too — belt and braces
  if (!db.isReady()) return;         // degraded: skip reposting entirely
  scheduleRepost(message.channel);
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

// Put a channel under watch from a stored document WITHOUT posting anything.
// Used by resume() to re-attach to the sticky that is already on screen.
function attach(doc) {
  watched.set(doc._id, {
    guildId: doc.guildId ?? null,
    content: doc.content,
    title: doc.title ?? null,
    color: doc.color ?? null,
    stickyMessageId: doc.messageId ?? null,
    lastRepostAt: 0,
    reposting: false,
    timer: null,
  });
}

// Install a sticky in a channel and post it immediately.
//
// Shared by `set` (create), `set` over an existing sticky (replace) and `edit`.
// `previousMessageId` is the message to take down afterwards — the caller reads
// it from the OLD document before upserting, because upsert() nulls the field.
//
// Post-then-delete, same as repost(): if the send fails the old sticky is still
// standing rather than the channel being left with nothing.
async function install(channel, doc, previousMessageId = null) {
  const existing = watched.get(channel.id);
  clearTimer(existing);
  attach({ ...doc, _id: channel.id, messageId: null });

  // Hold the single-writer flag across the send. Without it, a message landing
  // in the same channel during that one await would find an entry whose
  // stickyMessageId is still null, decide the sticky is not newest, and post a
  // SECOND copy. Same flag repost() uses, for the same reason.
  const placed = watched.get(channel.id);
  if (placed) placed.reposting = true;

  let msg;
  try {
    msg = await channel.send(buildStickyPayload(doc));
  } finally {
    if (placed) placed.reposting = false;
  }

  const entry = watched.get(channel.id);
  if (entry) {
    entry.stickyMessageId = msg.id;
    entry.lastRepostAt = Date.now();
  }
  await db.setMessageId(channel.id, msg.id);

  const oldId = previousMessageId ?? existing?.stickyMessageId ?? null;
  if (oldId && oldId !== msg.id) {
    await deleteMessageBestEffort(channel.client, channel.id, oldId);
  }
  return msg;
}

// Stop watching a channel and take the sticky down. Returns true if there was
// one to remove. The record is deleted whether or not the message could be —
// a message we cannot delete must not keep the channel watched forever.
async function uninstall(client, channelId, knownMessageId = null) {
  const entry = watched.get(channelId);
  const messageId = knownMessageId ?? entry?.stickyMessageId ?? null;

  clearTimer(entry);
  watched.delete(channelId);

  await deleteMessageBestEffort(client, channelId, messageId);
  return db.remove(channelId);
}

// Drop a channel from the watch set without touching Discord or the store.
function forget(channelId) {
  const entry = watched.get(channelId);
  clearTimer(entry);
  watched.delete(channelId);
}

// Is this channel currently watched by THIS engine? Used by the conflict check
// so /stickymessage set can tell "replace mine" apart from "another feature
// owns this channel".
function isWatched(channelId) {
  return watched.has(channelId);
}

function watchedCount() {
  return watched.size;
}

// Test hook — resets module state between synthetic cases.
function _resetForTests() {
  for (const entry of watched.values()) clearTimer(entry);
  watched.clear();
}

module.exports = {
  parseColorInput,
  formatFor,
  buildStickyPayload,
  onMessage,
  repost,
  scheduleRepost,
  attach,
  install,
  uninstall,
  forget,
  isWatched,
  watchedCount,
  retireChannel,
  deleteMessageBestEffort,
  _resetForTests,
  _watched: watched,
};
