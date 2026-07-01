// ---------------------------------------------------------------------------
// Audit log: Username / global-name / avatar changes.
// These are account-level (not guild) changes carried by the userUpdate gateway
// event — they never appear in the guild audit log, so this is the only source.
// Nickname changes (guild-level) are handled by the audit-log entry handler.
// ---------------------------------------------------------------------------

const { Events } = require('discord.js');
const { logEvent } = require('../auditlog/logger');
const { COLORS } = require('../auditlog/constants');

module.exports = {
  name: Events.UserUpdate,
  async execute(oldUser, newUser) {
    try {
      // Partial oldUser → nothing to diff against.
      if (!oldUser || oldUser.partial) return;

      const changes = [];

      if (oldUser.username !== newUser.username) {
        changes.push({ name: 'Username', value: `\`${oldUser.username ?? '—'}\` → \`${newUser.username ?? '—'}\`` });
      }
      if (oldUser.globalName !== newUser.globalName) {
        changes.push({ name: 'Global Name', value: `\`${oldUser.globalName ?? '—'}\` → \`${newUser.globalName ?? '—'}\`` });
      }

      const avatarChanged = oldUser.avatar !== newUser.avatar;

      if (changes.length === 0 && !avatarChanged) return;

      if (avatarChanged) {
        await logEvent(newUser.client, {
          color: COLORS.BLUE,
          title: '🖼️ Avatar Changed',
          thumbnail: newUser.displayAvatarURL?.() ?? undefined,
          description: `${newUser} • **${newUser.tag}**\n\`${newUser.id}\``,
        });
      }

      if (changes.length) {
        await logEvent(newUser.client, {
          color: COLORS.BLUE,
          title: '✏️ Username / Global Name Changed',
          thumbnail: newUser.displayAvatarURL?.() ?? undefined,
          description: `${newUser} • \`${newUser.id}\``,
          fields: changes.map(c => ({ ...c, inline: false })),
        });
      }
    } catch (err) {
      console.warn('[auditlog:userUpdate]', err?.message || err);
    }
  },
};
