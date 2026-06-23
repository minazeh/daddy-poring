const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { CLASS_ROLE_BY_ID, ROLE_IDS } = require('../guildapp/constants');
const { OFFICER_ROLE_IDS } = require('../officerapp/constants');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a display string for a member list, truncating if needed.
 * Returns { text, total, shown } where text is ready to drop into an embed field.
 */
function buildMemberListText(names) {
  const total = names.length;
  if (total === 0) return { text: 'None', total: 0, shown: 0 };

  const MAX_CHARS = 980; // stay under 1024 field cap with a small buffer
  const lines = [];
  let charCount = 0;

  for (let i = 0; i < names.length; i++) {
    const line = `${i + 1}. ${names[i]}`;
    // +1 for newline
    if (charCount + line.length + 1 > MAX_CHARS) {
      const remaining = total - i;
      lines.push(`…and ${remaining} more`);
      return { text: lines.join('\n'), total, shown: i };
    }
    lines.push(line);
    charCount += line.length + 1;
  }

  return { text: lines.join('\n'), total, shown: total };
}

/**
 * Build a description string for a single-group view (4096 char cap on description).
 */
function buildDescriptionText(names) {
  const total = names.length;
  if (total === 0) return { text: 'None', total: 0 };

  const MAX_CHARS = 4000;
  const lines = [];
  let charCount = 0;

  for (let i = 0; i < names.length; i++) {
    const line = `${i + 1}. ${names[i]}`;
    if (charCount + line.length + 1 > MAX_CHARS) {
      const remaining = total - i;
      lines.push(`…and ${remaining} more`);
      return { text: lines.join('\n'), total };
    }
    lines.push(line);
    charCount += line.length + 1;
  }

  return { text: lines.join('\n'), total };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

module.exports = {
  data: new SlashCommandBuilder()
    .setName('memberclasses')
    .setDescription('Shows a breakdown of member counts by class for each guild.')
    .addStringOption(option =>
      option
        .setName('filter')
        .setDescription('Which class to filter by, or All for the full roster.')
        .setRequired(true)
        .addChoices(
          { name: 'All',         value: 'all'        },
          { name: 'Assassin',    value: 'assassin'   },
          { name: 'Hunter',      value: 'hunter'     },
          { name: 'Knight',      value: 'knight'     },
          { name: 'Priest',      value: 'priest'     },
          { name: 'Gunslinger',  value: 'gunslinger' },
          { name: 'Blacksmith',  value: 'blacksmith' },
          { name: 'Wizard',      value: 'wizard'     },
          { name: 'Druid',       value: 'druid'      },
        )
    )
    .addStringOption(option =>
      option
        .setName('group')
        .setDescription('Optionally limit to one guild group (Daddy or Mummy). Only applies to a specific class filter.')
        .setRequired(false)
        .addChoices(
          { name: 'Daddy', value: 'daddy' },
          { name: 'Mummy', value: 'mummy' },
        )
    ),

  async execute(interaction) {
    // Officer gate — must hold at least one officer role (Daddy or Mummy).
    const memberRoles = interaction.member?.roles?.cache;
    const hasPermission = memberRoles && Object.values(OFFICER_ROLE_IDS).some(id => memberRoles.has(id));
    if (!hasPermission) {
      return interaction.reply({
        content: 'Sorry — you don\'t have permission to use this command.',
        ephemeral: true,
      });
    }

    const filter = interaction.options.getString('filter');
    const group  = interaction.options.getString('group'); // 'daddy' | 'mummy' | null

    // -----------------------------------------------------------------------
    // ALL view — unchanged; group option is ignored here.
    // -----------------------------------------------------------------------
    if (filter === 'all') {
      await interaction.deferReply();

      try {
        await interaction.guild.members.fetch();

        const daddyId = ROLE_IDS.ACCEPTED;
        const mummyId = ROLE_IDS.MUMMY;

        const rows = Object.entries(CLASS_ROLE_BY_ID).map(([classRoleId, className]) => {
          const classRole = interaction.guild.roles.cache.get(classRoleId);
          if (!classRole) return { className, daddy: 0, mummy: 0 };

          const classMembers = classRole.members;
          const daddy = classMembers.filter(m => m.roles.cache.has(daddyId)).size;
          const mummy = classMembers.filter(m => m.roles.cache.has(mummyId)).size;
          return { className, daddy, mummy };
        });

        const pad = rows.reduce((max, r) => Math.max(max, r.className.length), 0);

        const daddyLines = rows
          .map(r => `${r.className.padEnd(pad)} — ${r.daddy}`)
          .join('\n');
        const daddyTotal = rows.reduce((sum, r) => sum + r.daddy, 0);

        const mummyLines = rows
          .map(r => `${r.className.padEnd(pad)} — ${r.mummy}`)
          .join('\n');
        const mummyTotal = rows.reduce((sum, r) => sum + r.mummy, 0);

        const embed = new EmbedBuilder()
          .setTitle('Member Classes — Roster Breakdown')
          .setColor(0x5865F2)
          .addFields(
            {
              name: '👑 Daddy (Main Guild)',
              value: `\`\`\`\n${daddyLines}\n${'─'.repeat(pad + 6)}\n${'Total'.padEnd(pad)} — ${daddyTotal}\n\`\`\``,
              inline: false,
            },
            {
              name: '​',
              value: '​',
              inline: false,
            },
            {
              name: '💜 Mummy (Second Guild)',
              value: `\`\`\`\n${mummyLines}\n${'─'.repeat(pad + 6)}\n${'Total'.padEnd(pad)} — ${mummyTotal}\n\`\`\``,
              inline: false,
            },
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.warn('[memberclasses] Failed to fetch members or build embed:', err);
        await interaction.editReply({
          content: 'Something went wrong fetching member data. Please try again in a moment.',
        });
      }

      return;
    }

    // -----------------------------------------------------------------------
    // PER-CLASS view.
    // -----------------------------------------------------------------------
    await interaction.deferReply(); // public

    try {
      await interaction.guild.members.fetch();

      const daddyId = ROLE_IDS.ACCEPTED;
      const mummyId = ROLE_IDS.MUMMY;

      // Resolve class role — value is lowercase, map values are proper-case.
      const classEntry = Object.entries(CLASS_ROLE_BY_ID).find(
        ([, name]) => name.toLowerCase() === filter.toLowerCase()
      );

      if (!classEntry) {
        return interaction.editReply({
          content: `Could not find a class role matching "${filter}". This is likely a configuration issue — please let an admin know.`,
        });
      }

      const [classRoleId, className] = classEntry;
      const classRole = interaction.guild.roles.cache.get(classRoleId);

      if (!classRole) {
        return interaction.editReply({
          content: `The role for **${className}** wasn't found in this server. It may have been deleted or the ID is out of date.`,
        });
      }

      // Filter members: must have the class role + Daddy OR Mummy.
      // Members with neither affiliation are excluded.
      const classMembers = classRole.members;

      const daddyNames = classMembers
        .filter(m => m.roles.cache.has(daddyId))
        .map(m => m.displayName)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const mummyNames = classMembers
        .filter(m => m.roles.cache.has(mummyId))
        .map(m => m.displayName)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      // -----------------------------------------------------------------------
      // Single-group view (group option provided).
      // -----------------------------------------------------------------------
      if (group === 'daddy') {
        const { text, total } = buildDescriptionText(daddyNames);
        const embed = new EmbedBuilder()
          .setTitle(`${className} — 👑 Daddy (Main Guild)`)
          .setDescription(`**Total: ${total}**\n\n${text}`)
          .setColor(0xFFD700)
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      if (group === 'mummy') {
        const { text, total } = buildDescriptionText(mummyNames);
        const embed = new EmbedBuilder()
          .setTitle(`${className} — 💜 Mummy (Second Guild)`)
          .setDescription(`**Total: ${total}**\n\n${text}`)
          .setColor(0xB566D6)
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // -----------------------------------------------------------------------
      // Both-groups view (no group option).
      // -----------------------------------------------------------------------
      const daddy = buildMemberListText(daddyNames);
      const mummy = buildMemberListText(mummyNames);

      const embed = new EmbedBuilder()
        .setTitle(`${className} — Member Listing`)
        .setColor(0x5865F2)
        .addFields(
          {
            name: `👑 Daddy (Main Guild) — ${daddy.total}`,
            value: daddy.text,
            inline: false,
          },
          {
            name: '​',
            value: '​',
            inline: false,
          },
          {
            name: `💜 Mummy (Second Guild) — ${mummy.total}`,
            value: mummy.text,
            inline: false,
          },
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.warn('[memberclasses] Per-class fetch/build error:', err);
      await interaction.editReply({
        content: 'Something went wrong fetching member data. Please try again in a moment.',
      });
    }
  },
};
