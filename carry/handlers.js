// ---------------------------------------------------------------------------
// Final Mirage carry sales — panel, buyer flow, officer actions, board render.
//
// Spec: docs/CARRY_SYSTEM_SPEC.md
//
// Buyer flow (spec §7):
//   panel button -> tier select -> run select ->
//   IGN modal -> payment-method select -> SEAT GOES PENDING (conditional take)
//   -> DM pointing the buyer at the RUNNER -> public board updates ->
//   pending board entry.
//
// THE BOT NEVER HOLDS PAYMENT DETAILS. The buyer is told to DM the runner —
// the run's creator (run.createdBy) — rendered as a clickable <@id> mention so
// they can tap through. No creator on the run means no mention: the buyer is
// told an officer will follow up instead (spec §7 step 7).
//
// Officer flow: Mark Paid (confirms the seat), Release, or Cancel. Cancel is
// the ONLY way to void a PAID seat (spec §6.1). There is no class check to
// ride along any more: every seat is open to every class.
//
// EVERY seat mutation goes through carry/db.js's conditional updates. There is
// no in-memory seat map to fall out of sync — see the header of carry/state.js.
// ---------------------------------------------------------------------------

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
} = require('discord.js');

const db = require('./db');
const cs = require('./state');

const {
  IDS,
  FIELDS,
  CHANNELS,
  GODFATHERS_ROLE_ID,
  CARRY_OFFICER_ROLE_IDS,
  TIERS,
  TIER_KEYS,
  tierFor,
  priceLabel,
  PAYMENT_METHODS,
  PAYMENT_METHOD_KEYS,
  paymentMethodFor,
  PENDING_HOLD_MS,
  MAX_SELECT_OPTIONS,
  TIME_ZONE_OFFSET_MINUTES,
  TIME_ZONE_DISPLAY,
  IGN_MAX,
  SEAT_STATUS,
  BOOKING_STATUS,
  RUN_STATUS,
  COLORS,
  PANEL_TITLE,
  PANEL_DESCRIPTION,
  PANEL_BUTTON_LABEL,
  DM,
} = require('./constants');

const HOLD_MINUTES = PENDING_HOLD_MS / 60000;

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

function isGodfather(interaction) {
  return Boolean(interaction.member?.roles?.cache?.has?.(GODFATHERS_ROLE_ID));
}

function isOfficer(interaction) {
  const cache = interaction.member?.roles?.cache;
  if (!cache) return false;
  return CARRY_OFFICER_ROLE_IDS.some(roleId => cache.has?.(roleId));
}

function displayNameOf(interaction) {
  return interaction.member?.displayName ?? interaction.user.username;
}

// Neutralise anything a buyer-supplied IGN could use to ping a channel.
function defuseMentions(text) {
  return String(text || '').replace(/@(everyone|here|&\d+|!?\d+)/g, '@​$1');
}

