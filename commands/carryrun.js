// ---------------------------------------------------------------------------
// /carryrun — create / delete / close / edit Final Mirage carry runs.
// Godfathers only.
//
// Spec: docs/CARRY_SYSTEM_SPEC.md §6
//
//   /carryrun create <tier> <date> <time>   opens a run, posts its board message
//   /carryrun list                          every live run and its occupancy
//   /carryrun close  <run>                  stops accepting joins; board stays
//   /carryrun edit   <run> <date> <time>    reschedules; board updates in place
//   /carryrun delete <run>                  removes the run + its board message
//
// RUNS ARE CREATED AND REMOVED MANUALLY. There is no recurring template and no
// auto-rollover (Conrad, 2026-08-24).
//
// `create` takes tier and date/time only — CAPACITY FOLLOWS
// FROM THE TIER, so they are never entered by hand and can't drift from the
// product spec (§3).
//
// The spec writes the time argument as a single `<datetime>`; it is taken here
// as separate `date` and `time` options because Discord shows each option its
// own hint text, which is what stops "30/08" and "8pm" arriving. Same
// information, same GMT+7 basis as /gvgschedule.
//
// `delete` REFUSES while the run holds any paid booking (§6.1) — see the guard
// in carry/handlers.deleteRunAndBoard.
// ---------------------------------------------------------------------------

const { SlashCommandBuilder, MessageFlags } = require('discord.js');

const db = require('../carry/db');
const handlers = require('../carry/handlers');
const {
  CHANNELS,
  TIERS,
  TIER_KEYS,
  tierFor,
  DATE_RE,
  TIME_RE,
  TIME_ZONE_DISPLAY,
  TIME_ZONE_LABEL,
  RUN_STATUS,
  SEAT_STATUS,
} = require('../carry/constants');

const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });

