const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const db = require('../roster/db');
const { buildGuildImage } = require('../roster/render');

// Public command. /guildroster guild:daddy|mummy (not required → defaults to
// "daddy"). Renders ONE combined image — all raid groups + unassigned parties
// for the guild, stacked vertically — as a single PNG. Everyone can run it.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('guildroster')
    .setDescription('Show a guild roster — parties organized by raid group, as one image.')
    .addStringOption(option =>
      option
        .setName('guild')
        .setDescription('Which guild to show (defaults to Daddy).')
        .setRequired(false)
        .addChoices(
          { name: 'Daddy', value: 'daddy' },
          { name: 'Mummy', value: 'mummy' },
        )),

  async execute(interaction) {
    const guild = interaction.options.getString('guild') || 'daddy'; // default daddy
    const guildLabel = guild === 'mummy' ? 'Mummy' : 'Daddy';

    if (!db.isReady()) {
      await interaction.reply("Roster isn't available right now — try again later.");
      return;
    }

    await interaction.deferReply(); // public

    try {
      const [members, parties, raidGroups, settings] = await Promise.all([
        db.getMembers(guild),
        db.getParties(guild),
        db.getRaidGroups(guild),
        db.getSettings(),
      ]);

      const image = buildGuildImage(guild, { members, parties, raidGroups, settings });

      // Empty state — nothing to show.
      if (!image) {
        await interaction.editReply(`No parties set up yet for ${guildLabel}.`);
        return;
      }

      // Exactly one combined PNG.
      const file = new AttachmentBuilder(image.buffer, { name: image.filename });
      await interaction.editReply({ files: [file] });
    } catch (err) {
      console.warn('[guildroster] Render/query failed:', err?.message || err);
      const msg = "Couldn't build the guild roster right now — please try again in a moment.";
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(msg);
        } else {
          await interaction.reply(msg);
        }
      } catch { /* ignore secondary failure */ }
    }
  },
};
