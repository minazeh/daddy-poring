const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const db = require('../roster/db');
const { buildSiegeImage } = require('../roster/render');

// Public command. /siege guild:daddy|mummy (not required → defaults to
// "daddy"). Renders the guild's SIEGE layout — a third, independent raid
// arrangement maintained on the web app's /siege page, separate from both the
// GvG Main/Sub fields (/guildroster) and the Polarity board (/polarityraid).
//
// Structure per guild: 4 raids — Alpha, Bravo, Charlie, Delta Flex — 8 parties
// each. EXACTLY ONE IMAGE per run (Conrad's spec), and EACH RAID GETS ITS OWN
// ROW BAND inside it: a full-width header carrying the raid name, its
// party/member counts and its leader, followed by that raid's own row of party
// cards. That grouping is structural — see the layoutRaidGroups() header in
// roster/render.js for why the flat pooling layout the other two commands use
// can't express it.
//
// EMPTY PARTIES ARE HIDDEN, so a raid running 6 of its 8 parties simply draws a
// shorter row. Delta Flex is expected to look shorter than the others most of
// the time; that is the intended reading, not a bug.
//
// Daddy and Mummy are SEPARATE sieges and are never combined in one run.
// Everything read here is READ-ONLY — the siege collections are web-owned.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('siege')
    .setDescription('Show a guild\'s Siege layout — all four raids in one image.')
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

    // No MONGODB_URI, or Atlas unreachable at boot — the bot is fine, this
    // command just has nothing to read.
    if (!db.isReady()) {
      await interaction.reply("Siege isn't available right now — try again later.");
      return;
    }

    await interaction.deferReply(); // public

    try {
      const [members, siegeRaids, siegeParties, settings] = await Promise.all([
        db.getMembers(guild),
        db.getSiegeRaids(guild),
        db.getSiegeParties(guild),
        db.getSettings(),
      ]);

      const image = buildSiegeImage(guild, { members, siegeRaids, siegeParties, settings });

      // The siege has never been set up on the web side (the page has never
      // been opened, so the collections aren't seeded) — say so rather than
      // post a picture of nothing.
      if (!image) {
        await interaction.editReply(
          `No Siege set up yet for ${guildLabel}. Build it on the web app's Siege page first.`,
        );
        return;
      }

      // ONE image, one message. Never an album.
      await interaction.editReply({
        content: `**${guildLabel} · Siege**`,
        files: [new AttachmentBuilder(image.buffer, { name: image.filename })],
      });
    } catch (err) {
      console.warn('[siege] Render/query failed:', err?.message || err);
      const msg = "Couldn't build the siege layout right now — please try again in a moment.";
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
