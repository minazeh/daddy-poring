// ---------------------------------------------------------------------------
// Shared constants for the Final Mirage carry-sales feature.
//
// Spec: docs/CARRY_SYSTEM_SPEC.md
//
// This is the first feature in this bot that handles MONEY. Two things follow
// from that and they are visible all through this module:
//   * Mongo is authoritative for seat state, not an in-memory Map (spec §4.1).
//   * Bookings are a permanent ledger and are never deleted (spec §4.2).
//
// PAYMENT ACCOUNT DETAILS ARE NOT IN THIS FILE, NOT IN THIS REPO, AND NOT IN
// THE ENVIRONMENT EITHER. The bot never holds or forwards account numbers: the
// buyer is told to DM the RUNNER (the run's creator, run.createdBy) and settle
// it between themselves. The payment-method select survives only as a hint to
// the runner about what the buyer intends to pay with.
// ---------------------------------------------------------------------------

const { CLASS_ROLE_BY_ID } = require('../guildapp/constants');
const { TICKET_OFFICER_ROLE_IDS } = require('../ticket/constants');

// ---------------------------------------------------------------------------
// customId namespace.
//
// RESTART SAFETY: PANEL_BUTTON and TIER_SELECT are STATIC ids — a panel posted
// months ago keeps working after any redeploy because nothing about it is held
// in memory. Every id past the run pick carries the run id and seat index, so a
// restarted process rebuilds full context from the click alone.
//
// Discord forbids answering a modal submit with another modal, so the IGN modal
// is the LAST modal in the chain and is followed by a select (allowed).
//
// Flow chain:
//   carry:pick                            panel "Pick your slot" button
//   carry:tier                            ephemeral tier select
//   carry:run:<tierKey>                   ephemeral run/timeslot select
//   carry:priest:<runId>:<seatIndex>      "I am a Priest" declaration button -> IGN modal
//   carry:ign:<runId>:<seatIndex>:<d>     IGN modal submit (d = 1 if self-declared)
//   carry:pay:<runId>:<seatIndex>         payment-method select (draft in PENDING_DRAFTS)
//   carry:paid:<bookingId>                officer Mark Paid
//   carry:release:<bookingId>             officer Release
//   carry:cancel:<bookingId>              officer Cancel (the only way to void a PAID seat)
// ---------------------------------------------------------------------------
const IDS = {
  PANEL_BUTTON:  'carry:pick',
  TIER_SELECT:   'carry:tier',
  RUN_SELECT:    'carry:run',      // carry:run:<tierKey>
  PRIEST_DECLARE:'carry:priest',   // carry:priest:<runId>:<seatIndex>
  IGN_MODAL:     'carry:ign',      // carry:ign:<runId>:<seatIndex>:<declared 0|1>
  PAY_SELECT:    'carry:pay',      // carry:pay:<runId>:<seatIndex>
  MARK_PAID:     'carry:paid',     // carry:paid:<bookingId>
  RELEASE:       'carry:release',  // carry:release:<bookingId>
  CANCEL:        'carry:cancel',   // carry:cancel:<bookingId>
};

// Modal component customIds.
const FIELDS = {
  IGN: 'carry_ign',
};

// ---------------------------------------------------------------------------
// Channels (spec §2). Env-overridable so a test server can be pointed elsewhere
// without a code change; the literals are the live guild's ids.
// ---------------------------------------------------------------------------
const CHANNELS = {
  // The public sales panel lives here (posted by /carrypanel).
  PANEL:   process.env.CARRY_PANEL_CHANNEL_ID   || '1541160645292982373',
  // One message per run — the public schedule board.
  BOARD:   process.env.CARRY_BOARD_CHANNEL_ID   || '1527144922812121118',
  // Officer-facing: one entry per unpaid hold.
  PENDING: process.env.CARRY_PENDING_CHANNEL_ID || '1541159719266156697',
};

// ---------------------------------------------------------------------------
// Roles (spec §2).
// ---------------------------------------------------------------------------

// Run admin: /carrypanel and /carryrun.
const GODFATHERS_ROLE_ID = '1518076150692188200';

