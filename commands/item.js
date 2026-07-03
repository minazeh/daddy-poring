const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../rodb/db');
const {
  FOOTER, qualityColor, fmtStat, joinLines, clampField, buildAutocomplete,
  resolveSelection, NOT_AVAILABLE_MSG, notFoundMsg,
} = require('../rodb/format');

// Duplicate names are common (547 — quality tiers of the same base item):
// label disambiguates by quality + slot type (+ level when set).
const label = (it) => {
  const bits = [`Q${it.quality ?? '?'}`, it.typeName ?? 'Item'];
  if (it.level) bits.push(`Lv ${it.level}`);
  return `${it.name} (${bits.join(' · ')})`;
};

function buildEmbed(it) {
  const headBits = [`Q${it.quality ?? '?'} ${it.typeName ?? 'Item'}`];
  if (it.subtypeName && it.subtypeName !== it.typeName) headBits.push(it.subtypeName);
  if (it.level) headBits.push(`Lv ${it.level}`);
  if (it.jobs === 'All') headBits.push('All jobs');
  else if (it.jobCount) headBits.push(`${it.jobCount} jobs`);

  const embed = new EmbedBuilder()
    .setTitle(it.name)
    .setColor(qualityColor(it.quality))
    .setDescription(headBits.join(' · '))
    .setFooter({ text: FOOTER });

  if (it.imageUrl) embed.setThumbnail(it.imageUrl);

  if (Array.isArray(it.stats) && it.stats.length) {
    embed.addFields({ name: 'Stats', value: joinLines(it.stats.map(fmtStat), 10), inline: false });
  }

  if (Array.isArray(it.refineStats) && it.refineStats.length) {
    embed.addFields({
      name: 'Refine (per +1)',
      value: joinLines(it.refineStats.map(fmtStat), 6),
      inline: false,
    });
  }

  const effects = [...(it.effects || []), ...(it.affixes || [])];
  if (effects.length) {
    embed.addFields({ name: 'Effects', value: joinLines(effects, 10), inline: false });
  }

  if (Array.isArray(it.jobs) && it.jobs.length && it.jobs.length <= 12) {
    embed.addFields({ name: 'Jobs', value: clampField(it.jobs.join(', ')), inline: false });
  }

  if (it.suit?.name) {
    const setLines = (it.suit.effects || []).map((e) => `(${e.num}) ${e.desc}`);
    embed.addFields({
      name: `Set: ${it.suit.name}`,
      value: setLines.length ? joinLines(setLines, 6) : '—',
      inline: false,
    });
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('item')
    .setDescription('Look up equipment — stats, effects, refine bonuses, and job limits.')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Item name (pick from the suggestions)')
        .setRequired(true)
        .setAutocomplete(true)),

  autocomplete: buildAutocomplete((q, limit) => db.searchEquipment(q, limit), label),

  // Public (not ephemeral), like /kudosboard.
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply(NOT_AVAILABLE_MSG);
      return;
    }

    await interaction.deferReply(); // public

    try {
      const input = interaction.options.getString('name');
      const item = await resolveSelection(input, {
        getById: (id) => db.getEquipment(id),
        search: (q, limit) => db.searchEquipment(q, limit),
      });

      if (!item) {
        await interaction.editReply(notFoundMsg('item', input));
        return;
      }

      await interaction.editReply({ embeds: [buildEmbed(item)] });
    } catch (err) {
      console.warn('[item] Lookup failed:', err?.message || err);
      await interaction.editReply("Couldn't load that item right now — please try again in a moment.");
    }
  },
};
