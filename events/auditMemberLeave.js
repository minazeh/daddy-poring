// ---------------------------------------------------------------------------
// Audit log: Member Left.
// guildMemberRemove fires for voluntary leaves, kicks, AND bans. We wait a short
// beat so the guildAuditLogEntryCreate handler can mark a kick/ban first, then
// decide: if this removal was a kick/ban it's already logged (stay silent);
// otherwise it's a genuine voluntary leave and we log it here.
// ---------------------------------------------------------------------------

const { Events } = require('discord.js');
const { logEvent, truncateList } = require('../auditlog/logger');
const { COLORS } = require('../auditlog/constants');
const { consumeRemoval, REMOVAL_TTL_MS } = require('../auditlog/correlation');

// Wait long enough for the audit entry to land, comfortably under the TTL.
const DECISION_DELAY_MS = Math.min(2500, REMOVAL_TTL_MS - 1000);

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    try {
      const user = member.user;
      const id = member.id;
      const joinedTs = member.joinedTimestamp;

      // Snapshot roles now (member leaves cache after this event).
      let roleNames = [];
      try {
        const guildId = member.guild?.id;
        roleNames = member.roles?.cache
          ? [...member.roles.cache.values()]
              .filter(r => r.id !== guildId)
              .map(r => r.name)
          : [];
      } catch { /* partial member — no roles */ }

      const client = member.client;

      const t = setTimeout(async () => {
        try {
          const removal = consumeRemoval(id); // 'kick' | 'ban' | null
          if (removal) return; // already logged by the audit handler

          await logEvent(client, {
            color: COLORS.RED,
            title: '📤 Member Left',
            thumbnail: user?.displayAvatarURL?.() ?? undefined,
            description: `${user ?? id} • **${user?.tag ?? id}**\n\`${id}\``,
            fields: [
              {
                name: 'Joined',
                value: joinedTs ? `<t:${Math.floor(joinedTs / 1000)}:R>` : 'unknown',
                inline: true,
              },
              { name: 'Roles', value: roleNames.length ? truncateList(roleNames) : 'none', inline: false },
            ],
            footer: { text: 'Voluntary leave' },
          });
        } catch (err) {
          console.warn('[auditlog:leave:delayed]', err?.message || err);
        }
      }, DECISION_DELAY_MS);
      if (typeof t.unref === 'function') t.unref();
    } catch (err) {
      console.warn('[auditlog:leave]', err?.message || err);
    }
  },
};
