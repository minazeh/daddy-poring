const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../rodb/db');
const {
  FOOTER, qualityColor, joinLines, clampField, buildAutocomplete, resolveSelection,
  NOT_AVAILABLE_MSG, notFoundMsg,
} = require('../rodb/format');

// 75 names repeat across the 25 NPC stores — label disambiguates by store.
const label = (s) => `${s.name} (${s.store ?? 'Shop'})`;

const priceLine = (p) => `${(p.amount ?? 0).toLocaleString('en-US')}× **${p.currency ?? 'Unknown currency'}**`;

function buildEmbed(s) {
  const headBits = [];
  if (s.store) headBits.push(`🏪 ${s.store}`);
  if (s.tab && s.tab !== s.store) headBits.push(s.tab);
  if (s.itemNum && s.itemNum > 1) headBits.push(`bundle of ${s.itemNum}`);

  const embed = new EmbedBuilder()
    .setTitle(s.name)
    .setColor(qualityColor(s.quality))
    .setDescription(headBits.join(' · ') || null)
    .setFooter({ text: FOOTER });

  if (s.imageUrl) embed.setThumbnail(s.imageUrl);

  if (Array.isArray(s.prices) && s.prices.length) {
    embed.addFields({ name: 'Price', value: joinLines(s.prices.map(priceLine), 4), inline: false });
  }

  const limitBits = [];
  if (s.limitNum) limitBits.push(`Purchase limit: **${s.limitNum}**`);
  if (s.requiredLevel) limitBits.push(`Requires Lv ${s.requiredLevel}`);
  if (s.binding) limitBits.push('Bound on purchase');
  if (limitBits.length) {
    embed.addFields({ name: 'Limits', value: limitBits.join(' · '), inline: false });
  }

  if (Array.isArray(s.unlockNotes) && s.unlockNotes.length) {
    embed.addFields({ name: 'Unlock', value: joinLines(s.unlockNotes, 4), inline: false });
  }

  if (s.desc) {
    embed.addFields({ name: 'Item effect', value: clampField(s.desc), inline: false });
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Look up an NPC shop listing — which store sells it, price, and limits.')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Item name (pick from the suggestions)')
        .setRequired(true)
        .setAutocomplete(true)),

  autocomplete: buildAutocomplete((q, limit) => db.searchShop(q, limit), label),

  // Public (not ephemeral), like the other rodb commands.
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply(NOT_AVAILABLE_MSG);
      return;
    }

    await interaction.deferReply(); // public

    try {
      const input = interaction.options.getString('name');
      const listing = await resolveSelection(input, {
        getById: (id) => db.getShopListing(id),
        search: (q, limit) => db.searchShop(q, limit),
      });

      if (!listing || !listing.name) {
        await interaction.editReply(notFoundMsg('shop item', input));
        return;
      }

      await interaction.editReply({ embeds: [buildEmbed(listing)] });
    } catch (err) {
      console.warn('[shop] Lookup failed:', err?.message || err);
      await interaction.editReply("Couldn't load that shop listing right now — please try again in a moment.");
    }
  },
};
