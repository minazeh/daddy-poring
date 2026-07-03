// ---------------------------------------------------------------------------
// /gvgvc — the voice channels monitored for GvG attendance (Godfathers only).
//
//   /gvgvc add <channel> <label> <guild> — register a VC (e.g. "Daddy Main").
//                                          Re-adding a channel updates its
//                                          label/guild in place.
//   /gvgvc list                          — all monitored VCs.
//   /gvgvc remove <vc>                   — autocomplete pick; unregisters it.
//
// The guild tag decides which schedules check the VC (Daddy schedule → daddy
// VCs, Mummy → mummy, Both → all) AND which roster side attendees are
// checked against (daddy ⇒ isMain, mummy ⇒ isSub) for wrong-VC ⚠ flags.
// Persistence in gvg/db.js (graceful degrade).
// ---------------------------------------------------------------------------

const { SlashCommandBuilder, ChannelType } = require('discord.js');
const db = require('../gvg/db');
const { GODFATHERS_ROLE_ID, GUILDS, GUILD_LABELS } = require('../gvg/constants');

// Returns true only if the member holds the Godfathers role.
function isGodfather(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return Boolean(member.roles?.cache?.has?.(GODFATHERS_ROLE_ID));
}

// One-line description of a monitored VC (list, autocomplete, confirmations).
function describeVc(v) {
  return `${v.label} (${GUILD_LABELS[v.guild] || v.guild})`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('gvgvc')
    .setDescription('Manage the voice channels monitored for GvG attendance (Godfathers only).')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Register a voice channel for GvG attendance monitoring.')
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('The voice channel to monitor.')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true))
        .addStringOption(opt =>
          opt
            .setName('label')
            .setDescription('Friendly name shown on the log (e.g. "Daddy Main").')
            .setRequired(true)
            .setMaxLength(60))
        .addStringOption(opt =>
          opt
            .setName('guild')
            .setDescription('Which guild this VC belongs to (drives roster flags).')
            .setRequired(true)
            .addChoices(
              { name: 'Daddy', value: GUILDS.DADDY },
              { name: 'Mummy', value: GUILDS.MUMMY },
            )))
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List the monitored GvG voice channels.'))
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Stop monitoring a voice channel.')
        .addStringOption(opt =>
          opt
            .setName('vc')
            .setDescription('Which monitored VC to remove.')
            .setRequired(true)
            .setAutocomplete(true))),

  // Autocomplete for remove → vc: match label/guild, value = _id.
  async autocomplete(interaction) {
    const q = (interaction.options.getFocused() || '').toLowerCase();
    const vcs = await db.getVoiceChannels();
    const choices = vcs
      .filter(v => !q || describeVc(v).toLowerCase().includes(q))
      .slice(0, 25)
      .map(v => ({ name: describeVc(v).slice(0, 100), value: String(v._id) }));
    await interaction.respond(choices);
  },

  async execute(interaction) {
    // Godfathers gate — ephemeral deny for everyone else.
    if (!isGodfather(interaction)) {
      await interaction.reply({
        content: "Sorry — you don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    // Graceful degradation — persistence unavailable means no VC ops.
    if (!db.isReady()) {
      await interaction.reply({
        content: '⚠️ GvG VC management is unavailable right now (database not reachable). Please try again later.',
        ephemeral: true,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    // -----------------------------------------------------------------------
    // add
    // -----------------------------------------------------------------------
    if (sub === 'add') {
      const channel = interaction.options.getChannel('channel');
      const label = interaction.options.getString('label').trim();
      const guild = interaction.options.getString('guild');

      if (!label) {
        await interaction.reply({ content: '⚠️ The label can\'t be empty.', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const doc = await db.addVoiceChannel({
        channelId: channel.id,
        label,
        guild,
        guildId: interaction.guildId,
        addedBy: interaction.user.id,
      });
      if (!doc) {
        await interaction.editReply('⚠️ Could not save the VC — database not reachable. Try again later.');
        return;
      }
      await interaction.editReply(
        `✅ Monitoring <#${channel.id}> as **${describeVc(doc)}** for GvG attendance. ` +
        '(Adding the same channel again updates its label/guild.)',
      );
      return;
    }

    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------
    if (sub === 'list') {
      await interaction.deferReply({ ephemeral: true });
      const vcs = await db.getVoiceChannels();
      if (!vcs.length) {
        await interaction.editReply('No monitored VCs yet — add one with `/gvgvc add`.');
        return;
      }
      const lines = vcs.map(v => `• **${v.label}** — ${GUILD_LABELS[v.guild] || v.guild} — <#${v.channelId}>\n  id: \`${v._id}\``);
      let content = `🔊 **Monitored GvG voice channels (${vcs.length})**\n` + lines.join('\n');
      if (content.length > 2000) content = content.slice(0, 1997) + '…';
      await interaction.editReply(content);
      return;
    }

    // -----------------------------------------------------------------------
    // remove
    // -----------------------------------------------------------------------
    if (sub === 'remove') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.options.getString('vc');
      const removed = await db.removeVoiceChannel(id);
      if (!removed) {
        await interaction.editReply('⚠️ That VC wasn\'t found — it may have already been removed. Check `/gvgvc list`.');
        return;
      }
      await interaction.editReply(`🗑️ No longer monitoring **${describeVc(removed)}** (<#${removed.channelId}>).`);
      return;
    }
  },
};
