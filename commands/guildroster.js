const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const db = require('../roster/db');
const { buildRaidImages } = require('../roster/render');

// Public command. /guildroster guild:daddy|mummy (not required → defaults to
// "daddy"). Renders ONE image PER RAID (plus per-field "Unassigned Parties")
// and sends them ONE BY ONE as separate messages with a text label above each.
// Everyone can run it.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('guildroster')
    .setDescription('Show a guild roster — one image per raid, posted one by one.')
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

      const sections = buildRaidImages(guild, { members, parties, raidGroups, settings });

      // Empty state — nothing to show.
      if (!sections.length) {
        await interaction.editReply(`No parties set up yet for ${guildLabel}.`);
        return;
      }

      // Send each section as its OWN message with a single image so Discord
      // doesn't gallery-group them. Build the text label above each image:
      //   - first message: "**Guild: <GuildLabel> Roster**" line
      //   - on a field change: "**Main Teams**" / "**Sub Teams**" header line
      //   - always: the section title "**<raidName | Unassigned Parties>**"
      let lastField = null;
      for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        const contentLines = [];
        if (i === 0) contentLines.push(`**Guild: ${guildLabel} Roster**`);
        if (sec.field !== lastField) {
          contentLines.push(sec.field === 'main' ? '**Main Teams**' : '**Sub Teams**');
          lastField = sec.field;
        }
        contentLines.push(`**${sec.title}**`);

        const payload = {
          content: contentLines.join('\n'),
          files: [new AttachmentBuilder(sec.buffer, { name: sec.filename })],
        };

        if (i === 0) await interaction.editReply(payload);
        else await interaction.followUp(payload);
      }
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
