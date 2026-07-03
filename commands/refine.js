const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../rodb/db');
const { FOOTER, DEFAULT_COLOR, clampField, NOT_AVAILABLE_MSG } = require('../rodb/format');

// Refine data is a fixed 20-level table (not name-shaped) — the option is the
// CURRENT refine level (0–19); the embed shows odds/costs for the next +1.

const pct = (v) => (typeof v === 'number' ? `${Number(v.toLocaleString('en-US'))}%` : '—');

function materialLine(l) {
  if (!l.material) return null;
  const bits = [`${l.material.amount ?? '?'}× **${l.material.name ?? 'Unknown'}**`];
  if (l.material.replaceCurrencyAmount) bits.push(`(or ${l.material.replaceCurrencyAmount} replacement currency)`);
  return bits.join(' ');
}

function buildLevelEmbed(l, config) {
  const safe = (config?.safeLevels || []).includes(l.targetLevel);
  const embed = new EmbedBuilder()
    .setTitle(`Refine +${l._id} → +${l.targetLevel}`)
    .setColor(safe ? 0x2ecc71 : DEFAULT_COLOR)
    .setFooter({ text: FOOTER })
    .addFields(
      { name: 'Success', value: pct(l.successPct), inline: true },
      { name: 'Downgrade', value: pct(l.downgradePct), inline: true },
      { name: 'Fail (no change)', value: pct(l.failPct), inline: true },
    );

  if (l.material?.imageUrl) embed.setThumbnail(l.material.imageUrl);

  const mat = materialLine(l);
  const costLines = [];
  if (mat) costLines.push(mat);
  if (l.consumable?.name) {
    costLines.push(`${l.consumable.amount ? `${l.consumable.amount.toLocaleString('en-US')}× ` : ''}${l.consumable.name}`);
  }
  if (costLines.length) {
    embed.addFields({ name: 'Cost per attempt', value: clampField(costLines.join('\n')), inline: false });
  }

  const notes = [];
  if (safe) notes.push(`✅ +${l.targetLevel} is a safe level — no downgrade below it.`);
  else if (config?.safeLevels?.length) notes.push(`Safe levels: ${config.safeLevels.map((s) => `+${s}`).join(', ')}`);
  if (l.downgradePct > 0) notes.push('A downgrade adds a pity bonus to your next attempt.');
  if (notes.length) embed.addFields({ name: 'Notes', value: notes.join('\n'), inline: false });

  return embed;
}

function buildTableEmbed(levels, config) {
  const lines = levels.map((l) => {
    const safe = (config?.safeLevels || []).includes(l.targetLevel) ? ' 🛡️' : '';
    const odds = l.downgradePct > 0 || l.failPct > 0
      ? `${pct(l.successPct)} ✓ / ${pct(l.downgradePct)} ↓ / ${pct(l.failPct)} ✗`
      : `${pct(l.successPct)} ✓`;
    const mat = l.material ? ` · ${l.material.amount}× ${l.material.name}` : '';
    return `**+${l._id}→+${l.targetLevel}**${safe} ${odds}${mat}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Refine odds (+0 → +20)')
    .setColor(DEFAULT_COLOR)
    .setDescription(clampField(lines.join('\n'), 4096))
    .setFooter({ text: FOOTER });

  const notes = [];
  if (config?.safeLevels?.length) {
    notes.push(`🛡️ Safe levels (no downgrade): ${config.safeLevels.map((s) => `+${s}`).join(', ')}`);
  }
  if (config?.pityBonuses && Object.keys(config.pityBonuses).length) {
    notes.push('Each downgrade adds a pity success bonus to the next attempt (stacks +5% → +100%).');
  }
  if (config?.replacementCurrency) {
    notes.push(`Materials can be substituted with ${config.replacementCurrency}.`);
  }
  if (notes.length) embed.addFields({ name: 'Rules', value: clampField(notes.join('\n')), inline: false });

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('refine')
    .setDescription('Refine odds and materials — per-level success/downgrade rates.')
    .addIntegerOption((opt) =>
      opt
        .setName('level')
        .setDescription('Your current refine level (shows odds for the next +1); leave empty for the full table')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(19)),

  // Public (not ephemeral), like the other rodb commands.
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply(NOT_AVAILABLE_MSG);
      return;
    }

    await interaction.deferReply(); // public

    try {
      const level = interaction.options.getInteger('level');
      const config = await db.getRefineConfig();

      if (level !== null) {
        const doc = await db.getRefineLevel(level);
        if (!doc) {
          await interaction.editReply(`No refine data for +${level} in the snapshot.`);
          return;
        }
        await interaction.editReply({ embeds: [buildLevelEmbed(doc, config)] });
        return;
      }

      const table = await db.getRefineTable();
      if (!table.length) {
        await interaction.editReply(NOT_AVAILABLE_MSG);
        return;
      }
      await interaction.editReply({ embeds: [buildTableEmbed(table, config)] });
    } catch (err) {
      console.warn('[refine] Lookup failed:', err?.message || err);
      await interaction.editReply("Couldn't load the refine data right now — please try again in a moment.");
    }
  },
};
