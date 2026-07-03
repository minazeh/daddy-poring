const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../rodb/db');
const {
  FOOTER, qualityColor, fmtPct, joinLines, buildAutocomplete, resolveSelection,
  NOT_AVAILABLE_MSG, notFoundMsg,
} = require('../rodb/format');

// Only 226 cards, but labels stay informative: quality + equip slot.
const label = (c) => `${c.name} (Q${c.quality ?? '?'} · ${c.slot ?? 'Card'})`;

// "Poring (Lv 5) — 0.0117% (unbound) / 0.0216% (bound) · pity 4,000"
function sourceLine(src) {
  const rates = [
    fmtPct(src.ratePctUnbound) && `${fmtPct(src.ratePctUnbound)} (unbound)`,
    fmtPct(src.ratePctBound) && `${fmtPct(src.ratePctBound)} (bound)`,
  ].filter(Boolean);
  const bits = [];
  if (rates.length) bits.push(rates.join(' / '));
  if (src.guaranteedPityKills) bits.push(`pity ${src.guaranteedPityKills.toLocaleString('en-US')}`);
  const name = src.level != null ? `${src.monsterName} (Lv ${src.level})` : src.monsterName;
  return bits.length ? `${name} — ${bits.join(' · ')}` : name;
}

function buildEmbed(c) {
  const headBits = [`Q${c.quality ?? '?'}`];
  if (c.slot) headBits.push(`${c.slot} slot`);
  if (c.hasMvpSource) headBits.push('👑 MVP source');

  const embed = new EmbedBuilder()
    .setTitle(c.name)
    .setColor(qualityColor(c.quality))
    .setDescription(headBits.join(' · '))
    .setFooter({ text: FOOTER });

  if (c.imageUrl) embed.setThumbnail(c.imageUrl);

  if (Array.isArray(c.effectLines) && c.effectLines.length) {
    embed.addFields({ name: 'Effect', value: joinLines(c.effectLines, 8), inline: false });
  }

  if (Array.isArray(c.droppedBy) && c.droppedBy.length) {
    embed.addFields({ name: 'Dropped by', value: joinLines(c.droppedBy.map(sourceLine), 10), inline: false });
  } else {
    embed.addFields({
      name: 'Dropped by',
      value: 'No monster drop recorded in the snapshot — likely from crafting, events, or trading.',
      inline: false,
    });
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('card')
    .setDescription('Look up a card — effect, equip slot, and which monsters drop it.')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Card name (pick from the suggestions)')
        .setRequired(true)
        .setAutocomplete(true)),

  autocomplete: buildAutocomplete((q, limit) => db.searchCards(q, limit), label),

  // Public (not ephemeral), like /kudosboard.
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply(NOT_AVAILABLE_MSG);
      return;
    }

    await interaction.deferReply(); // public

    try {
      const input = interaction.options.getString('name');
      const card = await resolveSelection(input, {
        getById: (id) => db.getCard(id),
        search: (q, limit) => db.searchCards(q, limit),
      });

      if (!card) {
        await interaction.editReply(notFoundMsg('card', input));
        return;
      }

      await interaction.editReply({ embeds: [buildEmbed(card)] });
    } catch (err) {
      console.warn('[card] Lookup failed:', err?.message || err);
      await interaction.editReply("Couldn't load that card right now — please try again in a moment.");
    }
  },
};
