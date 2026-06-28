const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { REVIEWER_ROLE_IDS } = require('../guildapp/constants');
const { OFFICER_ROLE_IDS } = require('../officerapp/constants');
const { PARTYFINDER_ROLE_IDS } = require('../partyfinder/constants');

// ---------------------------------------------------------------------------
// Command metadata — single source of truth for the help list.
// Each entry: { name, usage, description, category, access }
//   access: 'everyone' | array of role IDs (same constants the commands use)
// ---------------------------------------------------------------------------
const COMMANDS = [
  {
    name: 'help',
    usage: '/help',
    description: 'Shows the commands you can use, based on your roles.',
    category: 'General',
    access: 'everyone',
  },
  {
    name: 'ping',
    usage: '/ping',
    description: 'Checks that the bot is online and shows its response time.',
    category: 'General',
    access: 'everyone',
  },
  {
    name: 'guildapplication',
    usage: '/guildapplication',
    description: 'Posts the guild application form (with a Start button) so members can apply to join the guild.',
    category: 'General',
    access: 'everyone',
  },
  {
    name: 'jobad',
    usage: '/jobad',
    description: 'Posts an officer recruitment ad with an Apply button; submitted applications go to leadership for review.',
    category: 'Leadership',
    access: REVIEWER_ROLE_IDS,
  },
  {
    name: 'memberclasses',
    usage: '/memberclasses',
    description: 'Shows the member class breakdown — use All for counts across Main and Second Guild, or pick a class to list its members (optionally filtered to Daddy or Mummy).',
    category: 'Officers',
    access: Object.values(OFFICER_ROLE_IDS),
  },
  {
    name: 'partyfinder',
    usage: '/partyfinder',
    description: 'Posts the Party Finder card so members can start a class-balanced party or request a carry.',
    category: 'Party Finder',
    access: PARTYFINDER_ROLE_IDS,
  },
  {
    name: 'kudosboard',
    usage: '/kudosboard',
    description: 'Shows the kudos leaderboard. Give kudos by chatting `kudos @member` (up to 7/day).',
    category: 'Community',
    access: 'everyone',
  },
  {
    name: 'guildroster',
    usage: '/guildroster [guild]',
    description: 'Shows a guild roster as images — parties organized by raid group. Pick Daddy or Mummy (defaults to Daddy).',
    category: 'Community',
    access: 'everyone',
  },
  {
    name: 'profile',
    usage: '/profile [user]',
    description: 'Shows a member\'s kudos profile — total received, rank, and how many they\'ve given today.',
    category: 'Community',
    access: 'everyone',
  },
  {
    name: 'qna',
    usage: '/qna',
    description: 'Shows the top 10 quiz scorers. Answer the class-channel quiz questions to climb the board.',
    category: 'Quiz',
    access: 'everyone',
  },
];

// ---------------------------------------------------------------------------
// Category display config
// ---------------------------------------------------------------------------
const CATEGORY_META = {
  General:        { label: '📋 General',       color: 0x5865F2 },
  Leadership:     { label: '🛡️ Leadership',    color: 0x5865F2 },
  Officers:       { label: '⚔️ Officers',      color: 0x5865F2 },
  'Party Finder': { label: '🎮 Party Finder',  color: 0x5865F2 },
  Community:      { label: '🙌 Community',      color: 0x5865F2 },
  Quiz:           { label: '🎯 Quiz',          color: 0x5865F2 },
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show the commands available to you.'),

  async execute(interaction) {
    const memberRoles = interaction.member?.roles?.cache;

    // Determine which commands this member can use.
    const accessible = COMMANDS.filter(cmd => {
      if (cmd.access === 'everyone') return true;
      return Array.isArray(cmd.access) && cmd.access.some(id => memberRoles?.has(id));
    });

    // Group accessible commands by category, preserving CATEGORY_META order.
    const grouped = {};
    for (const cmd of accessible) {
      if (!grouped[cmd.category]) grouped[cmd.category] = [];
      grouped[cmd.category].push(cmd);
    }

    const guildName = interaction.guild?.name ?? 'Commands';
    const guildIcon = interaction.guild?.iconURL() ?? undefined;

    const embed = new EmbedBuilder()
      .setAuthor({ name: `${guildName} • Commands`, iconURL: guildIcon })
      .setThumbnail(guildIcon ?? null)
      .setDescription('Here are the commands available to you:')
      .setColor(0x5865F2)
      .setFooter({ text: guildName, iconURL: guildIcon })
      .setTimestamp();

    // Add one field per category that has at least one accessible command.
    for (const [category, cmds] of Object.entries(grouped)) {
      const meta = CATEGORY_META[category] ?? { label: category };
      const lines = cmds.map(cmd => `**${cmd.usage}** — ${cmd.description}`).join('\n');
      embed.addFields({ name: meta.label, value: lines, inline: false });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
