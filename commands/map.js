const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../rodb/db');
const {
  FOOTER, DEFAULT_COLOR, joinLines, buildAutocomplete, resolveSelection,
  NOT_AVAILABLE_MSG, notFoundMsg,
} = require('../rodb/format');

// 40 duplicate map names across regions — label disambiguates by region/id.
const label = (m) => `${m.name} (${m.region ?? `map ${m._id}`})`;

const FAMILY_BADGES = { mvp: '👑 MVP', mini: '⭐ Mini', elite: '🔶 Elite' };

// "👑 MVP Angeling — 3 spawn spots"
function spawnLine(s) {
  const badge = FAMILY_BADGES[s.family];
  const name = badge ? `${badge} ${s.name}` : s.name;
  return s.spawnSpots ? `${name} — ${s.spawnSpots} spawn spot${s.spawnSpots === 1 ? '' : 's'}` : name;
}

function buildEmbed(m) {
  const headBits = [];
  if (m.region) headBits.push(`Region: ${m.region}`);
  if (m.isWorldHub) headBits.push('Open-world region hub');

  const embed = new EmbedBuilder()
    .setTitle(m.name)
    .setColor(DEFAULT_COLOR)
    .setDescription(headBits.join(' · ') || null)
    .setFooter({ text: FOOTER });

  // Minimap is a big picture — use image, not thumbnail.
  if (m.imageUrl) embed.setImage(m.imageUrl);

  // Spawn data is PARTIAL in the snapshot (36 of 354 maps, skewed to event
  // content) — label it honestly either way, never imply global coverage.
  if (Array.isArray(m.spawns) && m.spawns.length) {
    embed.addFields({
      name: 'Known spawns (partial/event data)',
      value: joinLines(m.spawns.map(spawnLine), 12),
      inline: false,
    });
  } else {
    embed.addFields({
      name: 'Spawns',
      value: 'No spawn data for this map in the snapshot — spawn coverage is partial (mostly event maps).',
      inline: false,
    });
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('map')
    .setDescription('Look up a map — region, minimap, and known monster spawns.')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Map name (pick from the suggestions)')
        .setRequired(true)
        .setAutocomplete(true)),

  autocomplete: buildAutocomplete((q, limit) => db.searchMaps(q, limit), label),

  // Public (not ephemeral), like /kudosboard.
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply(NOT_AVAILABLE_MSG);
      return;
    }

    await interaction.deferReply(); // public

    try {
      const input = interaction.options.getString('name');
      const map = await resolveSelection(input, {
        getById: (id) => db.getMap(id),
        search: (q, limit) => db.searchMaps(q, limit),
      });

      if (!map || !map.name) {
        await interaction.editReply(notFoundMsg('map', input));
        return;
      }

      await interaction.editReply({ embeds: [buildEmbed(map)] });
    } catch (err) {
      console.warn('[map] Lookup failed:', err?.message || err);
      await interaction.editReply("Couldn't load that map right now — please try again in a moment.");
    }
  },
};
