// ---------------------------------------------------------------------------
// Officer carry scheduler — interaction handling.
//
// Spec: docs/OFFICER_CARRY_SCHEDULER_SPEC.md §3.
//
// route() claims ONLY the `occarry:` namespace and returns false for everything
// else, so it is safe anywhere in the events/interactionCreate.js chain.
//
// NO PENDING STATE (spec §0). Every join is committed by db.claimMemberSlot()
// at the moment the time is selected. There is no hold, no expiry and no
// confirmation step on the member path — the ephemeral reply IS the receipt.
// The one confirmation in this file is an OFFICER withdrawing from a slot that
// already has members on it, which is a different thing: it strands people.
// ---------------------------------------------------------------------------

const { MessageFlags } = require('discord.js');

const db = require('./db');
const render = require('./render');
const {
  IDS,
  NAMESPACE,
  CHANNELS,
  GODFATHERS_ROLE_ID,
  OFFICER_ROLE_IDS,
  MAX_MEMBERS_PER_SLOT,
  PANEL_DEBOUNCE_MS,
  TZ_LABEL,
} = require('./constants');
const { parseSlotKey, dayByKey, dayHeading } = require('./grid');

const UNAVAILABLE =
  '⚠️ The carry scheduler is unavailable right now (database not reachable). Try again shortly.';

// ---------------------------------------------------------------------------
// Permissions.
// ---------------------------------------------------------------------------
function isGodfather(interaction) {
  return Boolean(interaction.member?.roles?.cache?.has?.(GODFATHERS_ROLE_ID));
}

function isOfficer(interaction) {
  const cache = interaction.member?.roles?.cache;
  if (!cache) return false;
  return OFFICER_ROLE_IDS.some(roleId => cache.has?.(roleId));
}

