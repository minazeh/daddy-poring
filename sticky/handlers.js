// ---------------------------------------------------------------------------
// Sticky message interaction handlers.
//
// Owns exactly one interaction: the `sticky:modal:<mode>:<channelId>` submit.
// route()
// claims ONLY the `sticky:` namespace and returns false for everything else, so
// it can be chained into events/interactionCreate.js beside the other routers
// without stealing a single foreign customId (proven both directions in
// scripts/sim-sticky-message.js).
//
// Also home to the STICKY-ON-STICKY conflict check (spec §5), which is the one
// piece of this feature that reaches outside its own module.
// ---------------------------------------------------------------------------

const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
} = require('discord.js');

const db = require('./db');
const engine = require('./engine');
const {
  IDS,
  MODES,
  FIELDS,
  STICKY_ROLE_IDS,
  MODAL_CONTENT_MAX,
  TITLE_MAX,
  COLOR_MAX,
  COPY,
} = require('./constants');

// --- the other sticky engines, for the conflict check ----------------------
// These modules are ALREADY loaded by events/ready.js, so requiring them here
// attaches to the same singletons — no second MongoClient, no second watch Map.
const ticketDb = require('../ticket/db');
const ticketSticky = require('../ticket/sticky');
const campaignDb = require('../activitycampaign/db');
const { REMINDER_CHANNEL_ID } = require('../gvg/constants');

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// ---------------------------------------------------------------------------
// The gate — Godfathers + officers (spec §3), the same combined list the carry
// Mark-Paid buttons use.
// ---------------------------------------------------------------------------
function isStickyOfficer(interaction) {
  const cache = interaction.member?.roles?.cache;
  if (!cache) return false;
  return STICKY_ROLE_IDS.some(roleId => cache.has?.(roleId));
}

// ---------------------------------------------------------------------------
// STICKY-ON-STICKY (spec §5) — the real risk in this feature.
//
// Two sticky engines in one channel each race to be the newest message and
// PING-PONG FOREVER: A reposts, which pushes B up, so B reposts, which pushes A
// up… burning rate limit and spamming the channel until somebody notices. It
// cannot be resolved at runtime, so it is refused up front and the refusal
// names which feature owns the channel.
//
// Detection, most reliable first, per engine:
//
//   TICKETS — two independent signals, either is enough. ticket/sticky.js's
//     watch Map is exact for the live process, and the tickets collection is
//     the source of truth behind it (status 'accepted' == channel is live).
//     Checking BOTH means a ticket survives a failed resume and a ticket
//     created seconds ago is still caught.
//
//   ACTIVITY CAMPAIGN — activitycampaign/sticky.js keeps its channel only in a
//     module-private `cache` object with no accessor, so the config document is
//     the reliable read: `active` plus a matching `channelId`.
//
//   GVG EVENT REMINDER — gvg/reminder.js stickies in a FIXED channel
//     (gvg/constants.js REMINDER_CHANNEL_ID) whenever an event is inside its
//     reminder window. A static id needs no lookup at all, so this is refused
//     unconditionally rather than only while a reminder happens to be live —
//     an officer must not be able to set a sticky at 3pm that starts fighting
//     an event reminder at 7pm.
//
//     *** NOT IN THE SPEC. Spec §5 lists tickets and the activity campaign.
//     gvg/reminder.js is a THIRD sticky engine hooked into the same
//     events/messageCreate.js and qualifies under §5's own rule ("refuse in a
//     channel already owned by another engine"). Flagged to Nanna; remove this
//     one entry to revert to the letter of the spec. ***
//
// Returns a human label for the owning feature, or null when the channel is
// free. Never throws — a store that is down degrades to "no known conflict"
// rather than blocking every `set`.
// ---------------------------------------------------------------------------
async function conflictOwnerFor(channelId) {
  // --- GvG event reminder: static id, no I/O -------------------------------
  if (channelId === REMINDER_CHANNEL_ID) return 'the Guild Event reminder';

  // --- Support tickets ----------------------------------------------------
  try {
    if (ticketSticky._watched?.has?.(channelId)) return 'a Guild Support ticket';
  } catch { /* module shape changed — fall through to the store */ }

  try {
    if (ticketDb.isReady()) {
      const ticket = await ticketDb.getTicketByChannel(channelId);
      if (ticket && ticket.status === 'accepted') return 'a Guild Support ticket';
    }
  } catch (err) {
    console.warn('[sticky/handlers] Ticket conflict check failed:', err?.message || err);
  }

  // --- Activity campaign --------------------------------------------------
  try {
    if (campaignDb.isReady()) {
      const cfg = await campaignDb.getConfig();
      if (cfg?.active && cfg.channelId === channelId) return 'the Activity Campaign';
    }
  } catch (err) {
    console.warn('[sticky/handlers] Campaign conflict check failed:', err?.message || err);
  }

  return null;
}

