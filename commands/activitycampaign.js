// ---------------------------------------------------------------------------
// /activitycampaign — launch-day recruitment pulse check (Godfathers only).
//
//   /activitycampaign start [channel]  — activate (or MOVE) the campaign;
//                                        posts the sticky Yes/No prompt.
//                                        channel defaults to where it's run.
//   /activitycampaign stop             — deactivate + delete the sticky.
//   /activitycampaign status           — PUBLIC results: this week's Yes/No
//                                        tallies + a capped name preview, plus
//                                        all-time totals. Full Yes/No lists are
//                                        attached as a text file when either
//                                        list exceeds the inline cap (so it
//                                        scales to hundreds/thousands without
//                                        hitting Discord's 2000-char limit).
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
  AttachmentBuilder,
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
  WEEK_TZ_LABEL,
} = require('../activitycampaign/constants');

// Returns true only if the member holds the Godfathers role.
function isGodfather(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return Boolean(member.roles?.cache?.has?.(GODFATHERS_ROLE_ID));
}

// A doc's best display name.
function nameOf(d) {
  return d.displayName || d.username || d.userId;
}

// Render a display-name preview: capped at STATUS_LIST_CAP names AND a hard
// character budget (long names can't blow the message cap), with a "+N more"
// trailer counting everyone omitted by either limit.
function renderNamePreview(docs) {
  if (!docs.length) return '—';
  const names = docs.map(nameOf);
  const CHAR_BUDGET = 500; // well within the 2000 content cap after other lines
  const shown = [];
  let len = 0;
  for (let i = 0; i < names.length && i < STATUS_LIST_CAP; i++) {
    const piece = names[i];
    if (len + piece.length + 2 > CHAR_BUDGET) break;
    shown.push(piece);
    len += piece.length + 2;
  }
  const extra = names.length - shown.length;
  return (shown.join(', ') || '…') + (extra > 0 ? ` … +${extra} more` : '');
}

// Build the full-list attachment (both Yes and No sections, every name) so no
// responder is lost when the inline preview is capped.
function buildFullListFile(weekLabel, yes, no) {
  const section = (title, docs) =>
    `${title} (${docs.length}):\n` + (docs.length ? docs.map(nameOf).join('\n') : '(none)');
  const body =
    `Activity Campaign — status\nWeek: ${weekLabel}\n\n` +
    section('YES', yes) + '\n\n' + section('NO', no) + '\n';
  return new AttachmentBuilder(Buffer.from(body, 'utf8'), { name: 'activity-campaign-status.txt' });
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
      // Results post PUBLICLY (not ephemeral). The deny + DB-unavailable
      // messages above stay ephemeral — only the actual results go public.
      await interaction.deferReply();

      const weekKey = sticky.weekKeyForDate();
      const [cfg, weekDocs, allTime] = await Promise.all([
        db.getConfig(),
        db.getWeekResponses(weekKey),
        db.getAllTimeTotals(),
      ]);

      const yes = weekDocs.filter(d => d.answer === 'yes');
      const no = weekDocs.filter(d => d.answer === 'no');
      const weekLabel = `${weekKey}, ${WEEK_TZ_LABEL}`;

      // Attach the full lists whenever either side exceeds the inline cap, so
      // nothing is lost and `content` never risks the 2000-char limit.
      const needFile = yes.length > STATUS_LIST_CAP || no.length > STATUS_LIST_CAP;

      const lines = [
        '📊 **Activity Campaign — status**',
        cfg?.active
          ? `Campaign: 🟢 active in <#${cfg.channelId}>`
          : 'Campaign: ⚫ inactive',
        '',
        `**This week (${weekLabel}):**`,
        `✅ Yes: **${yes.length}** · ❌ No: **${no.length}** · Unique responders: **${weekDocs.length}**`,
        `✅ ${renderNamePreview(yes)}`,
        `❌ ${renderNamePreview(no)}`,
        ...(needFile ? ['📎 Full Yes/No lists attached below.'] : []),
        '',
        allTime
          ? `**All-time:** ✅ ${allTime.yes} yes · ❌ ${allTime.no} no · ${allTime.uniqueResponders} unique responders (weekly answers, all weeks)`
          : '**All-time:** unavailable',
      ];

      // Final hard guard — never send >2000 chars of content (previews are
      // already bounded, but truncate defensively just in case).
      let content = lines.join('\n');
      if (content.length > 2000) content = content.slice(0, 1997) + '…';

      const payload = { content };
      if (needFile) payload.files = [buildFullListFile(weekLabel, yes, no)];

      await interaction.editReply(payload);
      return;
    }
  },
};