// Format an instant as a GMT+7 wall-clock label: "Sat 30 Aug 2026, 8:00 PM".
// Same trick as partyfinder/handlers.js — shift the instant, then read the UTC
// getters, which gives GMT+7 local values with no tz database involved.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatGmt7(dateOrMs) {
  const ms = dateOrMs instanceof Date ? dateOrMs.getTime() : Number(dateOrMs);
  const d = new Date(ms + TIME_ZONE_OFFSET_MINUTES * 60 * 1000);
  let h = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h}:${mm} ${ampm}`;
}

// Parse a GMT+7 wall-clock date + time into a UTC instant.
// Returns a Date, or null if the components don't form a real calendar date.
function parseGmt7(dateStr, timeStr) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  const tm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeStr || '');
  if (!dm || !tm) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [hh, mi] = [Number(tm[1]), Number(tm[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const utcMs = Date.UTC(y, mo - 1, d, hh, mi) - TIME_ZONE_OFFSET_MINUTES * 60 * 1000;
  const out = new Date(utcMs);
  // Round-trip guard: rejects 2026-02-31 and friends, which Date.UTC rolls over.
  const back = new Date(utcMs + TIME_ZONE_OFFSET_MINUTES * 60 * 1000);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return out;
}

function tierOfRun(run) {
  return tierFor(run.tier) || { key: run.tier, label: run.tier, priceUsd: run.priceUsd, emoji: '•', color: COLORS.OPEN };
}

// One-line human name for a run — used in DMs, confirmations and autocomplete.
function runLabel(run) {
  const tier = tierOfRun(run);
  return `${tier.label} — ${formatGmt7(run.startAt)} (${TIME_ZONE_DISPLAY})`;
}

// ---------------------------------------------------------------------------
// THE RUNNER (spec §7 step 7). The run's creator — `createdBy`, stamped by
// /carryrun create — is the person a buyer pays. Rendered as a `<@id>` mention
// everywhere so it is tappable straight into a DM.
//
// Both helpers return null rather than a string when there is nobody to point
// at, and EVERY caller must branch on that. A run created before createdBy
// existed, or one whose creator has left, must never produce `<@null>` or an
// empty name in a payment instruction — the buyer is handed to an officer.
// ---------------------------------------------------------------------------
function runnerMention(run) {
  const id = run && run.createdBy;
  return id ? `<@${id}>` : null;
}

// The DM path additionally CONFIRMS the user still resolves, because that DM is
// the buyer's only route to paying. A fetch failure degrades to the officer
// fallback rather than to a mention nobody can act on.
async function resolveRunnerMention(client, run) {
  const id = run && run.createdBy;
  if (!id) return null;
  try {
    const user = await client.users.fetch(id);
    return user && user.id ? `<@${user.id}>` : null;
  } catch (err) {
    console.warn(`[carry] Could not resolve the runner ${id} for ${run?._id}:`, err?.message || err);
    return null;
  }
}

function seatCounts(run) {
  const taken = run.seats.filter(s => s.status !== SEAT_STATUS.OPEN).length;
  return { taken, total: run.seats.length };
}

// ---------------------------------------------------------------------------
// PUBLIC BOARD (spec §8) — one message per run, edited in place on every state
// change. One message per run rather than a single master embed: cheaper edits,
// no rewrite races, and it never hits the 25-field embed cap once several runs
// are live at once.
// ---------------------------------------------------------------------------
function buildRunEmbed(run) {
  const tier = tierOfRun(run);
  const { taken, total } = seatCounts(run);
  const epoch = run.startEpochSecs;

  let title;
  let color;
  switch (run.status) {
    case RUN_STATUS.CLOSED:
      title = `🔒 CLOSED — ${tier.label}`;
      color = COLORS.CLOSED;
      break;
    case RUN_STATUS.CONCLUDED:
      title = `🏁 CONCLUDED — ${tier.label}`;
      color = COLORS.CONCLUDED;
      break;
    default:
      if (taken >= total) {
        title = `${tier.emoji} FULL — ${tier.label}`;
        color = COLORS.FULL;
      } else {
        title = `${tier.emoji} ${tier.label} carry — ${total - taken} slot(s) left`;
        color = COLORS.OPEN;
      }
  }

  const seatLines = run.seats.map(seat => {
    const label = `Seat ${seat.index + 1}`;
    if (seat.status === SEAT_STATUS.PAID) {
      return `${label} — ✅ **${defuseMentions(seat.displayName)}**`;
    }
    if (seat.status === SEAT_STATUS.PENDING) {
      return `${label} — ⏳ ${defuseMentions(seat.displayName)} *(unpaid hold)*`;
    }
    return `${label} — 🟢 _open_`;
  });

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: 'Price',      value: `${priceLabel(tier)} per slot`,                     inline: true },
      { name: 'Slots',      value: `${taken}/${total}`,                                inline: true },
      { name: 'Open to',    value: 'Any class',                                        inline: true },
      { name: '🏃 Runner',   value: runnerLine(run),                                   inline: false },
      { name: '🕒 Start',   value: `<t:${epoch}:F>\n<t:${epoch}:R>\n${formatGmt7(run.startAt)} — ${TIME_ZONE_DISPLAY}`, inline: false },
      { name: 'Seats',      value: seatLines.join('\n') || '_none_',                   inline: false },
    );

  if (run.status === RUN_STATUS.OPEN && taken < total) {
    embed.addFields({
      name: 'How to book',
      value: `Head to <#${CHANNELS.PANEL}> and click **${PANEL_BUTTON_LABEL}**.`,
      inline: false,
    });
  }

  embed.setFooter({ text: `Run ${run._id} • all times ${TIME_ZONE_DISPLAY}` });
  return embed;
}

// Buyers see who is running a slot BEFORE they book it — they will be DMing
// this person to pay, so it is not a detail to discover afterwards.
function runnerLine(run) {
  const mention = runnerMention(run);
  return mention
    ? `${mention} — DM them to arrange payment once you've booked`
    : '_Not set — an officer will arrange payment with you_';
}

/**
 * Render (or re-render) a run's board message.
 *
 * A board message deleted by hand is RE-POSTED and its new id re-persisted
 * (spec §11), so the board self-heals instead of going silently stale.
 * Best-effort: a Discord failure here never fails the caller's transaction —
 * the run itself is already safe in Mongo.
 */
async function renderRunBoard(client, runOrId) {
  const run = typeof runOrId === 'string' ? await db.getRun(runOrId) : runOrId;
  if (!run || run.status === RUN_STATUS.DELETED) return null;

  const embed = buildRunEmbed(run);

  try {
    const channelId = run.boardChannelId || CHANNELS.BOARD;
    const channel = await client.channels.fetch(channelId);

    if (run.boardMessageId) {
      try {
        const message = await channel.messages.fetch(run.boardMessageId);
        await message.edit({ embeds: [embed] });
        return message;
      } catch {
        // Deleted by hand (or the channel moved) — fall through and re-post.
      }
    }

    const posted = await channel.send({ embeds: [embed] });
    await db.setRunBoardMessage(run._id, channel.id, posted.id);
    return posted;
  } catch (err) {
    console.warn(`[carry] Could not render the board for ${run._id}:`, err?.message || err);
    return null;
  }
}

