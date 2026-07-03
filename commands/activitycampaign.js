// ---------------------------------------------------------------------------
// /activitycampaign — launch-day recruitment pulse check (Godfathers only).
//
//   /activitycampaign start [channel]  — activate (or MOVE) the campaign;
//                                        posts the sticky Yes/No prompt.
//                                        channel defaults to where it's run.
//   /activitycampaign stop             — deactivate + delete the sticky.
//   /activitycampaign status           — ephemeral results: this week's
//                                        Yes/No tallies + name lists, and
//                                        all-time totals.
//
// The prompt's BUTTONS are open to everyone; only this command is role-gated.
// All persistence lives in activitycampaign/db.js (graceful degrade — DB down
// means the command replies "unavailable" instead of erroring).
// ---------------------------------------------------------------------------

const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const db = require('../activitycampaign/db');
const sticky = require('../activitycampaign/sticky');
const {
  GODFATHERS_ROLE_ID,
  STATUS_LIST_CAP,
  IDS,
  FIELDS,
  PROMPT_TEXT,
  MESSAGE_MAX_LENGTH,
} = require('../activitycampaign/constants');

// Returns true only if the member holds the Godfathers role.
function isGodfather(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return Boolean(member.roles?.cache?.has?.(GODFATHERS_ROLE_ID));
}

// Render a display-name list capped at STATUS_LIST_CAP with a "+N more" trailer.
function renderNameList(docs) {
  if (!docs.length) return '—';
  const names = docs.map(d => d.displayName || d.username || d.userId);
  const shown = names.slice(0, STATUS_LIST_CAP);
  const extra = names.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` … +${extra} more` : '');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('activitycampaign')
    .setDescription('Launch-day pulse check — sticky Yes/No prompt (Godfathers only).')
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('Start the campaign (or move it) — posts the sticky prompt.')
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('Channel for the prompt (defaults to this channel).')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        ),
    )
    .addSubcommand(sub =>
      sub.setName('stop').setDescription('Stop the campaign and remove the sticky prompt.'),
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription("Show this week's Yes/No results and all-time totals."),
    ),

  async execute(interaction) {
    // Godfathers gate — everything in this command, including status.
    if (!isGodfather(interaction)) {
      await interaction.reply({
        content: "Sorry — you don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    // Graceful degradation — persistence unavailable means no campaign ops.
    if (!db.isReady()) {
      await interaction.reply({
        content: '⚠️ The activity campaign is unavailable right now (database not reachable). Please try again later.',
        ephemeral: true,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    // -----------------------------------------------------------------------
    // start [channel]
    // -----------------------------------------------------------------------
    if (sub === 'start') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;

      if (!channel?.isTextBased?.() || !interaction.guild) {
        await interaction.reply({
          content: '⚠️ Pick a text channel I can post in.',
          ephemeral: true,
        });
        return;
      }

      // Check the bot can actually post there before showing the modal (an
      // ephemeral deny is a valid first response — no modal shown).
      const me = interaction.guild.members.me;
      const perms = me ? channel.permissionsFor(me) : null;
      if (perms && !(perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.SendMessages))) {
        await interaction.reply({
          content: `⚠️ I can't post in ${channel} — I need **View Channel** and **Send Messages** there.`,
          ephemeral: true,
        });
        return;
      }

      // Prefill the modal with the last-used message (so re-running is one
      // keystroke), falling back to the default constant.
      const cfg = await db.getConfig();
      const prefill = (cfg?.promptText && cfg.promptText.trim()) ? cfg.promptText : PROMPT_TEXT;

      const messageInput = new TextInputBuilder()
        .setCustomId(FIELDS.MESSAGE)
        .setLabel('Prompt message members will see')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(MESSAGE_MAX_LENGTH)
        .setValue(prefill);

      const modal = new ModalBuilder()
        // Target channel encoded in the customId — the submit handler reads it
        // back (restart-safe, no in-memory state).
        .setCustomId(`${IDS.START_MODAL_PREFIX}:${channel.id}`)
        .setTitle('Start Activity Campaign')
        .addComponents(new ActionRowBuilder().addComponents(messageInput));

      // showModal MUST be the first response — no deferReply before it.
      await interaction.showModal(modal);
      return;
    }

    // -----------------------------------------------------------------------
    // stop
    // -----------------------------------------------------------------------
    if (sub === 'stop') {
      await interaction.deferReply({ ephemeral: true });
      const wasActive = await sticky.stop(interaction.client);
      await interaction.editReply(
        wasActive
          ? '🛑 Campaign stopped — the sticky prompt has been removed. Answers are kept; `/activitycampaign status` still works.'
          : 'ℹ️ No campaign is currently active.',
      );
      return;
    }

    // -----------------------------------------------------------------------
    // status
    // -----------------------------------------------------------------------
    if (sub === 'status') {
      await interaction.deferReply({ ephemeral: true });

      const [cfg, weekDocs, allTime] = await Promise.all([
        db.getConfig(),
        db.getWeekResponses(sticky.weekKeyForDate()),
        db.getAllTimeTotals(),
      ]);

      const yes = weekDocs.filter(d => d.answer === 'yes');
      const no = weekDocs.filter(d => d.answer === 'no');

      const lines = [
        '📊 **Activity Campaign — status**',
        cfg?.active
          ? `Campaign: 🟢 active in <#${cfg.channelId}>`
          : 'Campaign: ⚫ inactive',
        '',
        `**This week (${sticky.weekKeyForDate()}, UTC):**`,
        `✅ Yes: **${yes.length}** · ❌ No: **${no.length}** · Unique responders: **${weekDocs.length}**`,
        `✅ ${renderNameList(yes)}`,
        `❌ ${renderNameList(no)}`,
        '',
        allTime
          ? `**All-time:** ✅ ${allTime.yes} yes · ❌ ${allTime.no} no · ${allTime.uniqueResponders} unique responders (weekly answers, all weeks)`
          : '**All-time:** unavailable',
      ];

      await interaction.editReply(lines.join('\n'));
      return;
    }
  },
};