// May Mark Paid / Release / Cancel. Same list the ticket system uses — one
// source of truth, so an officer added there is an officer here too.
const CARRY_OFFICER_ROLE_IDS = TICKET_OFFICER_ROLE_IDS;

// The Priest class role. The Priest seat is SELLABLE but class-gated.
const PRIEST_ROLE_ID = '1518174089817227415';

// Every class role in the guild. Used to tell "no class role at all" (may
// self-declare Priest, spec §5) apart from "has a class role, and it isn't
// Priest" (refused outright, spec §11).
const CLASS_ROLE_IDS = Object.keys(CLASS_ROLE_BY_ID);

// ---------------------------------------------------------------------------
// Product (spec §3). Capacity and the Priest seat FOLLOW FROM THE TIER and are
// never entered by hand, so they cannot drift from the spec.
//
// priestSeatIndex is the LAST seat of each tier. Seats are assigned lowest open
// general seat first, so the Priest seat is the last one left — which is
// exactly when the Priest declaration step (spec §7.4) becomes relevant.
// ---------------------------------------------------------------------------
const TIERS = {
  SS: {
    key:   'SS',
    label: 'Guaranteed SS',
    priceUsd: 5,
    slots: 4,
    priestSeatIndex: 3,
    emoji: '🔹',
    color: 0x3498db,
  },
  SSS: {
    key:   'SSS',
    label: 'Guaranteed SSS',
    priceUsd: 10,
    slots: 3,
    priestSeatIndex: 2,
    emoji: '🔶',
    color: 0xe67e22,
  },
};

const TIER_KEYS = Object.keys(TIERS);

function tierFor(key) {
  return TIERS[key] || null;
}

function priceLabel(tier) {
  return `$${tier.priceUsd}`;
}

// ---------------------------------------------------------------------------
// Payment methods (spec §3). LABELS ONLY — there is no account detail attached
// to any of them, anywhere. The buyer's pick is carried on the booking, shown
// on the pending board and named in the buyer's DM so the runner knows what is
// coming before the buyer messages them.
// ---------------------------------------------------------------------------
const PAYMENT_METHODS = {
  gcash:  { key: 'gcash',  label: 'GCash',         emoji: '📱' },
  bank:   { key: 'bank',   label: 'Bank Transfer', emoji: '🏦' },
  wise:   { key: 'wise',   label: 'Wise',          emoji: '🌐' },
  paypal: { key: 'paypal', label: 'PayPal',        emoji: '💳' },
};

const PAYMENT_METHOD_KEYS = Object.keys(PAYMENT_METHODS);

function paymentMethodFor(key) {
  return PAYMENT_METHODS[key] || null;
}

// ---------------------------------------------------------------------------
// Timings.
// ---------------------------------------------------------------------------

// How long an unpaid hold survives before auto-release (spec §7.8).
const PENDING_HOLD_MS = 30 * 60 * 1000; // 30 minutes

// How long a half-finished purchase draft (tier/run/IGN picked, payment method
// not yet chosen) is kept in memory. NO SEAT IS CLAIMED during this window, so
// losing it to a restart costs the buyer a re-click and nothing else.
const DRAFT_TTL_MS = 15 * 60 * 1000;

// Discord select-menu option cap — bounds the timeslot list.
const MAX_SELECT_OPTIONS = 25;

// GMT+7 is server time for this guild — every date/time the members see.
const TIME_ZONE_OFFSET_MINUTES = 7 * 60;
const TIME_ZONE_LABEL = 'GMT+7';
const TIME_ZONE_DISPLAY = 'Server time (GMT+7)';

// /carryrun create|edit input formats.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;   // YYYY-MM-DD (GMT+7)
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/; // HH:MM 24h (GMT+7)

// Input caps.
const IGN_MAX = 32;

// ---------------------------------------------------------------------------
// Seat + booking status vocabularies. Kept as constants so a typo in a status
// string is a crash at load, not a silently unmatched conditional update.
// ---------------------------------------------------------------------------
const SEAT_STATUS = {
  OPEN:    'open',
  PENDING: 'pending',
  PAID:    'paid',
};

