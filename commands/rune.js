const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../rodb/db');
const {
  FOOTER, DEFAULT_COLOR, joinLines, buildAutocomplete, resolveSelection,
  NOT_AVAILABLE_MSG, notFoundMsg,
} = require('../rodb/format');

// Rune crystal element → accent color (Gale/Frost/Flame/Earth/Holy hues).
const ELEMENT_COLORS = {
  'Gale Crystal': 0x2ecc71,
  'Frost Crystal': 0x3498db,
  'Flame Crystal': 0xe74c3c,
  'Earth Crystal': 0xd35400,
  'Holy Crystal': 0xf1c40f,
};

// 33 effect groups, no duplicate names — element still adds useful context.
const label = (r) => `${r.name}${r.element?.name ? ` (${r.element.name})` : ''}`;

function buildEmbed(r) {
  const embed = new EmbedBuilder()
    .setTitle(r.name)
    .setColor(ELEMENT_COLORS[r.element?.name] ?? DEFAULT_COLOR)
    .setDescription(r.element?.name ? `Element: **${r.element.name}**` : null)
    .setFooter({ text: FOOTER });

  if (r.imageUrl) embed.setThumbnail(r.imageUrl);

  if (Array.isArray(r.levels) && r.levels.length) {
    embed.addFields({
      name: 'Effect by level',
      value: joinLines(r.levels.map((l) => `**Lv ${l.level}** — ${l.desc}`), 6),
      inline: false,
    });
  }

  // Element resonance = set bonus for equipping N runes of the same crystal.
  const res = r.element?.resonance;
  if (res && typeof res === 'object') {
    const lines = Object.entries(res)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([n, texts]) => `**${n} pc** — ${(Array.isArray(texts) ? texts : [texts]).join('; ')}`);
    if (lines.length) {
      embed.addFields({
        name: `Resonance (${r.element.name} set)`,
        value: joinLines(lines, 6),
        inline: false,
      });
    }
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rune')
    .setDescription('Look up a rune effect — per-level bonuses and element resonance.')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Rune effect name (pick from the suggestions)')
        .setRequired(true)
        .setAutocomplete(true)),

  autocomplete: buildAutocomplete((q, limit) => db.searchRunes(q, limit), label),

  // Public (not ephemeral), like the other rodb commands.
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply(NOT_AVAILABLE_MSG);
      return;
    }

    await interaction.deferReply(); // public

    try {
      const input = interaction.options.getString('name');
      const rune = await resolveSelection(input, {
        getById: (id) => db.getRune(id),
        search: (q, limit) => db.searchRunes(q, limit),
      });

      if (!rune || !rune.name) {
        await interaction.editReply(notFoundMsg('rune', input));
        return;
      }

      await interaction.editReply({ embeds: [buildEmbed(rune)] });
    } catch (err) {
      console.warn('[rune] Lookup failed:', err?.message || err);
      await interaction.editReply("Couldn't load that rune right now — please try again in a moment.");
    }
  },
};
