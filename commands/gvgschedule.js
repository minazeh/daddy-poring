// ---------------------------------------------------------------------------
// /gvgschedule — weekly-recurring GvG attendance schedules (Godfathers only).
//
//   /gvgschedule add <day> <time> [guild] [duration] [label]
//       — register a weekly GvG time (HH:MM, 24 h, GMT+7) + arm its timer.
//   /gvgschedule list
//       — every schedule with its next fire time.
//   /gvgschedule remove <schedule>
//       — autocomplete pick; deletes the schedule + cancels its timer.
//
// When a schedule fires, gvg/capture.js watches the monitored VCs (see
// /gvgvc) for the schedule's duration and posts the attendance log. All
// persistence lives in gvg/db.js (graceful degrade — DB down means the
// command replies "unavailable" instead of erroring).
// ---------------------------------------------------------------------------

const { SlashCommandBuilder } = require('discord.js');
const db = require('../gvg/db');
const scheduler = require('../gvg/scheduler');
const reminder = require('../gvg/reminder');
const {
  GODFATHERS_ROLE_ID,
  GVG_TZ_LABEL,
  DEFAULT_DURATION_MIN,
  MIN_DURATION_MIN,
  MAX_DURATION_MIN,
  DAYS,
  GUILDS,
  GUILD_LABELS,
  TIME_RE,
} = require('../gvg/constants');

// Returns true only if the member holds the Godfathers role.
function isGodfather(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return Boolean(member.roles?.cache?.has?.(GODFATHERS_ROLE_ID));
}