const BOOKING_STATUS = {
  PENDING:     'pending',
  PAID:        'paid',
  COMPLETED:   'completed',
  RELEASED:    'released',
  CANCELLED:   'cancelled',
  RUN_DELETED: 'run_deleted',
};

// Statuses that still occupy a seat.
const OCCUPYING_BOOKING_STATUSES = [BOOKING_STATUS.PENDING, BOOKING_STATUS.PAID];

const RUN_STATUS = {
  OPEN:      'open',       // accepting joins
  CLOSED:    'closed',     // manually closed; board stays
  CONCLUDED: 'concluded',  // start time passed; board stays, restyled
  DELETED:   'deleted',    // run + board message removed; bookings retained
};

// ---------------------------------------------------------------------------
// Colours.
// ---------------------------------------------------------------------------
const COLORS = {
  PANEL:     0x2b2d31,   // matches the guild-application / ticket panels
  OPEN:      0x2ecc71,
  FULL:      0xf1c40f,
  CLOSED:    0x607d8b,
  CONCLUDED: 0x607d8b,
  PENDING:   0xf1c40f,
  PAID:      0x2ecc71,
  RELEASED:  0x95a5a6,
  CANCELLED: 0xe74c3c,
};

// ---------------------------------------------------------------------------
// Copy. Everything buyer-facing lives here so wording is a one-file edit.
// ---------------------------------------------------------------------------

const PANEL_TITLE = 'Final Mirage Carries';

// Conrad's supplied copy is the spine of this embed — the opening hook, the
// "Pricing & Available Slots" block and the "Accepted Payment Methods" list are
// his wording and are not to be rewritten. The operational paragraphs after them
// (Priest seat, what you'll be asked, the hold window) are ours and describe the
// mechanism, so they MUST be kept true to the flow in handlers.js.
const PANEL_DESCRIPTION =
  'Get carried through **Final Mirage** with guaranteed high-tier rewards. ' +
  'Lock in your spot before spots fill up.\n\n' +
  '**Pricing & Available Slots**\n\n' +
  `${TIERS.SS.emoji} **${TIERS.SS.label}:** $${TIERS.SS.priceUsd} per slot (${TIERS.SS.slots} slots available per run)\n` +
  `${TIERS.SSS.emoji} **${TIERS.SSS.label}:** $${TIERS.SSS.priceUsd} per slot (${TIERS.SSS.slots} slots available per run)\n\n` +
  '**Accepted Payment Methods**\n\n' +
  'GCash\nBank Transfer\nWise\nPayPal\n\n' +
  'One slot in every run is a **Priest seat** and can only be taken by a Priest. ' +
  "If you're a Priest but don't have the class role here, you can say so when you book " +
  'and an officer will confirm it.\n\n' +
  "You'll be asked for:\n\n" +
  '**Tier** — SS or SSS\n' +
  '**Time slot** — pick from the open runs\n' +
  '**In-game Name (IGN)** — so we can find you in game\n' +
  '**Payment method** — GCash, Bank Transfer, Wise or PayPal\n\n' +
  `⏳ **Your slot is held for ${PENDING_HOLD_MS / 60000} minutes.** As soon as you book, ` +
  "you'll be DM'd who to message about payment — arrange it with them directly. Pay within " +
  'the hold window and an officer will confirm it; after that the slot is released and ' +
  'someone else can take it.\n\n' +
  `🕒 All times shown are **${TIME_ZONE_DISPLAY}**.`;

const PANEL_BUTTON_LABEL = 'Pick your slot';