function describeRun(run) {
  const { taken, total } = handlers.seatCounts(run);
  const tier = tierFor(run.tier);
  return `${tier ? tier.label : run.tier} — ${handlers.formatGmt7(run.startAt)} · ${taken}/${total} · ${run.status}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('carryrun')
    .setDescription('Manage Final Mirage carry runs (Godfathers only).')
    .addSubcommand(sub =>
      sub
        .setName('create')
        .setDescription('Open a carry run and post its board message.')
        .addStringOption(opt =>
          opt
            .setName('tier')
            .setDescription('Which carry tier — capacity follows from this.')
            .setRequired(true)
            .addChoices(...TIER_KEYS.map(key => ({
              name: `${TIERS[key].label} — $${TIERS[key].priceUsd} · ${TIERS[key].slots} slots`,
              value: key,
            }))))
        .addStringOption(opt =>
          opt
            .setName('date')
            .setDescription(`Run date, YYYY-MM-DD in ${TIME_ZONE_LABEL} (e.g. 2026-08-30).`)
            .setRequired(true))
        .addStringOption(opt =>
          opt
            .setName('time')
            .setDescription(`Start time, 24 h HH:MM in ${TIME_ZONE_LABEL} (e.g. 20:00).`)
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List every live carry run and its occupancy.'))
    .addSubcommand(sub =>
      sub
        .setName('close')
        .setDescription('Stop a run accepting new bookings. Its board message stays up.')
        .addStringOption(opt =>
          opt.setName('run').setDescription('Which run to close.').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub =>
      sub
        .setName('edit')
        .setDescription('Reschedule a run — its board message updates in place.')
        .addStringOption(opt =>
          opt.setName('run').setDescription('Which run to reschedule.').setRequired(true).setAutocomplete(true))
        .addStringOption(opt =>
          opt
            .setName('date')
            .setDescription(`New date, YYYY-MM-DD in ${TIME_ZONE_LABEL}.`)
            .setRequired(true))
        .addStringOption(opt =>
          opt
            .setName('time')
            .setDescription(`New start time, 24 h HH:MM in ${TIME_ZONE_LABEL}.`)
            .setRequired(true)))
    .addSubcommand(sub =>
      sub
        .setName('delete')
        .setDescription('Remove a run and its board message. Refused while it holds paid bookings.')
        .addStringOption(opt =>
          opt.setName('run').setDescription('Which run to remove.').setRequired(true).setAutocomplete(true))),

  // Autocomplete for run → every live run, soonest first. Value = run _id.
  async autocomplete(interaction) {
    try {
      const q = (interaction.options.getFocused() || '').toLowerCase();
      const runs = await db.listLiveRuns();
      const choices = runs
        .map(run => ({ name: describeRun(run).slice(0, 100), value: run._id }))
        .filter(c => !q || c.name.toLowerCase().includes(q))
        .slice(0, 25);
      await interaction.respond(choices);
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    if (!handlers.isGodfather(interaction)) {
      await interaction.reply(eph("Sorry — you don't have permission to use this command."));
      return;
    }
    if (!db.isReady()) {
      await interaction.reply(eph('⚠️ Carry sales are unavailable right now (database not reachable). Please try again later.'));
      return;
    }

    const sub = interaction.options.getSubcommand();

    // -----------------------------------------------------------------------
    // create
    // -----------------------------------------------------------------------
    if (sub === 'create') {
      const tierKey = interaction.options.getString('tier');
      const date = interaction.options.getString('date').trim();
      const time = interaction.options.getString('time').trim();

      const tier = tierFor(tierKey);
      if (!tier) {
        await interaction.reply(eph(`⚠️ Unknown tier \`${tierKey}\`.`));
        return;
      }
      if (!DATE_RE.test(date)) {
        await interaction.reply(eph(`⚠️ \`${date}\` isn't a valid date — use **YYYY-MM-DD** in ${TIME_ZONE_LABEL} (e.g. \`2026-08-30\`).`));
        return;
      }
      if (!TIME_RE.test(time)) {
        await interaction.reply(eph(`⚠️ \`${time}\` isn't a valid time — use 24 h **HH:MM** in ${TIME_ZONE_LABEL} (e.g. \`20:00\`).`));
        return;
      }

      const startAt = handlers.parseGmt7(date, time);
      if (!startAt) {
        await interaction.reply(eph(`⚠️ \`${date} ${time}\` isn't a real date/time. Check the day of the month.`));
        return;
      }
      if (startAt.getTime() <= Date.now()) {
        await interaction.reply(eph(
          `⚠️ That start time is already in the past (${handlers.formatGmt7(startAt)} ${TIME_ZONE_DISPLAY}). ` +
          'A run in the past would be concluded the moment it was created.',
        ));
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const run = await handlers.createRunAndPost(interaction.client, {
        tier,
        startAt,
        guildId: interaction.guildId,
        createdBy: interaction.user.id,
      });
      if (!run) {
        await interaction.editReply('⚠️ Could not create the run — database not reachable. Try again later.');
        return;
      }

      const ts = Math.floor(startAt.getTime() / 1000);
      await interaction.editReply(
        `✅ Run created: **${handlers.runLabel(run)}**\n` +
        `Starts <t:${ts}:F> (<t:${ts}:R>) · **${tier.slots} slots**, open to any class.\n` +
        `Board message posted${run.boardMessageId ? '' : ' — ⚠️ but the board message could not be posted; check the board channel permissions'}.\n` +
        `Run id: \`${run._id}\``,
      );
      return;
    }

    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------
    if (sub === 'list') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const runs = await db.listLiveRuns();
      if (!runs.length) {
        await interaction.editReply('No live carry runs — create one with `/carryrun create`.');
        return;
      }
      const lines = runs.map(run => {
        const ts = run.startEpochSecs;
        const { taken, total } = handlers.seatCounts(run);
        return `• **${describeRun(run)}** — <t:${ts}:R> · ${total - taken}/${total} open\n  id: \`${run._id}\``;
      });
      let content = `🎟️ **Live carry runs (${runs.length})** — all times ${TIME_ZONE_DISPLAY}\n` + lines.join('\n');
      if (content.length > 2000) content = content.slice(0, 1997) + '…';
      await interaction.editReply(content);
      return;
    }

    // -----------------------------------------------------------------------
    // close
    // -----------------------------------------------------------------------
    if (sub === 'close') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const runId = interaction.options.getString('run');
      const run = await db.getRun(runId);
      if (!run || run.status === RUN_STATUS.DELETED) {
        await interaction.editReply('⚠️ That run no longer exists. Check `/carryrun list`.');
        return;
      }
      if (run.status !== RUN_STATUS.OPEN) {
        await interaction.editReply(`⚠️ That run is already **${run.status}** — nothing to close.`);
        return;
      }

      const ok = await handlers.closeRunAndRender(interaction.client, runId, interaction.user.id);
      await interaction.editReply(ok
        ? `🔒 Closed **${handlers.runLabel(run)}** — it stops accepting bookings and its board message stays up.\n` +
          'Existing holds still run their course; use the per-booking **Cancel** button to void a paid seat.'
        : '⚠️ That run changed status a moment before you clicked. Nothing was changed.');
      return;
    }

    // -----------------------------------------------------------------------
    // edit (reschedule)
    // -----------------------------------------------------------------------
    if (sub === 'edit') {
      const runId = interaction.options.getString('run');
      const date = interaction.options.getString('date').trim();
      const time = interaction.options.getString('time').trim();

      if (!DATE_RE.test(date)) {
        await interaction.reply(eph(`⚠️ \`${date}\` isn't a valid date — use **YYYY-MM-DD** in ${TIME_ZONE_LABEL}.`));
        return;
      }
      if (!TIME_RE.test(time)) {
        await interaction.reply(eph(`⚠️ \`${time}\` isn't a valid time — use 24 h **HH:MM** in ${TIME_ZONE_LABEL}.`));
        return;
      }
      const startAt = handlers.parseGmt7(date, time);
      if (!startAt) {
        await interaction.reply(eph(`⚠️ \`${date} ${time}\` isn't a real date/time. Check the day of the month.`));
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const existing = await db.getRun(runId);
      if (!existing || existing.status === RUN_STATUS.DELETED) {
        await interaction.editReply('⚠️ That run no longer exists. Check `/carryrun list`.');
        return;
      }

      const updated = await handlers.rescheduleAndRender(interaction.client, runId, startAt);
      if (!updated) {
        await interaction.editReply('⚠️ Could not reschedule that run — database not reachable. Try again later.');
        return;
      }

      const ts = Math.floor(startAt.getTime() / 1000);
      const reopened = existing.status === RUN_STATUS.CONCLUDED && updated.status === RUN_STATUS.OPEN;
      await interaction.editReply(
        `🕒 Rescheduled to <t:${ts}:F> (<t:${ts}:R>) — **${handlers.runLabel(updated)}**. Its board message was updated in place.` +
        (reopened ? '\nIt had concluded on its old time, so it is **open again**.' : '') +
        (existing.status === RUN_STATUS.CLOSED ? '\nIt stays **closed** — reopen it deliberately if that is what you want.' : ''),
      );
      return;
    }

    // -----------------------------------------------------------------------
    // delete — refused while any PAID booking survives (spec §6.1)
    // -----------------------------------------------------------------------
    if (sub === 'delete') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const runId = interaction.options.getString('run');
      const run = await db.getRun(runId);
      if (!run || run.status === RUN_STATUS.DELETED) {
        await interaction.editReply('⚠️ That run no longer exists. Check `/carryrun list`.');
        return;
      }

      const result = await handlers.deleteRunAndBoard(interaction.client, run, interaction.user.id);

      if (!result.ok) {
        await interaction.editReply(
          `🛑 **Refused — that run has ${result.paidCount} paid booking(s).**\n` +
          'Those are people who have handed over money; removing their run silently is exactly ' +
          'what this guard exists to prevent.\n\n' +
          `Clear them first with the per-booking **Cancel booking** button on the pending board ` +
          `(<#${CHANNELS.PENDING}>) — that is deliberate and leaves a record — ` +
          'then run this again. Their booking records are kept either way.',
        );
        return;
      }

      await interaction.editReply(
        `🗑️ Removed **${handlers.runLabel(run)}** and its board message.\n` +
        `${result.released} unpaid hold(s) were dropped and the buyers were notified.\n` +
        'Every booking against this run is **retained** and marked `run_deleted` — nothing was deleted from the ledger.',
      );
      return;
    }
  },
};
