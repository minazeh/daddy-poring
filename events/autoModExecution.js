// ---------------------------------------------------------------------------
// Audit log: AutoMod rule triggered.
// Fired when a Discord AutoModeration rule takes an action against a message.
// Requires the AutoModerationExecution intent.
// ---------------------------------------------------------------------------

const { Events, AutoModerationActionType } = require('discord.js');
const { logEvent, truncate } = require('../auditlog/logger');
const { COLORS } = require('../auditlog/constants');

const ACTION_LABELS = {
  [AutoModerationActionType.BlockMessage]: 'Block Message',
  [AutoModerationActionType.SendAlertMessage]: 'Send Alert',
  [AutoModerationActionType.Timeout]: 'Timeout',
  [AutoModerationActionType.BlockMemberInteraction]: 'Block Interaction',
};

module.exports = {
  name: Events.AutoModerationActionExecution,
  async execute(execution) {
    try {
      const guild = execution.guild;
      const userId = execution.userId;
      let user = null;
      try { user = await execution.client.users.fetch(userId); } catch { /* ignore */ }

      const ruleName = execution.autoModerationRule?.name
        || (execution.ruleId ? `rule ${execution.ruleId}` : 'unknown rule');
      const actionType = execution.action?.type;
      const actionLabel = ACTION_LABELS[actionType] || `type ${actionType ?? '?'}`;

      const fields = [
        { name: 'Member', value: user ? `${user} (${user.tag})` : `<@${userId}>`, inline: true },
        { name: 'Rule', value: truncate(String(ruleName), 256), inline: true },
        { name: 'Action', value: actionLabel, inline: true },
      ];
      if (execution.channelId) fields.push({ name: 'Channel', value: `<#${execution.channelId}>`, inline: true });
      if (execution.matchedKeyword) fields.push({ name: 'Matched Keyword', value: truncate(String(execution.matchedKeyword), 256), inline: true });
      if (execution.content) fields.push({ name: 'Content', value: truncate(String(execution.content), 1024), inline: false });

      await logEvent(execution.client, {
        color: COLORS.ORANGE,
        title: '🛡️ AutoMod Triggered',
        description: guild ? `In **${guild.name}**` : undefined,
        fields,
      });
    } catch (err) {
      console.warn('[auditlog:autoMod]', err?.message || err);
    }
  },
};
