// ---------------------------------------------------------------------------
// Central audit-log logger.
//
// logEvent(client, { title, description, color, fields, footer, thumbnail,
//                    author, timestamp }) resolves the single audit-log channel
// (auditlog/constants.AUDIT_LOG_CHANNEL_ID) and sends a structured embed.
//
// GRACEFUL DEGRADE (§ dispatch): if the channel is missing / unreachable, or the
// send fails, we console.warn and return — never throw into the event loop. A
// broken log channel must not take the bot down.
//
// Discord hard limits are enforced here so callers can pass raw strings:
//   description ≤ 4096, field name ≤ 256, field value ≤ 1024, ≤ 25 fields.
// ---------------------------------------------------------------------------

const { EmbedBuilder } = require('discord.js');
const { AUDIT_LOG_CHANNEL_ID } = require('./constants');

const DESC_MAX        = 4096;
const TITLE_MAX       = 256;
const FIELD_NAME_MAX  = 256;
const FIELD_VALUE_MAX = 1024;
const FOOTER_MAX      = 2048;
const MAX_FIELDS      = 25;

// Truncate a string to `max` chars, appending an ellipsis when clipped.
function truncate(str, max) {
  if (typeof str !== 'string') str = String(str ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

// Cap a list of short strings so the joined value fits under `max`, appending a
// "…+N more" trailer. Used for role lists etc.
function truncateList(items, max = FIELD_VALUE_MAX) {
  if (!Array.isArray(items) || items.length === 0) return 'none';
  const out = [];
  let len = 0;
  for (let i = 0; i < items.length; i++) {
    const line = String(items[i]);
    if (len + line.length + 2 > max - 12) {
      out.push(`…+${items.length - i} more`);
      break;
    }
    out.push(line);
    len += line.length + 2;
  }
  return out.join(', ');
}

// Resolve a user-ish object to "@mention (tag)". Accepts a User or null.
function userLabel(user, fallbackId) {
  if (user) {
    const tag = user.tag || user.username || user.id;
    return `<@${user.id}> (${tag})`;
  }
  if (fallbackId) return `<@${fallbackId}> (\`${fallbackId}\`)`;
  return 'Unknown';
}

// Resolve an executor from an audit-log entry to a display label, fetching the
// user if only the id is present. Never throws.
async function resolveActor(entry, guild) {
  let ex = entry?.executor || null;
  if (!ex && entry?.executorId && guild?.client) {
    try { ex = await guild.client.users.fetch(entry.executorId); } catch { /* ignore */ }
  }
  return userLabel(ex, entry?.executorId);
}

// Resolve + cache the log channel per client (WeakMap keyed by client).
const channelCache = new WeakMap();

async function resolveLogChannel(client) {
  if (!client) return null;

  const cached = channelCache.get(client);
  if (cached) return cached;

  let channel = client.channels?.cache?.get(AUDIT_LOG_CHANNEL_ID) || null;
  if (!channel) {
    try {
      channel = await client.channels.fetch(AUDIT_LOG_CHANNEL_ID);
    } catch (err) {
      console.warn(`[auditlog] Could not fetch log channel ${AUDIT_LOG_CHANNEL_ID}:`, err?.message || err);
      return null;
    }
  }

  if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
    console.warn(`[auditlog] Log channel ${AUDIT_LOG_CHANNEL_ID} missing or not text-based.`);
    return null;
  }

  channelCache.set(client, channel);
  return channel;
}

// The one send path. Builds a size-safe embed and posts it. Swallows all errors.
async function logEvent(client, opts = {}) {
  try {
    const channel = await resolveLogChannel(client);
    if (!channel) return;

    const {
      title,
      description,
      color,
      fields,
      footer,
      thumbnail,
      author,
      timestamp = true,
    } = opts;

    const embed = new EmbedBuilder();
    if (color != null) embed.setColor(color);
    if (title) embed.setTitle(truncate(String(title), TITLE_MAX));
    if (description) embed.setDescription(truncate(String(description), DESC_MAX));
    if (author) embed.setAuthor(author);
    if (thumbnail) embed.setThumbnail(thumbnail);

    if (Array.isArray(fields) && fields.length) {
      const safe = fields
        .filter(Boolean)
        .slice(0, MAX_FIELDS)
        .map(f => ({
          name:  truncate(String(f.name ?? '​'), FIELD_NAME_MAX) || '​',
          value: truncate(String(f.value ?? '​'), FIELD_VALUE_MAX) || '​',
          inline: !!f.inline,
        }));
      if (safe.length) embed.addFields(safe);
    }

    if (footer) {
      embed.setFooter(typeof footer === 'string' ? { text: truncate(footer, FOOTER_MAX) } : footer);
    }
    if (timestamp) embed.setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    // NEVER throw to the event loop — a logging failure must not crash the bot.
    console.warn('[auditlog] Failed to send log embed:', err?.message || err);
  }
}

module.exports = {
  logEvent,
  resolveLogChannel,
  resolveActor,
  userLabel,
  truncate,
  truncateList,
};