// /carryrun delete — the board message goes away. The run DOC is tombstoned,
// not dropped, because every booking in the ledger points at it.
async function removeRunBoard(client, run) {
  if (!run.boardMessageId) return;
  try {
    const channel = await client.channels.fetch(run.boardChannelId || CHANNELS.BOARD);
    const message = await channel.messages.fetch(run.boardMessageId);
    await message.delete();
  } catch (err) {
    console.warn(`[carry] Could not remove the board message for ${run._id}:`, err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// PENDING BOARD (spec §8) — officer-facing, one entry per unpaid hold.
//
// The entry is NOT deleted when the hold resolves: it is edited to its final
// state with the buttons stripped, so the officer channel doubles as a log and
// nothing is destroyed (spec §4.2 in spirit).
// ---------------------------------------------------------------------------
function buildBookingEmbed(booking, run) {
  const tier = tierFor(booking.tier) || { label: booking.tier, emoji: '•' };
  const method = paymentMethodFor(booking.paymentMethod);

  let title;
  let color;
  switch (booking.status) {
    case BOOKING_STATUS.PAID:
      title = '✅ PAID';       color = COLORS.PAID; break;
    case BOOKING_STATUS.COMPLETED:
      title = '🏁 COMPLETED';  color = COLORS.PAID; break;
    case BOOKING_STATUS.RELEASED:
      title = '⌛ RELEASED (hold expired)'; color = COLORS.RELEASED; break;
    case BOOKING_STATUS.CANCELLED:
      title = '🚫 CANCELLED';  color = COLORS.CANCELLED; break;
    case BOOKING_STATUS.RUN_DELETED:
      title = '🗑️ RUN DELETED'; color = COLORS.CANCELLED; break;
    default:
      title = '⏳ AWAITING PAYMENT'; color = COLORS.PENDING;
  }

  const embed = new EmbedBuilder()
    .setTitle(`${title} — ${tier.label}`)
    .setColor(color)
    .addFields(
      { name: 'Buyer',   value: `<@${booking.userId}>\n${defuseMentions(booking.displayName)}`, inline: true },
      { name: 'IGN',     value: defuseMentions(booking.ign) || '—',                             inline: true },
      { name: 'Price',   value: `$${booking.priceUsd}`,                                         inline: true },
      { name: 'Payment', value: method ? `${method.emoji} ${method.label}` : String(booking.paymentMethod), inline: true },
      { name: 'Seat',    value: `Seat ${booking.seatIndex + 1}`,                                    inline: true },
      { name: 'Runner',  value: runnerMention(run) ? `${runnerMention(run)} — payment lands in their DMs` : '⚠️ **none on this run** — arrange payment yourself', inline: true },
      { name: 'Run',     value: run ? runLabel(run) : booking.runId,                            inline: false },
    );

  if (booking.status === BOOKING_STATUS.PENDING) {
    const until = Math.floor(new Date(booking.pendingUntil).getTime() / 1000);
    embed.addFields({
      name: '⏳ Auto-releases',
      value: `<t:${until}:R> (<t:${until}:T>)`,
      inline: false,
    });
  } else if (booking.status === BOOKING_STATUS.PAID && booking.paidBy) {
    embed.addFields({ name: 'Confirmed by', value: `<@${booking.paidBy}>`, inline: false });
  } else if (booking.status === BOOKING_STATUS.CANCELLED && booking.cancelledBy) {
    embed.addFields({
      name: 'Cancelled by',
      value: `<@${booking.cancelledBy}>${booking.cancelReason ? ` — ${defuseMentions(booking.cancelReason)}` : ''}`,
      inline: false,
    });
  }

  embed.setFooter({ text: `Booking ${booking._id} • run ${booking.runId}` });
  return embed;
}

function buildBookingComponents(booking) {
  if (booking.status === BOOKING_STATUS.PENDING) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.MARK_PAID}:${booking._id}`)
        .setLabel('Mark Paid')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${IDS.RELEASE}:${booking._id}`)
        .setLabel('Release')
        .setStyle(ButtonStyle.Secondary),
    )];
  }
  if (booking.status === BOOKING_STATUS.PAID) {
    // The ONLY way to void a paid seat (spec §6.1) — and the thing an officer
    // has to do before /carryrun delete will touch a run with paid bookings.
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.CANCEL}:${booking._id}`)
        .setLabel('Cancel booking')
        .setStyle(ButtonStyle.Danger),
    )];
  }
  return [];
}

async function renderBookingEntry(client, bookingOrId, run = null) {
  const booking = typeof bookingOrId === 'string' ? await db.getBooking(bookingOrId) : bookingOrId;
  if (!booking) return null;
  const runDoc = run || await db.getRun(booking.runId);

  const payload = {
    embeds: [buildBookingEmbed(booking, runDoc)],
    components: buildBookingComponents(booking),
  };

  try {
    const channel = await client.channels.fetch(booking.pendingChannelId || CHANNELS.PENDING);

    if (booking.pendingMessageId) {
      try {
        const message = await channel.messages.fetch(booking.pendingMessageId);
        await message.edit(payload);
        return message;
      } catch {
        // Deleted by hand — re-post and re-persist, same as the run board.
      }
    }

    const posted = await channel.send(payload);
    await db.setBookingPendingMessage(booking._id, channel.id, posted.id);
    return posted;
  } catch (err) {
    console.warn(`[carry] Could not render the pending entry for ${booking._id}:`, err?.message || err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The sales panel (spec §7.1). Static — it holds no state, so it survives
// restarts trivially.
// ---------------------------------------------------------------------------
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setDescription(PANEL_DESCRIPTION)
    .setColor(COLORS.PANEL);
}

function buildPanelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.PANEL_BUTTON)
      .setLabel(PANEL_BUTTON_LABEL)
      .setStyle(ButtonStyle.Success),
  )];
}

// ---------------------------------------------------------------------------
// BUYER FLOW
// ---------------------------------------------------------------------------

// 2. Tier select (ephemeral).
async function handlePanelButton(interaction) {
  if (!db.isReady()) {
    await interaction.reply(ephemeral('⚠️ Carry sales are unavailable right now (database not reachable). Please try again shortly.'));
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(IDS.TIER_SELECT)
    .setPlaceholder('Choose a tier')
    .addOptions(TIER_KEYS.map(key => {
      const tier = TIERS[key];
      return new StringSelectMenuOptionBuilder()
        .setLabel(`${tier.label} — $${tier.priceUsd}`)
        .setDescription(`${tier.slots} slots per run, open to any class`)
        .setValue(key);
    }));

  await interaction.reply({
    content: '**Step 1 of 4 — pick a tier.**',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

// 3. Timeslot select (ephemeral). FULL RUNS ARE FILTERED OUT (spec §7.3).
async function handleTierSelect(interaction) {
  const tierKey = interaction.values[0];
  const tier = tierFor(tierKey);
  if (!tier) {
    await interaction.update({ content: 'That tier no longer exists. Start again from the panel.', components: [] });
    return;
  }

  await renderRunPicker(interaction, tierKey, `**Step 2 of 4 — pick a time slot for ${tier.label}.**`);
}

// Shared by the tier select and by the "someone beat you to it" path, which
// re-shows the picker with the run's TRUE state (spec §4.1).
async function renderRunPicker(interaction, tierKey, header) {
  const tier = tierFor(tierKey);
  const runs = await db.listOpenRunsForTier(tierKey);

  if (!runs.length) {
    const payload = {
      content:
        `There are no open **${tier.label}** runs right now. ` +
        `Keep an eye on <#${CHANNELS.BOARD}> — new runs are posted there.`,
      components: [],
    };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.update(payload);
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${IDS.RUN_SELECT}:${tierKey}`)
    .setPlaceholder('Choose a time slot')
    .addOptions(runs.slice(0, MAX_SELECT_OPTIONS).map(run => {
      const { taken, total } = seatCounts(run);
      return new StringSelectMenuOptionBuilder()
        .setLabel(formatGmt7(run.startAt).slice(0, 100))
        .setDescription(`${total - taken} of ${total} slot(s) left`.slice(0, 100))
        .setValue(run._id);
    }));

  const payload = {
    content: `${header}\nAll times are ${TIME_ZONE_DISPLAY}.`,
    components: [new ActionRowBuilder().addComponents(select)],
  };
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else await interaction.update(payload);
}

// 4/5. Run picked -> resolve the seat -> straight to the IGN modal. A select IS
// allowed to open a modal; only a modal submit is not.
//
// Every seat is open to every class, so a full run is the ONLY refusal left.
async function handleRunSelect(interaction, tierKey) {
  const runId = interaction.values[0];
  const run = await db.getRun(runId);

  if (!run || run.status !== RUN_STATUS.OPEN) {
    await renderRunPicker(interaction, tierKey, '⚠️ That run is no longer open. **Pick another time slot.**');
    return;
  }

  const pick = cs.selectSeat(run);

  if (!pick.ok) {
    await renderRunPicker(interaction, tierKey, '⚠️ That run just filled up. **Pick another time slot.**');
    return;
  }
  await interaction.showModal(buildIgnModal(run._id, pick.seatIndex));
}

function buildIgnModal(runId, seatIndex) {
  const modal = new ModalBuilder()
    .setCustomId(`${IDS.IGN_MODAL}:${runId}:${seatIndex}`)
    .setTitle('Your in-game name');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(FIELDS.IGN)
        .setLabel('In-game name (IGN)')
        .setPlaceholder('Exactly as it appears in game')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(IGN_MAX)
        .setRequired(true),
    ),
  );
  return modal;
}

// 6. IGN captured -> payment-method select. STILL NO SEAT CLAIMED — the draft
// lives in memory only and losing it to a restart costs a re-click, nothing else.
async function handleIgnModal(interaction, runId, seatIndex) {
  const ign = interaction.fields.getTextInputValue(FIELDS.IGN).trim();
  if (!ign.length) {
    await interaction.reply(ephemeral('Please enter your in-game name and try again.'));
    return;
  }

  const run = await db.getRun(runId);
  if (!run || run.status !== RUN_STATUS.OPEN) {
    await interaction.reply(ephemeral('⚠️ That run is no longer open. Start again from the panel.'));
    return;
  }
  if (run.seats[seatIndex]?.status !== SEAT_STATUS.OPEN) {
    await interaction.reply(ephemeral(
      '⚠️ Somebody took that slot while you were typing. Start again from the panel — ' +
      'the board shows what is still free.',
    ));
    return;
  }

  const tier = tierOfRun(run);
  cs.setDraft(interaction.user.id, {
    runId,
    seatIndex,
    tierKey: run.tier,
    ign,
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${IDS.PAY_SELECT}:${runId}:${seatIndex}`)
    .setPlaceholder('Choose how you want to pay')
    .addOptions(PAYMENT_METHOD_KEYS.map(key => {
      const m = PAYMENT_METHODS[key];
      return new StringSelectMenuOptionBuilder().setLabel(m.label).setValue(key).setEmoji(m.emoji);
    }));

  await interaction.reply({
    content:
      `**Step 4 of 4 — how would you like to pay?**\n` +
      `${tier.label} · **${priceLabel(tier)}** · ${formatGmt7(run.startAt)} (${TIME_ZONE_DISPLAY})\n` +
      `IGN: **${defuseMentions(ign)}**\n\n` +
      `Pick one and I'll DM you who to message about payment — your slot is then held for ` +
      `**${HOLD_MINUTES} minutes**.`,
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

// 7. Payment method chosen -> THE SEAT IS TAKEN (conditional, spec §4.1).
async function handlePaySelect(interaction, runId, seatIndex) {
  const methodKey = interaction.values[0];
  const method = paymentMethodFor(methodKey);
  if (!method) {
    await interaction.update({ content: 'That payment method is no longer offered. Start again from the panel.', components: [] });
    return;
  }

  const draft = cs.getDraft(interaction.user.id, { runId, seatIndex: Number(seatIndex) });
  if (!draft) {
    await interaction.update({
      content: '⚠️ That booking took too long and expired before it started. Nothing was charged — start again from the panel.',
      components: [],
    });
    return;
  }

  // Taking a seat means a Mongo write and a DM; defer so the 3 s interaction
  // window can't expire underneath it.
  await interaction.deferUpdate();

  const run = await db.getRun(runId);
  if (!run || run.status !== RUN_STATUS.OPEN) {
    cs.clearDraft(interaction.user.id);
    await interaction.editReply({ content: '⚠️ That run closed before your booking went through. Nothing was charged.', components: [] });
    return;
  }

  const result = await cs.claimSeat({
    run,
    seatIndex: Number(seatIndex),
    userId: interaction.user.id,
    username: interaction.user.username,
    displayName: displayNameOf(interaction),
    ign: draft.ign,
    paymentMethod: methodKey,
    guildId: interaction.guildId,
  });

  cs.clearDraft(interaction.user.id);

  if (!result.ok) {
    if (result.reason === 'store') {
      await interaction.editReply({
        content: '⚠️ Couldn\'t record that booking (database not reachable). Nothing was charged and no slot was taken — please try again shortly.',
        components: [],
      });
      return;
    }
    // Someone else got the seat. Tell the buyer, and re-show the picker with
    // the tier's TRUE state (spec §4.1, §11).
    await renderRunPicker(
      interaction,
      run.tier,
      '⚠️ **Someone took that slot a moment before you did.** Nothing was charged. **Pick another time slot.**',
    );
    return;
  }

  const booking = result.booking;
  const tier = tierOfRun(run);

  // Arm the 30-minute auto-release (spec §7.8). The DB already knows the
  // deadline, so this timer is an optimisation, not the record.
  cs.armRelease(booking._id, booking.pendingUntil, id => releaseHold(interaction.client, id));

  // Point the buyer at the RUNNER. No account details pass through the bot —
  // the mention is the whole payment instruction, so if it can't be built the
  // buyer is handed to an officer rather than sent a dead link.
  const runner = await resolveRunnerMention(interaction.client, run);
  const dmArgs = {
    tierLabel: tier.label,
    price: priceLabel(tier),
    runLabel: runLabel(run),
    methodLabel: method.label,
    runnerMention: runner,
    holdMinutes: HOLD_MINUTES,
    bookingId: booking._id,
  };
  let dmOk = true;
  try {
    const user = await interaction.client.users.fetch(booking.userId);
    await user.send(runner ? DM.booked(dmArgs) : DM.bookedNoRunner(dmArgs));
  } catch (err) {
    dmOk = false;
    console.warn(`[carry] Could not DM booking instructions to ${booking.userId}:`, err?.message || err);
  }

  await interaction.editReply({
    content:
      `✅ **Slot held — ${tier.label}, ${formatGmt7(run.startAt)} (${TIME_ZONE_DISPLAY}).**\n` +
      `Booking \`${booking._id}\` · ${priceLabel(tier)} · ${method.label}\n\n` +
      (dmOk
        ? `📬 Check your DMs. Your slot is held for **${HOLD_MINUTES} minutes** — ` +
          `sort payment within that window and an officer will confirm it.`
        : `⚠️ I couldn't DM you (your DMs look closed). Your slot is still held for ` +
          `**${HOLD_MINUTES} minutes** — open your DMs or contact an officer.`) +
      (runner
        ? `\n\n💬 Pay the runner directly: ${runner}`
        : `\n\n⚠️ This run has no runner on record — an officer will follow up about payment.`),
    components: [],
  });

  // Boards. Best-effort — the booking is already durable.
  await renderRunBoard(interaction.client, booking.runId);
  await renderBookingEntry(interaction.client, booking._id);
}

// ---------------------------------------------------------------------------
// AUTO-RELEASE (spec §7.8, §10)
//
// Conditional at every step: the booking must still be `pending` and the seat
// must still hold THIS booking. So a timer that fires late — after an officer
// confirmed payment, or after a restart re-armed a duplicate — is a harmless
// no-op rather than an eviction.
// ---------------------------------------------------------------------------
async function releaseHold(client, bookingId) {
  const booking = await db.getBooking(bookingId);
  if (!booking || booking.status !== BOOKING_STATUS.PENDING) return false;

  const released = await db.markBookingReleased(bookingId);
  if (!released) return false; // lost the race to Mark Paid — correct outcome.

  await db.vacateSeat(booking.runId, booking.seatIndex, bookingId, [SEAT_STATUS.PENDING]);

  const run = await db.getRun(booking.runId);
  const tier = tierFor(booking.tier) || { label: booking.tier };

  try {
    const user = await client.users.fetch(booking.userId);
    await user.send(DM.released({
      tierLabel: tier.label,
      runLabel: run ? runLabel(run) : booking.runId,
      holdMinutes: HOLD_MINUTES,
    }));
  } catch (err) {
    // Buyer may have left the server or closed DMs — the hold still expires
    // normally and the record is retained (spec §11).
    console.warn(`[carry] Could not DM release notice to ${booking.userId}:`, err?.message || err);
  }

  if (run && run.status !== RUN_STATUS.DELETED) await renderRunBoard(client, run._id);
  await renderBookingEntry(client, bookingId, run);
  return true;
}

// ---------------------------------------------------------------------------
// OFFICER ACTIONS
// ---------------------------------------------------------------------------
async function handleMarkPaid(interaction, bookingId) {
  if (!isOfficer(interaction)) {
    await interaction.reply(ephemeral("You don't have permission to confirm carry payments."));
    return;
  }
  if (!db.isReady()) {
    await interaction.reply(ephemeral("The carry store isn't available right now — try again shortly."));
    return;
  }

  const booking = await db.getBooking(bookingId);
  if (!booking) {
    await interaction.reply(ephemeral('That booking no longer exists.'));
    return;
  }
  if (booking.status !== BOOKING_STATUS.PENDING) {
    // Officer marks paid after auto-release (spec §11) — refused with a clear
    // reason, because the seat may already have been resold.
    await interaction.reply(ephemeral(
      `That booking is already **${booking.status}**` +
      (booking.status === BOOKING_STATUS.RELEASED
        ? ` — the ${HOLD_MINUTES}-minute hold expired and the slot may have been resold. ` +
          'If they have actually paid, sort it with them directly and book them a fresh slot.'
        : '.'),
    ));
    return;
  }

  await interaction.deferUpdate();

  // Seat first: if the seat no longer holds this booking, nothing about the
  // booking should move either.
  const seatOk = await db.confirmSeatPaid(booking.runId, booking.seatIndex, bookingId);
  if (!seatOk) {
    await interaction.followUp(ephemeral(
      'That seat is no longer held by this booking — the hold expired and it may have been resold. Nothing was changed.',
    ));
    await renderBookingEntry(interaction.client, bookingId);
    return;
  }

  const ok = await db.markBookingPaid(bookingId, interaction.user.id);
  if (!ok) {
    await interaction.followUp(ephemeral('Another officer got there a moment before you. Nothing was changed.'));
    await renderBookingEntry(interaction.client, bookingId);
    return;
  }

  cs.cancelRelease(bookingId);

  const run = await db.getRun(booking.runId);
  const tier = tierFor(booking.tier) || { label: booking.tier };

  try {
    const user = await interaction.client.users.fetch(booking.userId);
    await user.send(DM.paid({ tierLabel: tier.label, runLabel: run ? runLabel(run) : booking.runId }));
  } catch (err) {
    console.warn(`[carry] Could not DM paid confirmation to ${booking.userId}:`, err?.message || err);
  }

  await renderRunBoard(interaction.client, booking.runId);
  await renderBookingEntry(interaction.client, bookingId, run);
}

// Officer releases a hold early — same path as the timer.
async function handleRelease(interaction, bookingId) {
  if (!isOfficer(interaction)) {
    await interaction.reply(ephemeral("You don't have permission to release carry holds."));
    return;
  }
  const booking = await db.getBooking(bookingId);
  if (!booking) {
    await interaction.reply(ephemeral('That booking no longer exists.'));
    return;
  }
  if (booking.status !== BOOKING_STATUS.PENDING) {
    await interaction.reply(ephemeral(`That booking is already **${booking.status}** — nothing to release.`));
    return;
  }

  await interaction.deferUpdate();
  cs.cancelRelease(bookingId);
  const done = await releaseHold(interaction.client, bookingId);
  if (!done) {
    await interaction.followUp(ephemeral('That booking changed status a moment before you clicked. Nothing was changed.'));
  }
}

// Cancel — officer-only, and the ONLY way to void a PAID seat (spec §6.1, §7).
// Buyers cannot self-release.
async function handleCancel(interaction, bookingId) {
  if (!isOfficer(interaction)) {
    await interaction.reply(ephemeral("You don't have permission to cancel carry bookings."));
    return;
  }
  const booking = await db.getBooking(bookingId);
  if (!booking) {
    await interaction.reply(ephemeral('That booking no longer exists.'));
    return;
  }
  if (![BOOKING_STATUS.PENDING, BOOKING_STATUS.PAID].includes(booking.status)) {
    await interaction.reply(ephemeral(`That booking is already **${booking.status}** — nothing to cancel.`));
    return;
  }

  await interaction.deferUpdate();

  const ok = await db.markBookingCancelled(bookingId, interaction.user.id, null);
  if (!ok) {
    await interaction.followUp(ephemeral('That booking changed status a moment before you clicked. Nothing was changed.'));
    return;
  }
  cs.cancelRelease(bookingId);
  await db.vacateSeat(booking.runId, booking.seatIndex, bookingId);

  const run = await db.getRun(booking.runId);
  const tier = tierFor(booking.tier) || { label: booking.tier };
  try {
    const user = await interaction.client.users.fetch(booking.userId);
    await user.send(DM.cancelled({ tierLabel: tier.label, runLabel: run ? runLabel(run) : booking.runId, reason: null }));
  } catch (err) {
    console.warn(`[carry] Could not DM cancellation to ${booking.userId}:`, err?.message || err);
  }

  if (run && run.status !== RUN_STATUS.DELETED) await renderRunBoard(interaction.client, run._id);
  await renderBookingEntry(interaction.client, bookingId, run);
}

// ---------------------------------------------------------------------------
// RUN ADMIN — called from commands/carryrun.js.
// ---------------------------------------------------------------------------
async function createRunAndPost(client, { tier, startAt, guildId, createdBy }) {
  const run = await db.createRun({ tier, startAt, guildId, createdBy });
  if (!run) return null;
  await renderRunBoard(client, run);
  return db.getRun(run._id);
}

async function closeRunAndRender(client, runId, officerId) {
  const ok = await db.closeRun(runId, officerId);
  if (ok) await renderRunBoard(client, runId);
  return ok;
}

async function rescheduleAndRender(client, runId, startAt) {
  const run = await db.rescheduleRun(runId, startAt);
  if (run) await renderRunBoard(client, run._id);
  return run;
}

/**
 * /carryrun delete (spec §6.1).
 *
 * REFUSES while any PAID booking survives — those are people who have handed
 * over money, and removing their run silently is exactly the failure this
 * system exists to avoid. Clear them first with the per-booking Cancel action.
 *
 * Otherwise: the board message goes away, the run doc is TOMBSTONED (not
 * dropped — the ledger points at it), and its bookings are RETAINED and marked.
 *
 * @returns {Promise<{ok: true, released: number} | {ok: false, paidCount: number}>}
 */
async function deleteRunAndBoard(client, run, officerId) {
  const paidCount = await db.countPaidBookingsForRun(run._id);
  if (paidCount > 0) return { ok: false, paidCount };

  // Notify anyone currently holding a slot BEFORE the run disappears.
  const bookings = await db.listBookingsForRun(run._id);
  const live = bookings.filter(b => b.status === BOOKING_STATUS.PENDING);

  await db.markBookingsRunDeleted(run._id, officerId);
  await db.markRunDeleted(run._id, officerId);
  await removeRunBoard(client, run);

  const tier = tierOfRun(run);
  for (const booking of live) {
    cs.cancelRelease(booking._id);
    try {
      const user = await client.users.fetch(booking.userId);
      await user.send(DM.runDeleted({ tierLabel: tier.label, runLabel: runLabel(run) }));
    } catch (err) {
      console.warn(`[carry] Could not DM run-deleted notice to ${booking.userId}:`, err?.message || err);
    }
    await renderBookingEntry(client, booking._id, run);
  }

  return { ok: true, released: live.length };
}

// A run whose start time has passed stops accepting joins and is restyled as
// concluded. The board message is LEFT IN PLACE — no auto-archive (spec §6).
async function concludeDueRuns(client) {
  const due = await db.listRunsDueToConclude();
  let n = 0;
  for (const run of due) {
    if (await db.concludeRun(run._id)) {
      await renderRunBoard(client, run._id);
      n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Router — called from events/interactionCreate.js. Returns true if it handled
// the interaction. Claims ONLY the `carry:` namespace, which nothing else uses.
// ---------------------------------------------------------------------------
async function route(interaction) {
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (!id.startsWith('carry:')) return false;

    if (id === IDS.PANEL_BUTTON) {
      await handlePanelButton(interaction);
      return true;
    }
    if (id.startsWith(`${IDS.MARK_PAID}:`)) {
      await handleMarkPaid(interaction, id.slice(`${IDS.MARK_PAID}:`.length));
      return true;
    }
    if (id.startsWith(`${IDS.RELEASE}:`)) {
      await handleRelease(interaction, id.slice(`${IDS.RELEASE}:`.length));
      return true;
    }
    if (id.startsWith(`${IDS.CANCEL}:`)) {
      await handleCancel(interaction, id.slice(`${IDS.CANCEL}:`.length));
      return true;
    }
    return false;
  }

  if (interaction.isStringSelectMenu()) {
    const id = interaction.customId;
    if (!id.startsWith('carry:')) return false;

    if (id === IDS.TIER_SELECT) {
      await handleTierSelect(interaction);
      return true;
    }
    if (id.startsWith(`${IDS.RUN_SELECT}:`)) {
      await handleRunSelect(interaction, id.slice(`${IDS.RUN_SELECT}:`.length));
      return true;
    }
    if (id.startsWith(`${IDS.PAY_SELECT}:`)) {
      // carry:pay:<runId>:<seatIndex> — runId contains a ':', so parse from the END.
      const parts = id.split(':');
      const seatIndex = Number(parts[parts.length - 1]);
      const runId = parts.slice(2, parts.length - 1).join(':');
      await handlePaySelect(interaction, runId, seatIndex);
      return true;
    }
    return false;
  }

  if (interaction.isModalSubmit()) {
    const id = interaction.customId;
    if (!id.startsWith('carry:')) return false;

    if (id.startsWith(`${IDS.IGN_MODAL}:`)) {
      // carry:ign:<runId>:<seatIndex> — runId contains a ':', parse from the END.
      //
      // A modal opened just BEFORE the Priest removal deployed carries the old
      // five-segment form (carry:ign:<runId>:<seatIndex>:<declared>). Parsed
      // here that yields a runId of '<realRunId>:<seatIndex>', which is not a
      // valid run id, so getRun returns null and the buyer is told to start
      // again. It can never resolve to a real run and claim the wrong seat.
      const parts = id.split(':');
      const seatIndex = Number(parts[parts.length - 1]);
      const runId = parts.slice(2, parts.length - 1).join(':');
      await handleIgnModal(interaction, runId, seatIndex);
      return true;
    }
    return false;
  }

  return false;
}

module.exports = {
  route,
  // panel (commands/carrypanel.js)
  buildPanelEmbed,
  buildPanelComponents,
  // run admin (commands/carryrun.js)
  createRunAndPost,
  closeRunAndRender,
  rescheduleAndRender,
  deleteRunAndBoard,
  concludeDueRuns,
  // resume (carry/resume.js)
  renderRunBoard,
  renderBookingEntry,
  releaseHold,
  // gates + formatting, exported for the commands and for tests
  isGodfather,
  isOfficer,
  formatGmt7,
  parseGmt7,
  runLabel,
  runnerMention,
  resolveRunnerMention,
  seatCounts,
  buildRunEmbed,
  buildBookingEmbed,
  buildBookingComponents,
};
