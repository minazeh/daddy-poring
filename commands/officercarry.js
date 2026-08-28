// ---------------------------------------------------------------------------
// /officercarry — the weekly officer carry schedule board (officers only).
//
// Spec: docs/OFFICER_CARRY_SCHEDULER_SPEC.md §8.
//
//   /officercarry panel   post the board here (or move it here)
//   /officercarry reset   force a roll to a fresh week now
//
// The board's buttons are STATIC customIds, so a board posted months ago keeps
// working across every Railway redeploy. Same shape as /carrypanel and
// /guildsupport — an embed plus a button row.
// ---------------------------------------------------------------------------

const { SlashCommandBuilder, MessageFlags } = require('discord.js');

const db = require('../officercarry/db');
const handlers = require('../officercarry/handlers');
const render = require('../officercarry/render');
const { CHANNELS } = require('../officercarry/constants');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('officercarry')
    .setDescription('Officer carry schedule board (officers only).')
    .addSubcommand(sub =>
      sub.setName('panel')
        .setDescription('Post the weekly carry schedule board in this channel.'))
    .addSubcommand(sub =>
      sub.setName('reset')
        .setDescription('Start a fresh week now. The current week is archived, not deleted.')),

  async execute(interaction) {
    if (!handlers.isOfficer(interaction) && !handlers.isGodfather(interaction)) {
      await interaction.reply({
        content: "Sorry — you don't have permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // The board is useless without the store behind it — posting one that
    // cannot take a join is worse than saying so.
    if (!db.isReady()) {
      await interaction.reply({
        content: '⚠️ The carry scheduler is unavailable right now (database not reachable), so the board would not work. Try again once the store is back.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'panel') {
      // A gentle nudge, not a block — a test server may well want it elsewhere.
      const note = interaction.channelId !== CHANNELS.PANEL
        ? `\n\n_Note: this is not the configured board channel (<#${CHANNELS.PANEL}>). Posting here anyway._`
        : '';

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const message = await handlers.postPanel(interaction.client, interaction.guildId, interaction.channel);
      if (!message) {
        await interaction.editReply('Could not post the board — the scheduler store did not respond.');
        return;
      }

      await interaction.editReply(
        `✅ Board posted: ${message.url}\n` +
        'It updates itself on every change and rolls to a fresh week on Monday.' + note,
      );
      return;
    }

    if (sub === 'reset') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const current = await db.getActiveWeek(interaction.guildId);
      if (!current) {
        await interaction.editReply('There is no active week to reset.');
        return;
      }

      // Archive, never delete (spec §4.2) — the outgoing week stays on record.
      const archived = await db.archiveWeek(current._id);
      if (!archived) {
        await interaction.editReply('That week had already been rolled by the sweeper. Nothing to do.');
        return;
      }

      const fresh = await db.getOrCreateActiveWeek(interaction.guildId, new Date());
      if (!fresh) {
        await interaction.editReply('Archived the old week, but could not open a new one. Tell an admin.');
        return;
      }

      // Keep the board's permalink: adopt the old location and repaint in place.
      if (current.panelMessageId) {
        await db.adoptPanelFrom(current, fresh._id);
        await handlers.refreshPanelNow(interaction.client, interaction.guildId);
      }

      await interaction.editReply(
        `✅ Fresh week started (**${fresh.weekKey}**). ` +
        `**${current.weekKey}** was archived, not deleted — its slots are still on record.`,
      );
      return;
    }
  },
};
