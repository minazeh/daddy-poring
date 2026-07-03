const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../rodb/db');
const {
  FOOTER, DEFAULT_COLOR, clampField, choiceLabel, resolveSelection,
  NOT_AVAILABLE_MSG, notFoundMsg,
} = require('../rodb/format');

// Skill kind → accent color (regular blue, unique purple, career trait gold).
const KIND_COLORS = { Skill: 0x3498db, Unique: 0x9b59b6, Trait: 0xf1c40f };

// 39 skill names repeat across classes — label disambiguates by job.
const label = (s) => `${s.name} (${(s.jobs || [])[0] ?? 'Unknown'}${s.kind !== 'Skill' ? ` · ${s.kind}` : ''})`;

const fmtSeconds = (ms) => (typeof ms === 'number' && ms > 0 ? `${(ms / 1000).toLocaleString('en-US')} s` : null);

function buildEmbed(s) {
  const headBits = [(s.jobs || []).join(' · ') || 'Unknown class'];
  if (s.kind === 'Unique') headBits.push('Unique skill');
  if (s.kind === 'Trait') headBits.push('Career trait');
  if (Array.isArray(s.tags) && s.tags.length) headBits.push(s.tags.join(' / '));

  const embed = new EmbedBuilder()
    .setTitle(s.name)
    .setColor(KIND_COLORS[s.kind] ?? DEFAULT_COLOR)
    .setDescription(headBits.join('\n'))
    .setFooter({ text: FOOTER });

  if (s.imageUrl) embed.setThumbnail(s.imageUrl);

  // Effect text at the natural max level (endgame-relevant); fall back to the
  // base description if per-level text is missing.
  const levels = Array.isArray(s.levels) ? s.levels : [];
  const atMax = levels.find((l) => l.level === s.naturalMaxLevel) || levels[levels.length - 1] || null;
  const effect = atMax?.desc || s.description;
  if (effect) {
    embed.addFields({
      name: `Effect (Lv ${atMax?.level ?? '?'})`,
      value: clampField(effect),
      inline: false,
    });
  }

  // Cost / cooldown / range from the same level.
  const costBits = [];
  if (atMax?.spCost) costBits.push(`SP **${atMax.spCost}**`);
  const cd = fmtSeconds(atMax?.cooldownMs);
  if (cd) costBits.push(`Cooldown **${cd}**`);
  if (atMax?.rangeMax) costBits.push(`Range **${atMax.rangeMax} m**`);
  if (costBits.length) {
    embed.addFields({ name: 'Cost', value: costBits.join(' · '), inline: true });
  }

  const lvlBits = [`Natural max **Lv ${s.naturalMaxLevel ?? '?'}**`];
  if (s.maxLevel && s.maxLevel !== s.naturalMaxLevel) lvlBits.push(`breakthrough to **Lv ${s.maxLevel}**`);
  embed.addFields({ name: 'Levels', value: lvlBits.join(' · '), inline: true });

  // Compact SP progression when it varies across levels.
  const spByLevel = levels.filter((l) => l.spCost != null);
  if (spByLevel.length > 1) {
    const first = spByLevel[0];
    const last = spByLevel[spByLevel.length - 1];
    if (first.spCost !== last.spCost) {
      embed.addFields({
        name: 'SP by level',
        value: `Lv ${first.level}: ${first.spCost} → Lv ${last.level}: ${last.spCost}`,
        inline: true,
      });
    }
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('skill')
    .setDescription('Look up a skill — effect, SP cost, cooldown, and levels. Filter by class.')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Skill name (pick from the suggestions)')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption((opt) =>
      opt
        .setName('class')
        .setDescription('Only suggest skills of this class/job')
        .setRequired(false)
        .setAutocomplete(true)),

  // Two autocompleted options: `class` completes from the snapshot's job
  // list; `name` searches skills, narrowed by the chosen class when set.
  // Mirrors rodb/format buildAutocomplete's never-throw contract.
  async autocomplete(interaction) {
    let choices = [];
    try {
      const focused = interaction.options.getFocused(true);
      if (focused.name === 'class') {
        const q = String(focused.value || '').trim().toLowerCase();
        const jobs = await db.getSkillJobs();
        choices = jobs
          .filter((j) => !q || j.toLowerCase().includes(q))
          .slice(0, 25)
          .map((j) => ({ name: choiceLabel(j), value: j }));
      } else {
        const jobFilter = interaction.options.getString('class');
        const docs = await db.searchSkills(focused.value ?? '', 25, jobFilter);
        const seen = new Map();
        choices = docs
          .filter((d) => d.name)
          .slice(0, 25)
          .map((d) => {
            let lbl = label(d);
            const n = seen.get(lbl) || 0;
            seen.set(lbl, n + 1);
            if (n > 0) lbl = `${lbl} [#${d._id}]`;
            return { name: choiceLabel(lbl), value: String(d._id) };
          });
      }
    } catch (err) {
      console.warn('[skill] autocomplete failed:', err?.message || err);
      choices = [];
    }
    try {
      await interaction.respond(choices);
    } catch (err) {
      console.warn('[skill] autocomplete respond failed:', err?.message || err);
    }
  },

  // Public (not ephemeral), like the other rodb commands.
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply(NOT_AVAILABLE_MSG);
      return;
    }

    await interaction.deferReply(); // public

    try {
      const input = interaction.options.getString('name');
      const jobFilter = interaction.options.getString('class');
      const skill = await resolveSelection(input, {
        getById: (id) => db.getSkill(id),
        search: (q, limit) => db.searchSkills(q, limit, jobFilter),
      });

      if (!skill || !skill.name) {
        await interaction.editReply(notFoundMsg('skill', input));
        return;
      }

      await interaction.editReply({ embeds: [buildEmbed(skill)] });
    } catch (err) {
      console.warn('[skill] Lookup failed:', err?.message || err);
      await interaction.editReply("Couldn't load that skill right now — please try again in a moment.");
    }
  },
};
