const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { REVIEWER_ROLE_IDS } = require('../guildapp/constants');
const { OFFICER_ROLE_IDS } = require('../officerapp/constants');
const { PARTYFINDER_ROLE_IDS } = require('../partyfinder/constants');
const { GODFATHERS_ROLE_ID } = require('../activitycampaign/constants');
const { GODFATHERS_ROLE_ID: GVG_GODFATHERS_ROLE_ID } = require('../gvg/constants');
const { GODFATHERS_ROLE_ID: RR_GODFATHERS_ROLE_ID } = require('../reactionrole/constants');

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
    name: 'activitycampaign',
    usage: '/activitycampaign start|stop|status',
    description: 'Runs the launch-day pulse check — posts a sticky Yes/No prompt that stays at the bottom of the channel and tracks weekly answers.',
    category: 'Leadership',
    access: [GODFATHERS_ROLE_ID],
  },
  {
    name: 'gvgschedule',
    usage: '/gvgschedule add|list|remove',
    description: 'Manages weekly GvG attendance schedules (day + time GMT+7) — when one fires, the bot records who is in the monitored voice channels and posts an attendance log.',
    category: 'Leadership',
    access: [GVG_GODFATHERS_ROLE_ID],
  },
  {
    name: 'gvgvc',
    usage: '/gvgvc add|list|remove',
    description: 'Manages the voice channels monitored for GvG attendance — tag each VC Daddy or Mummy so attendees are checked against the right roster.',
    category: 'Leadership',
    access: [GVG_GODFATHERS_ROLE_ID],
  },
  {
    name: 'guildexpedition',
    usage: '/guildexpedition [channel]',
    description: 'Posts the Guild Expedition sign-up embed — members react ✅ to get the Guild Expedition role and remove the reaction to drop it.',
    category: 'Leadership',
    access: [RR_GODFATHERS_ROLE_ID],
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
  {
    name: 'monsterquiz',
    usage: '/monsterquiz [questions]',
    description: 'Starts an anagram quiz — unscramble monster, item, and card names from the game database. Tap Join to play; first correct answer each round scores.',
    category: 'Community',
    access: 'everyone',
  },
  {
    name: 'monster',
    usage: '/monster <name>',
    description: 'Looks up a monster — stats, element, race, and drop rates. Data from roworlddb.com.',
    category: 'Game Database',
    access: 'everyone',
  },
  {
    name: 'item',
    usage: '/item <name>',
    description: 'Looks up equipment — stats, effects, refine bonuses, and job limits. Data from roworlddb.com.',
    category: 'Game Database',
    access: 'everyone',
  },
  {
    name: 'card',
    usage: '/card <name>',
    description: 'Looks up a card — effect, equip slot, and which monsters drop it. Data from roworlddb.com.',
    category: 'Game Database',
    access: 'everyone',
  },
  {
    name: 'map',
    usage: '/map <name>',
    description: 'Looks up a map — region, minimap, and known monster spawns. Data from roworlddb.com.',
    category: 'Game Database',
    access: 'everyone',
  },
  {
    name: 'skill',
    usage: '/skill <name> [class]',
    description: 'Looks up a skill — effect, SP cost, cooldown, and levels; filter suggestions by class. Data from roworlddb.com.',
    category: 'Game Database',
    access: 'everyone',
  },
  {
    name: 'rune',
    usage: '/rune <name>',
    description: 'Looks up a rune effect — per-level bonuses and element resonance. Data from roworlddb.com.',
    category: 'Game Database',
    access: 'everyone',
  },
  {
    name: 'refine',
    usage: '/refine [level]',
    description: 'Shows refine odds and materials — one level or the full +0→+20 table. Data from roworlddb.com.',
    category: 'Game Database',
    access: 'everyone',
  },
  {
    name: 'pet',
    usage: '/pet <name>',
    description: 'Looks up a pet — rarity, combat skills, owner buffs, and battle stats. Data from roworlddb.com.',
    category: 'Game Database',
    access: 'everyone',
  },
  {
    name: 'shop',
    usage: '/shop <name>',
    description: 'Looks up an NPC shop listing — which store sells it, price, and limits. Data from roworlddb.com.',
    category: 'Game Database',
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
  'Game Database': { label: '📖 Game Database', color: 0x5865F2 },
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
    // Discord caps an embed field value at 1024 chars. A busy category (e.g.
    // Game Database) can exceed that, and addFields then throws — which made
    // /help fail for EVERYONE. Pack each category's lines into <=1024-char
    // chunks and emit one field per chunk; continuation chunks use a
    // zero-width-space name so they read as one continuous section.
    const FIELD_VALUE_LIMIT = 1024;
    const CONTINUATION_NAME = '\u200b'; // zero-width space (valid non-empty field name)
    for (const [category, cmds] of Object.entries(grouped)) {
      const meta = CATEGORY_META[category] ?? { label: category };
      const lines = cmds.map(cmd => `**${cmd.usage}** — ${cmd.description}`);

      const chunks = [];
      let current = '';
      for (const line of lines) {
        const candidate = current ? `${current}\n${line}` : line;
        if (candidate.length > FIELD_VALUE_LIMIT && current) {
          chunks.push(current);
          current = line;
        } else {
          current = candidate;
        }
      }
      if (current) chunks.push(current);

      chunks.forEach((value, i) => {
        embed.addFields({ name: i === 0 ? meta.label : CONTINUATION_NAME, value, inline: false });
      });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
