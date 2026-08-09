const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const db = require('../roster/db');
const { buildPolarityImages } = require('../roster/render');

// Public command. /polarityraid guild:daddy|mummy (not required → defaults to
// "daddy"). Renders the guild's POLARITY layout — a second, independent raid
// arrangement maintained on the web app's /polarity-raids page, separate from
// the GvG Main/Sub fields shown by /guildroster.
//
// Structure per guild: 2 main raids (top power, 5 parties each) + 4 normal
// raids (8 parties each). EXACTLY TWO IMAGES per run — one pooling every main
// raid, one pooling every normal raid — each posted as its own message so
// Discord doesn't gallery-group them. This mirrors /guildroster's two field
// images and shares the same visual language (class role badges, party cards,
// gold crown for the raid leader). Because party names repeat across raids,
// each pooled card carries its raid name as an eyebrow above the party title.
//
// Daddy and Mummy are SEPARATE guilds and are never combined in one run.
// Everything read here is READ-ONLY — the polarity collections are web-owned.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('polarityraid')
    .setDescription('Show a guild\'s Polarity Raid layout — main raids and normal raids.')
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
      await interaction.reply("Polarity raids aren't available right now — try again later.");
      return;
    }

    await interaction.deferReply(); // public

    try {
      const [members, polarityRaids, polarityParties, settings] = await Promise.all([
        db.getMembers(guild),
        db.getPolarityRaids(guild),
        db.getPolarityParties(guild),
        db.getSettings(),
      ]);

      const sections = buildPolarityImages(guild, {
        members,
        polarityRaids,
        polarityParties,
        settings,
      });

      // Nothing assigned yet (or the web page has never been opened, so the
      // collections aren't seeded) — say so rather than post blank images.
      if (!sections.length) {
        await interaction.editReply(
          `No Polarity Raids set up yet for ${guildLabel}. Build them on the web app's Polarity Raids page first.`,
        );
        return;
      }

      // One message per image (Main Raids, then Normal Raids), labelled
      // "**<Guild> · <section>**".
      for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        const payload = {
          content: `**${guildLabel} · ${sec.title}**`,
          files: [new AttachmentBuilder(sec.buffer, { name: sec.filename })],
        };

        if (i === 0) await interaction.editReply(payload);
        else await interaction.followUp(payload);
      }
    } catch (err) {
      console.warn('[polarityraid] Render/query failed:', err?.message || err);
      const msg = "Couldn't build the polarity raids right now — please try again in a moment.";
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