// ---------------------------------------------------------------------------
// The modal (spec §4). Three inputs at most; only Content is required.
//
// The target channel id rides in the customId, so a modal opened before a
// redeploy and submitted after it still lands in the right channel with no
// in-memory state.
//
// `existing` prefills every field for `edit`. Passing null gives the blank
// `set` modal. `mode` decides only the modal's own title and the wording of the
// confirmation the officer gets back.
// ---------------------------------------------------------------------------
function buildModal(channelId, mode = MODES.SET, existing = null) {
  const contentInput = new TextInputBuilder()
    .setCustomId(FIELDS.CONTENT)
    .setLabel(COPY.LABEL_CONTENT)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MODAL_CONTENT_MAX)
    .setPlaceholder(COPY.PLACEHOLDER_CONTENT);

  const titleInput = new TextInputBuilder()
    .setCustomId(FIELDS.TITLE)
    .setLabel(COPY.LABEL_TITLE)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(TITLE_MAX)
    .setPlaceholder(COPY.PLACEHOLDER_TITLE);

  const colorInput = new TextInputBuilder()
    .setCustomId(FIELDS.COLOR)
    .setLabel(COPY.LABEL_COLOR)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(COLOR_MAX)
    .setPlaceholder(COPY.PLACEHOLDER_COLOR);

  if (existing) {
    // setValue('') is rejected by Discord for an optional field, so only set
    // what actually has a value.
    if (existing.content) contentInput.setValue(String(existing.content).slice(0, MODAL_CONTENT_MAX));
    if (existing.title) titleInput.setValue(String(existing.title).slice(0, TITLE_MAX));
    if (existing.color != null) {
      colorInput.setValue(`#${Number(existing.color).toString(16).padStart(6, '0').toUpperCase()}`);
    }
  }

  return new ModalBuilder()
    .setCustomId(`${IDS.MODAL}:${mode}:${channelId}`)
    .setTitle(mode === MODES.EDIT ? COPY.MODAL_TITLE_EDIT : COPY.MODAL_TITLE_SET)
    .addComponents(
      new ActionRowBuilder().addComponents(contentInput),
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(colorInput),
    );
}

