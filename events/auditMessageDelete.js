// ---------------------------------------------------------------------------
// Audit log: Message Deleted (single).
// The gateway messageDelete event carries the (cached) content, author, and
// channel — but NOT who deleted it. A moderator deleting someone else's message
// produces a MessageDelete audit entry recorded by the audit handler; we wait a
// beat then attribute the deleter, else label it self/unknown.
//
// Bulk deletes (purges) are handled by the audit handler (MessageBulkDelete),
// which carries the actor + count. Message EDIT logging is intentionally NOT
// built (excluded from scope).
// ---------------------------------------------------------------------------

const { Events } = require('discord.js');
const { logEvent, truncate } = require('../auditlog/logger');
const { COLORS, AUDIT_LOG_CHANNEL_ID } = require('../auditlog/constants');
const { consumeModDelete, MSGDEL_TTL_MS } = require('../auditlog/correlation');

const DECISION_DELAY_MS = Math.min(2000, MSGDEL_TTL_MS - 1000);

module.exports = {
  name: Events.MessageDelete,
  async execute(message) {
    try {
      // Ignore DMs and the log channel itself (avoid self-referential loops when
      // the bot's own log messages are pruned).
      if (!message.guild && !message.guildId) return;
      const channelId = message.channelId || message.channel?.id;
      if (channelId === AUDIT_LOG_CHANNEL_ID) return;

      const author = message.author; // null when the message was uncached
      // Skip the bot's own messages — reduces noise / self-logging.
      if (author?.bot && author.id === message.client.user?.id) return;

      const authorId = author?.id || null;
      const content = typeof message.content === 'string' ? message.content : '';
      const attachmentCount = message.attachments?.size ?? 0;
      const client = message.client;

      const t = setTimeout(async () => {
        try {
          const modActor = authorId ? consumeModDelete(authorId, channelId) : null;
          const deletedBy = modActor
            ? modActor
            : (author ? 'author (self-delete) or unknown' : 'unknown');

          const fields = [
            { name: 'Author', value: author ? `${author} (${author.tag})` : 'Unknown (uncached)', inline: true },
            { name: 'Channel', value: channelId ? `<#${channelId}>` : 'unknown', inline: true },
            { name: 'Deleted By', value: deletedBy, inline: false },
          ];

          let contentVal = content ? truncate(content, 1024) : '*no cached text content*';
          if (attachmentCount > 0) {
            contentVal += `\n*(+${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'})*`;
          }
          fields.push({ name: 'Content', value: truncate(contentVal, 1024), inline: false });

          await logEvent(client, {
            color: COLORS.RED,
            title: '🗑️ Message Deleted',
            fields,
          });
        } catch (err) {
          console.warn('[auditlog:messageDelete:delayed]', err?.message || err);
        }
      }, DECISION_DELAY_MS);
      if (typeof t.unref === 'function') t.unref();
    } catch (err) {
      console.warn('[auditlog:messageDelete]', err?.message || err);
    }
  },
};
