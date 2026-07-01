// ---------------------------------------------------------------------------
// Audit log: Member Joined.
// Separate from events/guildMemberAdd.js (the welcome message) — the event
// loader registers BOTH listeners on guildMemberAdd. Logs user, account age, and
// the invite used if it can be resolved.
// ---------------------------------------------------------------------------

const { Events } = require('discord.js');
const { logEvent } = require('../auditlog/logger');
const { COLORS } = require('../auditlog/constants');
const inviteTracker = require('../auditlog/inviteTracker');

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    try {
      const user = member.user;
      const createdMs = user?.createdTimestamp;

      let inviteStr = 'unresolved';
      try {
        const info = await inviteTracker.resolveUsedInvite(member);
        if (info) {
          inviteStr = `\`${info.code}\`${info.inviterTag ? ` — by ${info.inviterTag}` : ''}`;
        }
      } catch { /* best-effort */ }

      await logEvent(member.client, {
        color: COLORS.GREEN,
        title: '📥 Member Joined',
        thumbnail: user?.displayAvatarURL?.() ?? undefined,
        description: `${user ?? member.id} • **${user?.tag ?? member.id}**\n\`${member.id}\``,
        fields: [
          {
            name: 'Account Created',
            value: createdMs ? `<t:${Math.floor(createdMs / 1000)}:R>` : 'unknown',
            inline: true,
          },
          { name: 'Invite Used', value: inviteStr, inline: true },
          { name: 'Member Count', value: String(member.guild?.memberCount ?? '—'), inline: true },
        ],
        footer: user?.bot ? { text: 'Bot account' } : undefined,
      });
    } catch (err) {
      console.warn('[auditlog:join]', err?.message || err);
    }
  },
};
