// ---------------------------------------------------------------------------
// /syncmembers — officer-gated slash command.
//
// Triggers an immediate member-roster sync (Daddy + Mummy roles → MongoDB).
// Responds ephemerally so only the invoking officer sees the result.
//
// Officer gate: identical pattern to /memberclasses — member must hold at
// least one of the OFFICER_ROLE_IDS from officerapp/constants.js.
//
// Graceful degrade: if the member-sync DB is not ready (no MONGODB_URI or
// Atlas unreachable) the command replies "not configured yet" instead of
// erroring. The bot and all other commands are unaffected.
// ---------------------------------------------------------------------------

const { SlashCommandBuilder } = require('discord.js');
const { OFFICER_ROLE_IDS } = require('../officerapp/constants');
const { syncMembers }       = require('../membersync/sync');
const memberSyncDb          = require('../membersync/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('syncmembers')
    .setDescription('(Officers only) Force an immediate sync of the Daddy + Mummy roster to the database.'),

  async execute(interaction) {
    // Officer gate — must hold at least one officer role (Daddy or Mummy officer).
    const memberRoles    = interaction.member?.roles?.cache;
    const hasPermission  = memberRoles && Object.values(OFFICER_ROLE_IDS).some(id => memberRoles.has(id));

    if (!hasPermission) {
      return interaction.reply({
        content: 'Sorry — you don\'t have permission to use this command.',
        ephemeral: true,
      });
    }

    // Graceful degrade: DB not configured.
    if (!memberSyncDb.isReady()) {
      return interaction.reply({
        content: 'Member sync isn\'t configured yet.',
        ephemeral: true,
      });
    }

    // Defer ephemerally — sync can take a few seconds on large guilds.
    await interaction.deferReply({ ephemeral: true });

    try {
      const { total, main, sub } = await syncMembers(interaction.client);
      await interaction.editReply({
        content: `Synced ${total} members (${main} main / ${sub} sub).`,
      });
    } catch (err) {
      console.warn('[syncmembers] Unexpected error during manual sync:', err?.message || err);
      await interaction.editReply({
        content: 'Sync failed — check the bot logs for details.',
      });
    }
  },
};