function entryFor(interaction) {
  return {
    userId: interaction.user.id,
    displayName: interaction.member?.displayName || interaction.user.username,
    at: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Board refresh, debounced (spec §7.2).
//
// The write to Mongo has ALREADY happened by the time this is called. Only the
// visual refresh is coalesced, so a burst of officers marking availability
// cannot trip Discord's edit rate limit, and a dropped edit can never mean a
// lost join. The trailing edge always fires, so the board never settles stale.
// ---------------------------------------------------------------------------
const pendingRefresh = new Map();   // guildId -> timeout

async function refreshPanelNow(client, guildId) {
  pendingRefresh.delete(guildId);
  try {
    const doc = await db.getActiveWeek(guildId);
    if (!doc?.panelChannelId || !doc?.panelMessageId) return;

    const channel = await client.channels.fetch(doc.panelChannelId).catch(() => null);
    if (!channel) return;
    const message = await channel.messages.fetch(doc.panelMessageId).catch(() => null);
    if (!message) return;   // deleted by hand — /officercarry panel reposts it

    await message.edit(render.panelPayload(doc));
  } catch (err) {
    console.warn('[officercarry/handlers] Panel refresh failed:', err?.message || err);
  }
}

function scheduleRefresh(client, guildId) {
  if (pendingRefresh.has(guildId)) clearTimeout(pendingRefresh.get(guildId));
  pendingRefresh.set(guildId, setTimeout(() => {
    refreshPanelNow(client, guildId).catch(() => {});
  }, PANEL_DEBOUNCE_MS));
}

// ---------------------------------------------------------------------------
// Posting / moving the board. Used by /officercarry panel.
// ---------------------------------------------------------------------------
async function postPanel(client, guildId, channel) {
  const doc = await db.getOrCreateActiveWeek(guildId);
  if (!doc) return null;

  const message = await channel.send(render.panelPayload(doc));
  await db.setPanel(doc._id, channel.id, message.id);

  // Moving the board leaves the old message behind rather than deleting it —
  // nothing in this bot deletes a message it did not just create.
  return message;
}

// ---------------------------------------------------------------------------
// Flow: Join / I'm available — step 1, pick a day.
// ---------------------------------------------------------------------------
async function handleDayPrompt(interaction, { openOnly, selectId, officerOnly }) {
  if (officerOnly && !isOfficer(interaction)) {
    await interaction.reply({
      content: "Sorry — only officers can mark availability. If you want a carry, use **Join a slot**.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!db.isReady()) {
    await interaction.reply({ content: UNAVAILABLE, flags: MessageFlags.Ephemeral });
    return;
  }

  const doc = await db.getOrCreateActiveWeek(interaction.guildId);
  if (!doc) {
    await interaction.reply({ content: UNAVAILABLE, flags: MessageFlags.Ephemeral });
    return;
  }

  const row = render.daySelect(doc, selectId, { openOnly });
  if (!row) {
    await interaction.reply({
      content: openOnly
        ? "No slots are open yet this week. An officer needs to mark availability first."
        : 'The week has no days to show, which should not happen — tell an officer.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: openOnly
      ? `Pick a day, then a time. You'll be in the slot straight away — no waiting for approval. All times **${TZ_LABEL}**.`
      : `Pick a day, then the time you can run. All times **${TZ_LABEL}**.`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

// ---------------------------------------------------------------------------
// Flow: step 2, pick a time.
// ---------------------------------------------------------------------------
async function handleSlotPrompt(interaction, dayKey, { openOnly, slotIdBase }) {
  if (!db.isReady()) {
    await interaction.update({ content: UNAVAILABLE, components: [] });
    return;
  }
  if (!dayByKey(dayKey)) {
    await interaction.update({ content: 'That day is not on the grid.', components: [] });
    return;
  }

  const doc = await db.getOrCreateActiveWeek(interaction.guildId);
  if (!doc) {
    await interaction.update({ content: UNAVAILABLE, components: [] });
    return;
  }

  const row = render.slotSelect(doc, dayKey, `${slotIdBase}:${dayKey}`, { openOnly });
  if (!row) {
    await interaction.update({
      content: `No slots are open on ${dayHeading(dayKey, new Date(doc.weekStartAt))}. Pick another day.`,
      components: [],
    });
    return;
  }

  await interaction.update({
    content: `**${dayHeading(dayKey, new Date(doc.weekStartAt))}** — pick a time (${TZ_LABEL}).`,
    components: [row],
  });
}

// ---------------------------------------------------------------------------
// Flow: the commit. A member join is finished here and nowhere else.
// ---------------------------------------------------------------------------
async function handleJoinCommit(interaction) {
  const key = interaction.values?.[0];
  const parsed = parseSlotKey(key);
  if (!parsed) {
    await interaction.update({ content: 'That slot is not on the grid.', components: [] });
    return;
  }
  if (!db.isReady()) {
    await interaction.update({ content: UNAVAILABLE, components: [] });
    return;
  }

  const doc = await db.getOrCreateActiveWeek(interaction.guildId);
  if (!doc) {
    await interaction.update({ content: UNAVAILABLE, components: [] });
    return;
  }

  const result = await db.claimMemberSlot(doc._id, key, entryFor(interaction));

  const messages = {
    full: `That slot filled up while you were choosing — it takes ${MAX_MEMBERS_PER_SLOT}. Pick another time.`,
    'no-officer': 'That slot has no officer on it any more, so it cannot be joined. Pick another time.',
    already: "You're already on that slot.",
    gone: 'That slot is no longer available — the week may have just rolled over.',
  };

  if (result !== 'ok') {
    await interaction.update({ content: messages[result] || messages.gone, components: [] });
    return;
  }

  const fresh = await db.getWeekById(doc._id);
  await interaction.update({
    content: `✅ You're in.\n\n${render.slotDetail(fresh, key)}`,
    components: [],
  });
  scheduleRefresh(interaction.client, interaction.guildId);
}

async function handleAvailCommit(interaction) {
  if (!isOfficer(interaction)) {
    await interaction.update({ content: 'Only officers can mark availability.', components: [] });
    return;
  }
  const key = interaction.values?.[0];
  const parsed = parseSlotKey(key);
  if (!parsed) {
    await interaction.update({ content: 'That slot is not on the grid.', components: [] });
    return;
  }
  if (!db.isReady()) {
    await interaction.update({ content: UNAVAILABLE, components: [] });
    return;
  }

  const doc = await db.getOrCreateActiveWeek(interaction.guildId);
  if (!doc) {
    await interaction.update({ content: UNAVAILABLE, components: [] });
    return;
  }

  const result = await db.addOfficerSlot(doc._id, key, entryFor(interaction));
  if (result === 'already') {
    await interaction.update({ content: "You're already marked available on that slot.", components: [] });
    return;
  }
  if (result !== 'ok') {
    await interaction.update({
      content: 'Could not mark that slot — the week may have just rolled over.',
      components: [],
    });
    return;
  }

  const fresh = await db.getWeekById(doc._id);
  await interaction.update({
    content: `✅ Marked available. Members can now join this slot.\n\n${render.slotDetail(fresh, key)}`,
    components: [],
  });
  scheduleRefresh(interaction.client, interaction.guildId);
}

// ---------------------------------------------------------------------------
// My slots, and the two ways out.
// ---------------------------------------------------------------------------
async function handleMine(interaction) {
  if (!db.isReady()) {
    await interaction.reply({ content: UNAVAILABLE, flags: MessageFlags.Ephemeral });
    return;
  }
  const doc = await db.getOrCreateActiveWeek(interaction.guildId);
  if (!doc) {
    await interaction.reply({ content: UNAVAILABLE, flags: MessageFlags.Ephemeral });
    return;
  }
  const view = render.mineView(doc, interaction.user.id);
  await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
}

async function handleLeave(interaction, key) {
  if (!parseSlotKey(key) || !db.isReady()) {
    await interaction.update({ content: 'That slot is not on the grid.', components: [] });
    return;
  }
  const doc = await db.getActiveWeek(interaction.guildId);
  if (!doc) {
    await interaction.update({ content: UNAVAILABLE, components: [] });
    return;
  }

  const ok = await db.leaveMemberSlot(doc._id, key, interaction.user.id);
  await interaction.update({
    content: ok ? '✅ Left that slot.' : 'You were not on that slot.',
    components: [],
  });
  if (ok) scheduleRefresh(interaction.client, interaction.guildId);
}

// ---------------------------------------------------------------------------
// Officer withdrawal.
//
// Warned, not blocked (spec §3.4). An officer who cannot make it must be able
// to say so; the point of the second press is that they do it knowing three
// people are counting on the slot, not that they are prevented.
// ---------------------------------------------------------------------------
async function handleOfficerWithdraw(interaction, key, { confirmed }) {
  if (!parseSlotKey(key) || !db.isReady()) {
    await interaction.update({ content: 'That slot is not on the grid.', components: [] });
    return;
  }
  const doc = await db.getActiveWeek(interaction.guildId);
  if (!doc) {
    await interaction.update({ content: UNAVAILABLE, components: [] });
    return;
  }

  const slot = render.slotOf(doc, key);
  const members = slot.members || [];
  const otherOfficers = (slot.officers || []).filter(o => o.userId !== interaction.user.id);

  // First press with people on the slot and nobody else to cover it: warn.
  if (!confirmed && members.length > 0 && otherOfficers.length === 0) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    await interaction.update({
      content:
        `⚠️ **${members.length} member${members.length === 1 ? ' is' : 's are'} on this slot** and no other ` +
        `officer is covering it. Withdrawing closes the slot and they'll be told.\n\n` +
        `${render.slotDetail(doc, key)}`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${IDS.OFFICER_WITHDRAW_CONFIRM}:${key}`)
            .setLabel('Withdraw anyway')
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    return;
  }

  const ok = await db.removeOfficerSlot(doc._id, key, interaction.user.id);
  if (!ok) {
    await interaction.update({ content: 'You were not marked on that slot.', components: [] });
    return;
  }

  // Slot closed with people on it — tell them. Best effort: a member with DMs
  // closed cannot be reached, and that must not fail the withdrawal (spec §7.4).
  let notified = 0;
  if (members.length > 0 && otherOfficers.length === 0) {
    const parsed = parseSlotKey(key);
    const when = `${dayHeading(parsed.dayKey, new Date(doc.weekStartAt))} ${parsed.hhmm} ${TZ_LABEL}`;
    for (const m of members) {
      try {
        const user = await interaction.client.users.fetch(m.userId);
        await user.send(
          `Your officer carry slot on **${when}** was withdrawn by the officer running it, ` +
          `so the slot has closed. Sorry about that — pick another slot on the schedule board.`,
        );
        notified += 1;
      } catch { /* DMs closed — the board re-render is what everyone reads */ }
    }
  }

  await interaction.update({
    content: notified
      ? `✅ Withdrawn. ${notified} member${notified === 1 ? '' : 's'} notified.`
      : '✅ Withdrawn.',
    components: [],
  });
  scheduleRefresh(interaction.client, interaction.guildId);
}

// ---------------------------------------------------------------------------
// Router. Claims only `occarry:`.
// ---------------------------------------------------------------------------
async function route(interaction) {
  const id = interaction.customId;
  if (typeof id !== 'string' || !id.startsWith(NAMESPACE)) return false;

  try {
    if (interaction.isButton()) {
      if (id === IDS.JOIN_BUTTON) {
        await handleDayPrompt(interaction, { openOnly: true, selectId: IDS.JOIN_DAY, officerOnly: false });
        return true;
      }
      if (id === IDS.AVAIL_BUTTON) {
        await handleDayPrompt(interaction, { openOnly: false, selectId: IDS.AVAIL_DAY, officerOnly: true });
        return true;
      }
      if (id === IDS.MINE_BUTTON) { await handleMine(interaction); return true; }

      if (id.startsWith(`${IDS.LEAVE}:`)) {
        await handleLeave(interaction, id.slice(IDS.LEAVE.length + 1));
        return true;
      }
      if (id.startsWith(`${IDS.OFFICER_WITHDRAW_CONFIRM}:`)) {
        await handleOfficerWithdraw(interaction, id.slice(IDS.OFFICER_WITHDRAW_CONFIRM.length + 1), { confirmed: true });
        return true;
      }
      if (id.startsWith(`${IDS.OFFICER_WITHDRAW}:`)) {
        await handleOfficerWithdraw(interaction, id.slice(IDS.OFFICER_WITHDRAW.length + 1), { confirmed: false });
        return true;
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (id === IDS.JOIN_DAY) {
        await handleSlotPrompt(interaction, interaction.values?.[0], { openOnly: true, slotIdBase: IDS.JOIN_SLOT });
        return true;
      }
      if (id === IDS.AVAIL_DAY) {
        await handleSlotPrompt(interaction, interaction.values?.[0], { openOnly: false, slotIdBase: IDS.AVAIL_SLOT });
        return true;
      }
      if (id.startsWith(`${IDS.JOIN_SLOT}:`))  { await handleJoinCommit(interaction);  return true; }
      if (id.startsWith(`${IDS.AVAIL_SLOT}:`)) { await handleAvailCommit(interaction); return true; }
    }
  } catch (err) {
    console.error('[officercarry/handlers] Interaction failed:', err);
    try {
      const payload = { content: 'Something went wrong with that. Try again.', components: [] };
      if (interaction.deferred || interaction.replied) await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch { /* interaction window gone */ }
    return true;   // claimed it, even though it failed — do not fall through
  }

  // Inside our namespace but unrecognised: claim it rather than letting a stale
  // id fall through to another router.
  return true;
}

module.exports = {
  route,
  isGodfather,
  isOfficer,
  postPanel,
  refreshPanelNow,
  scheduleRefresh,
  CHANNELS,
};
