const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../rodb/db');
const {
  FOOTER, DEFAULT_COLOR, fmtPct, joinLines, buildAutocomplete, resolveSelection,
  NOT_AVAILABLE_MSG, notFoundMsg,
} = require('../rodb/format');

// Monster type → accent color (MVP/Boss red, Mini orange, Elite purple, Normal blue).
const TYPE_COLORS = { MVP: 0xe74c3c, Boss: 0xe74c3c, Mini: 0xe67e22, Elite: 0x9b59b6, Normal: 0x3498db };

// Duplicate names are common (375) — label disambiguates by level + type.
const label = (m) => `${m.name} (Lv ${m.level ?? '?'} · ${m.type ?? 'Unknown'})`;

// One display line per drop entry, rate-aware.
function dropLine(d) {
  const parts = [];
  if (d.isCard) {
    const unbound = fmtPct(d.ratePct);
    const bound = fmtPct(d.boundRatePct);
    if (unbound || bound) {
      parts.push([unbound && `${unbound} (unbound)`, bound && `${bound} (bound)`].filter(Boolean).join(' / '));
    }
  } else if (Array.isArray(d.qualityRates) && d.qualityRates.length) {
    parts.push(d.qualityRates.map((q) => `Q${q.quality} ${fmtPct(q.ratePct)}`).join(' / '));
  } else if (fmtPct(d.ratePct)) {
    parts.push(fmtPct(d.ratePct));
  }
  const suffix = parts.length ? ` — ${parts.join(' · ')}` : '';
  return `${d.isCard ? '🃏 ' : ''}${d.name}${suffix}`;
}

function buildEmbed(m) {
  const embed = new EmbedBuilder()
    .setTitle(`${m.name} — Lv ${m.level ?? '?'} ${m.type ?? ''}`.trim())
    .setColor(TYPE_COLORS[m.type] ?? DEFAULT_COLOR)
    .setDescription([m.race, m.element, m.size].filter(Boolean).join(' · ') || null)
    .setFooter({ text: FOOTER });

  if (m.imageUrl) embed.setThumbnail(m.imageUrl);

  const s = m.stats || {};
  const statVal = (v) => (v ?? '—');
  embed.addFields(
    {
      name: 'Stats',
      value: `HP **${statVal(s.hp)}** · P.ATK **${statVal(s.patk)}** · M.ATK **${statVal(s.matk)}**\nP.DEF **${statVal(s.pdef)}** · M.DEF **${statVal(s.mdef)}**`,
      inline: true,
    },
    {
      name: '​',
      value: `HIT **${statVal(s.hit)}** · FLEE **${statVal(s.flee)}**\nCRIT **${statVal(s.crit)}** · CRIT DEF **${statVal(s.critDef)}** · ASPD **${statVal(s.aspd)}**`,
      inline: true,
    },
  );

  if (Array.isArray(m.drops) && m.drops.length) {
    const lines = m.drops.map(dropLine);
    if (m.guaranteedCard?.pityKills) {
      lines.push(`Guaranteed **${m.guaranteedCard.name}** after ${m.guaranteedCard.pityKills.toLocaleString('en-US')} kills`);
    }
    embed.addFields({ name: 'Drops', value: joinLines(lines, 14), inline: false });
  }

  if (Array.isArray(m.mvpDrops) && m.mvpDrops.length) {
    embed.addFields({ name: 'MVP Drops', value: joinLines(m.mvpDrops.map(dropLine), 10), inline: false });
  }

  if (Array.isArray(m.activities) && m.activities.length) {
    embed.addFields({ name: 'Appears in', value: joinLines(m.activities, 6), inline: false });
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('monster')
    .setDescription('Look up a monster — stats, element, race, and drop rates.')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Monster name (pick from the suggestions)')
        .setRequired(true)
        .setAutocomplete(true)),

  autocomplete: buildAutocomplete((q, limit) => db.searchMonsters(q, limit), label),

  // Public (not ephemeral), like /kudosboard.
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply(NOT_AVAILABLE_MSG);
      return;
    }

    await interaction.deferReply(); // public

    try {
      const input = interaction.options.getString('name');
      const monster = await resolveSelection(input, {
        getById: (id) => db.getMonster(id),
        search: (q, limit) => db.searchMonsters(q, limit),
      });

      if (!monster || !monster.name) {
        await interaction.editReply(notFoundMsg('monster', input));
        return;
      }

      await interaction.editReply({ embeds: [buildEmbed(monster)] });
    } catch (err) {
      console.warn('[monster] Lookup failed:', err?.message || err);
      await interaction.editReply("Couldn't load that monster right now — please try again in a moment.");
    }
  },
};