// DMs — best-effort, never block the flow.
const DM = {
  // runnerMention is an already-built `<@id>` string for the run's creator.
  // The bot holds no account details: the buyer is pointed at the runner and
  // the two of them settle it between themselves.
  booked: ({ tierLabel, price, runLabel, methodLabel, runnerMention, holdMinutes, bookingId }) =>
    `🧾 **Carry slot held — ${tierLabel}**\n\n` +
    `**Run:** ${runLabel}\n` +
    `**Price:** ${price}\n` +
    `**Payment method:** ${methodLabel}\n` +
    `**Booking:** \`${bookingId}\`\n\n` +
    `💬 **DM ${runnerMention} to arrange payment.** They're running this slot — tap their ` +
    `name to open a DM and tell them you're paying by **${methodLabel}**.\n\n` +
    `⏳ Your slot is held for **${holdMinutes} minutes**. Once you've paid, an officer will ` +
    `confirm it and your seat is locked in. If the hold runs out before payment is confirmed, ` +
    `the slot is released and you'll need to book again.\n\n` +
    `Please include your booking id \`${bookingId}\` when you message them — it makes ` +
    `matching your payment instant.`,

  // The run has no resolvable creator (an old run, or the runner has left the
  // server). NEVER render a broken mention — hand it to the officers instead.
  bookedNoRunner: ({ tierLabel, price, runLabel, methodLabel, holdMinutes, bookingId }) =>
    `🧾 **Carry slot held — ${tierLabel}**\n\n` +
    `**Run:** ${runLabel}\n` +
    `**Price:** ${price}\n` +
    `**Payment method:** ${methodLabel}\n` +
    `**Booking:** \`${bookingId}\`\n\n` +
    `⚠️ I couldn't work out who's running this slot, so I can't point you straight at them. ` +
    `**An officer will follow up with you to arrange payment** — your booking is already on ` +
    `their board.\n\n` +
    `⏳ Your slot is held for **${holdMinutes} minutes**. Have your booking id \`${bookingId}\` ` +
    `ready when they message you.`,

  paid: ({ tierLabel, runLabel }) =>
    `✅ **Payment confirmed — ${tierLabel}**\n\n` +
    `Your seat for **${runLabel}** is locked in. See you there — please be on time.`,

  released: ({ tierLabel, runLabel, holdMinutes }) =>
    `⌛ **Slot released — ${tierLabel}**\n\n` +
    `Your hold on **${runLabel}** ran out after ${holdMinutes} minutes without a confirmed payment, ` +
    `so the slot is open again.\n\n` +
    `If you've already paid, contact an officer — don't book a second slot.`,

  cancelled: ({ tierLabel, runLabel, reason }) =>
    `🚫 **Booking cancelled — ${tierLabel}**\n\n` +
    `Your booking for **${runLabel}** was cancelled by an officer.\n\n` +
    (reason ? `**Reason:** ${reason}\n\n` : '') +
    `If you have already paid, contact an officer about a refund — your booking record is kept.`,

  runDeleted: ({ tierLabel, runLabel }) =>
    `🚫 **Run cancelled — ${tierLabel}**\n\n` +
    `The run you were holding a slot for (**${runLabel}**) has been removed, so your hold is gone. ` +
    `Your booking record is kept. Book another slot from the carry panel whenever you're ready.`,
};

module.exports = {
  IDS,
  FIELDS,
  CHANNELS,
  GODFATHERS_ROLE_ID,
  CARRY_OFFICER_ROLE_IDS,
  PRIEST_ROLE_ID,
  CLASS_ROLE_IDS,
  CLASS_ROLE_BY_ID,
  TIERS,
  TIER_KEYS,
  tierFor,
  priceLabel,
  PAYMENT_METHODS,
  PAYMENT_METHOD_KEYS,
  paymentMethodFor,
  PENDING_HOLD_MS,
  DRAFT_TTL_MS,
  MAX_SELECT_OPTIONS,
  TIME_ZONE_OFFSET_MINUTES,
  TIME_ZONE_LABEL,
  TIME_ZONE_DISPLAY,
  DATE_RE,
  TIME_RE,
  IGN_MAX,
  SEAT_STATUS,
  BOOKING_STATUS,
  OCCUPYING_BOOKING_STATUSES,
  RUN_STATUS,
  COLORS,
  PANEL_TITLE,
  PANEL_DESCRIPTION,
  PANEL_BUTTON_LABEL,
  DM,
};