// ---------------------------------------------------------------------------
// Build the ephemeral confirmation.
//
// Every decision the bot made ON THE OFFICER'S BEHALF is surfaced here — the
// format chosen, an over-length promotion, a colour that could not be read, a
// colour that does not apply. The officer never has to guess why their sticky
// looks the way it does. Exported so the sim can read the exact words an
// officer would see.
// ---------------------------------------------------------------------------
function buildConfirmation({ channelMention, action, doc, colorInfo }) {
  const fmt = engine.formatFor(doc);
  const notes = [];

  if (fmt.promoted) notes.push(COPY.NOTE_PROMOTED(fmt.length));
  else if (fmt.mode === 'embed') notes.push(COPY.NOTE_EMBED);
  else notes.push(COPY.NOTE_PLAIN);

  if (colorInfo?.invalid && fmt.hasTitle) notes.push(COPY.NOTE_BAD_COLOR(colorInfo.raw));
  else if (colorInfo?.supplied && !fmt.hasTitle) notes.push(COPY.NOTE_COLOR_IGNORED);

  notes.push(COPY.NOTE_NO_PING);
  notes.push(COPY.NOTE_FOLLOWS);

  const header =
    action === 'replaced' ? COPY.CONFIRM_REPLACED(channelMention)
      : action === 'updated' ? COPY.CONFIRM_UPDATED(channelMention)
        : COPY.CONFIRM_CREATED(channelMention);

  return `${header}\n\n${notes.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Modal submit — the one interaction this feature owns.
// ---------------------------------------------------------------------------
async function handleModalSubmit(interaction, mode, channelId) {
  // Re-check the gate on submit: a modal can be sitting open across a role
  // change, and the command's check is not a substitute for this one.
  if (!isStickyOfficer(interaction)) {
    await interaction.reply(ephemeral(COPY.NO_PERMISSION));
    return;
  }
  if (!db.isReady()) {
    await interaction.reply(ephemeral(COPY.DB_DOWN));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let channel = null;
  try {
    channel = await interaction.client.channels.fetch(channelId);
  } catch { /* handled below */ }

  if (!channel?.isTextBased?.()) {
    await interaction.editReply(COPY.NOT_TEXT_CHANNEL);
    return;
  }

  // Re-check the conflict too. The window between opening the modal and
  // submitting it is small, but a ticket channel can be created inside it.
  const owner = await conflictOwnerFor(channelId);
  if (owner) {
    await interaction.editReply(COPY.CONFLICT(`<#${channelId}>`, owner));
    return;
  }

  const rawContent = interaction.fields.getTextInputValue(FIELDS.CONTENT) ?? '';
  const rawTitle = (interaction.fields.getTextInputValue(FIELDS.TITLE) ?? '').trim();
  const rawColor = (interaction.fields.getTextInputValue(FIELDS.COLOR) ?? '').trim();

  const content = rawContent.trim();
  if (!content) {
    await interaction.editReply('⚠️ The sticky needs some content.');
    return;
  }

  const colorInfo = { ...engine.parseColorInput(rawColor), raw: rawColor };

  // Snapshot the previous state BEFORE the upsert — upsert() nulls messageId,
  // so the id of the message to take down has to be read first.
  const previous = await db.get(channelId);
  const previousMessageId = previous?.messageId ?? null;

  const doc = await db.upsert({
    channelId,
    guildId: interaction.guildId,
    content,
    title: rawTitle || null,
    color: colorInfo.color,
    setBy: interaction.user.id,
    setByName: interaction.member?.displayName ?? interaction.user.username,
  });

  if (!doc) {
    await interaction.editReply(COPY.DB_DOWN);
    return;
  }

  try {
    await engine.install(channel, doc, previousMessageId);
  } catch (err) {
    // The record is written but the message is not up. Roll the record back so
    // the store never claims a sticky that isn't there.
    console.warn(`[sticky/handlers] Could not post sticky in ${channelId}:`, err?.message || err);
    engine.forget(channelId);
    await db.remove(channelId);
    await interaction.editReply(
      `⚠️ I couldn't post in <#${channelId}> — check I have **View Channel** and ` +
      '**Send Messages** there, then try again. Nothing was saved.',
    );
    return;
  }

  // Wording only. `edit` always says "updated"; `set` says "replaced" when it
  // displaced an existing sticky (spec §3) and "set" when it created one.
  const action = mode === MODES.EDIT ? 'updated' : (previous ? 'replaced' : 'created');
  await interaction.editReply(
    buildConfirmation({ channelMention: `<#${channelId}>`, action, doc, colorInfo }),
  );
}

// ---------------------------------------------------------------------------
// Router. Claims ONLY the `sticky:` namespace — same shape as carry/handlers.js
// route(). Returns true if this module owned the interaction.
// ---------------------------------------------------------------------------
async function route(interaction) {
  if (!interaction.isModalSubmit?.()) return false;

  const id = interaction.customId || '';
  if (!id.startsWith('sticky:')) return false;

  if (id.startsWith(`${IDS.MODAL}:`)) {
    // sticky:modal:<mode>:<channelId>
    const rest = id.slice(IDS.MODAL.length + 1);
    const sep = rest.indexOf(':');
    if (sep === -1) return false;
    const mode = rest.slice(0, sep);
    const channelId = rest.slice(sep + 1);
    if (mode !== MODES.SET && mode !== MODES.EDIT) return false;
    await handleModalSubmit(interaction, mode, channelId);
    return true;
  }
  return false;
}

module.exports = {
  route,
  // exported for the command + tests
  isStickyOfficer,
  conflictOwnerFor,
  buildModal,
  buildConfirmation,
  handleModalSubmit,
};
