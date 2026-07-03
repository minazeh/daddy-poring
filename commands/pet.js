const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../rodb/db');
const {
  FOOTER, DEFAULT_COLOR, fmtStat, joinLines, buildAutocomplete, resolveSelection,
  NOT_AVAILABLE_MSG, notFoundMsg,
} = require('../rodb/format');

// Pet rarity tag → accent color (N grey / R blue / SR purple / SSR orange).
const TAG_COLORS = { N: 0x95a5a6, R: 0x3498db, SR: 0x9b59b6, SSR: 0xe67e22 };

// 28 pets, unique names — rarity tag still helps scanning.
const label = (p) => `${p.name}${p.qualityTag ? ` (${p.qualityTag})` : ''}`;

const trunc = (s, n = 160) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

function buildEmbed(p) {
  const headBits = [];
  if (p.qualityTag) headBits.push(`**${p.qualityTag}**${p.qualityName && p.qualityName !== p.qualityTag ? ` (${p.qualityName})` : ''}`);
  if (p.maxLevel != null) headBits.push(`max Lv ${p.maxLevel}`);

  const embed = new EmbedBuilder()
    .setTitle(p.name)
    .setColor(TAG_COLORS[p.qualityTag] ?? DEFAULT_COLOR)
    .setDescription(headBits.join(' · ') || null)
    .setFooter({ text: FOOTER });

  if (p.imageUrl) embed.setThumbnail(p.imageUrl);

  if (Array.isArray(p.combatSkills) && p.combatSkills.length) {
    const lines = p.combatSkills.map((s) => {
      const bits = [];
      if (s.typeLabel) bits.push(`[${s.typeLabel}]`);
      bits.push(`**${s.name}**`);
      if (s.desc) bits.push(`— ${trunc(s.desc)}`);
      if (s.cooldownSeconds) bits.push(`(CD ${s.cooldownSeconds}s)`);
      return bits.join(' ');
    });
    embed.addFields({ name: 'Combat skills', value: joinLines(lines, 8), inline: false });
  }

  if (p.maxLevelBuffs?.attrs?.length) {
    embed.addFields({
      name: `Owner buffs (at pet Lv ${p.maxLevelBuffs.level})`,
      value: joinLines(p.maxLevelBuffs.attrs.map(fmtStat), 10),
      inline: false,
    });
  }

  if (Array.isArray(p.namedUnlocks) && p.namedUnlocks.length) {
    const lines = p.namedUnlocks.map((u) => `Lv ${u.level} — **${u.name}**${u.desc ? `: ${trunc(u.desc, 120)}` : ''}`);
    embed.addFields({ name: 'Skill unlocks', value: joinLines(lines, 8), inline: false });
  }

  const bs = p.battleStats;
  if (bs?.stats) {
    const s = bs.stats;
    embed.addFields({
      name: `Battle stats (Lv ${bs.level ?? '?'})`,
      value: `ATK **${s.atk ?? '—'}** · DEF **${s.def ?? '—'}** · M.ATK **${s.matk ?? '—'}** · M.DEF **${s.mdef ?? '—'}** · HP **${s.maxHp ?? '—'}**`,
      inline: false,
    });
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pet')
    .setDescription('Look up a pet — rarity, combat skills, owner buffs, and battle stats.')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Pet name (pick from the suggestions)')
        .setRequired(true)
        .setAutocomplete(true)),

  autocomplete: buildAutocomplete((q, limit) => db.searchPets(q, limit), label),

  // Public (not ephemeral), like the other rodb commands.
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply(NOT_AVAILABLE_MSG);
      return;
    }

    await interaction.deferReply(); // public

    try {
      const input = interaction.options.getString('name');
      const pet = await resolveSelection(input, {
        getById: (id) => db.getPet(id),
        search: (q, limit) => db.searchPets(q, limit),
      });

      if (!pet || !pet.name) {
        await interaction.editReply(notFoundMsg('pet', input));
        return;
      }

      await interaction.editReply({ embeds: [buildEmbed(pet)] });
    } catch (err) {
      console.warn('[pet] Lookup failed:', err?.message || err);
      await interaction.editReply("Couldn't load that pet right now — please try again in a moment.");
    }
  },
};
