const { SlashCommandBuilder } = require('discord.js');

const { PARTYFINDER_ROLE_IDS } = require('../partyfinder/constants');
const { buildEntryEmbed, buildEntryComponents } = require('../partyfinder/handlers');

// Returns true only if the member holds at least one Party Finder role.
function canUse(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return PARTYFINDER_ROLE_IDS.some(roleId => member.roles?.cache?.has?.(roleId));
}

module.exports = {
  // Registered with Discord's API via the auto-loader on restart.
  data: new SlashCommandBuilder()
    .setName('partyfinder')
    .setDescription('Open the Party Finder (Start Party / I Need Carry) — only you see it.'),

  // Gate -> reply EPHEMERALLY with the two entry buttons. No persistent channel
  // post: the invoker clicks Start Party / I Need Carry to proceed straight into
  // the existing flows. The actual party/carry cards still post publicly to the
  // party-finder channel from within those flows (unchanged).
  async execute(interaction) {
    if (!canUse(interaction)) {
      await interaction.reply({
        content: "Sorry — you don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [buildEntryEmbed()],
      components: buildEntryComponents(),
      ephemeral: true,
    });
  },
};