// One-line description of a schedule (lists, autocomplete, confirmations).
function describeSchedule(s) {
  const base = `${s.day} ${s.time} ${GVG_TZ_LABEL} · ${GUILD_LABELS[s.guild] || s.guild} · ${s.durationMin} min`;
  return s.label ? `${s.label} — ${base}` : base;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('gvgschedule')
    .setDescription('Manage weekly GvG attendance schedules (Godfathers only).')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Add a weekly GvG time — attendance is captured when it fires.')
        .addStringOption(opt =>
          opt
            .setName('day')
            .setDescription('Day of the week (GMT+7).')
            .setRequired(true)
            .addChoices(...DAYS.map(d => ({ name: d, value: d }))))
        .addStringOption(opt =>
          opt
            .setName('time')
            .setDescription(`Start time, 24 h HH:MM in ${GVG_TZ_LABEL} (e.g. 20:00).`)
            .setRequired(true))
        .addStringOption(opt =>
          opt
            .setName('guild')
            .setDescription('Which guild\'s VCs to check (default: Both).')
            .setRequired(false)
            .addChoices(
              { name: 'Daddy', value: GUILDS.DADDY },
              { name: 'Mummy', value: GUILDS.MUMMY },
              { name: 'Both', value: GUILDS.BOTH },
            ))
        .addIntegerOption(opt =>
          opt
            .setName('duration')
            .setDescription(`Capture window in minutes (default ${DEFAULT_DURATION_MIN}).`)
            .setRequired(false)
            .setMinValue(MIN_DURATION_MIN)
            .setMaxValue(MAX_DURATION_MIN))
        .addStringOption(opt =>
          opt
            .setName('label')
            .setDescription('Optional friendly name (e.g. "Midweek GvG").')
            .setRequired(false)
            .setMaxLength(80)))
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List all GvG schedules and their next fire times.'))
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Remove a GvG schedule (cancels its timer).')
        .addStringOption(opt =>
          opt
            .setName('schedule')
            .setDescription('Which schedule to remove.')
            .setRequired(true)
            .setAutocomplete(true))),

  // Autocomplete for remove → schedule: match label/day/time, value = _id.
  async autocomplete(interaction) {
    const q = (interaction.options.getFocused() || '').toLowerCase();
    const schedules = await db.getSchedules();
    const choices = schedules
      .filter(s => !q || describeSchedule(s).toLowerCase().includes(q))
      .slice(0, 25)
      .map(s => ({ name: describeSchedule(s).slice(0, 100), value: String(s._id) }));
    await interaction.respond(choices);
  },

  async execute(interaction) {
    // Godfathers gate — ephemeral deny for everyone else.
    if (!isGodfather(interaction)) {
      await interaction.reply({
        content: "Sorry — you don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    // Graceful degradation — persistence unavailable means no schedule ops.
    if (!db.isReady()) {
      await interaction.reply({
        content: '⚠️ GvG scheduling is unavailable right now (database not reachable). Please try again later.',
        ephemeral: true,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    // -----------------------------------------------------------------------
    // add
    // -----------------------------------------------------------------------
    if (sub === 'add') {
      const day = interaction.options.getString('day');
      const time = interaction.options.getString('time');
      const guild = interaction.options.getString('guild') ?? GUILDS.BOTH;
      const durationMin = interaction.options.getInteger('duration') ?? DEFAULT_DURATION_MIN;
      const label = interaction.options.getString('label')?.trim() || null;

      if (!TIME_RE.test(time)) {
        await interaction.reply({
          content: `⚠️ \`${time}\` isn't a valid time — use 24 h **HH:MM** in ${GVG_TZ_LABEL} (e.g. \`20:00\`, \`09:30\`).`,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const doc = await db.addSchedule({
        day, time, guild, durationMin, label,
        guildId: interaction.guildId,
        createdBy: interaction.user.id,
      });
      if (!doc) {
        await interaction.editReply('⚠️ Could not save the schedule — database not reachable. Try again later.');
        return;
      }

      const nextAt = scheduler.armSchedule(interaction.client, doc);
      const nextTs = Math.floor(nextAt.getTime() / 1000);
      await interaction.editReply(
        `✅ GvG schedule added: **${describeSchedule(doc)}**\n` +
        `Next capture: <t:${nextTs}:F> (<t:${nextTs}:R>). ` +
        'Attendance in the monitored VCs (`/gvgvc list`) will be logged when it fires.',
      );
      return;
    }

    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------
    if (sub === 'list') {
      await interaction.deferReply({ ephemeral: true });
      const schedules = await db.getSchedules();
      if (!schedules.length) {
        await interaction.editReply('No GvG schedules yet — add one with `/gvgschedule add`.');
        return;
      }
      const lines = schedules.map(s => {
        const nextAt = scheduler.nextOccurrence(s.day, s.time);
        const ts = Math.floor(nextAt.getTime() / 1000);
        return `• **${describeSchedule(s)}** — next <t:${ts}:F> (<t:${ts}:R>)\n  id: \`${s._id}\``;
      });
      let content = `📅 **GvG schedules (${schedules.length})**\n` + lines.join('\n');
      if (content.length > 2000) content = content.slice(0, 1997) + '…';
      await interaction.editReply(content);
      return;
    }

    // -----------------------------------------------------------------------
    // remove
    // -----------------------------------------------------------------------
    if (sub === 'remove') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.options.getString('schedule');
      const removed = await db.removeSchedule(id);
      if (!removed) {
        await interaction.editReply('⚠️ That schedule wasn\'t found — it may have already been removed. Check `/gvgschedule list`.');
        return;
      }
      scheduler.cancelSchedule(id);

      // Delete-mid-window teardown (spec §5.5): if this schedule has an active
      // Guild Event reminder, tear it down — delete the sticky, final-flush the
      // in-memory RSVPs, and annotate the tally as removed. Graceful-degrade:
      // never let a teardown error fail the removal the user already asked for.
      let tornDown = 0;
      try {
        tornDown = await reminder.teardownForSchedule(interaction.client, id);
      } catch (err) {
        console.warn('[gvgschedule] Reminder teardown on remove failed (schedule still removed):', err?.message || err);
      }

      const reminderNote = tornDown > 0 ? ' Its active reminder was taken down too.' : '';
      await interaction.editReply(`🗑️ Removed GvG schedule: **${describeSchedule(removed)}** — its timers are cancelled.${reminderNote}`);
      return;
    }
  },
};
