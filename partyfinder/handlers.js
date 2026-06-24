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
} = require('discord.js');

const {
  IDS,
  FIELDS,
  PARTY_FINDER_CHANNEL_ID,
  CARRY_ROLE_ID,
  EXPIRY_LEAD_MINUTES_BEFORE_START,
  PARTYFINDER_ROLE_IDS,
  PARTY_SIZE_OPTIONS,
  CLASS_ALLOWED_CATEGORIES,
  CLASS_CATEGORY_BY_ROLE_ID,
  CLASS_ROLE_BY_ID,
  TIME_ZONE_OFFSET_MINUTES,
  TIME_ZONE_LABEL,
  TIME_ZONE_DISPLAY,
  TIME_SLOT_STEP_MINUTES,
  TIME_SLOT_LEAD_MINUTES,
  TIME_SLOT_MAX_OPTIONS,
} = require('./constants');

const ps = require('./state');

const CATEGORIES = ['Tank', 'Heal', 'DPS'];

// ---------------------------------------------------------------------------
// GMT+7 start-time slot generation + label formatting.
//
// Slots are 15-min increments. Earliest = round (now + LEAD) UP to the next
// 15-min boundary. 15-min boundaries align identically across whole-hour tz
// offsets, so we round the epoch to the next 900s multiple; the +7h offset only
// shifts the LABELS, not the boundary instants. Returns up to MAX ascending
// { epochSecs, label } objects.
// ---------------------------------------------------------------------------
function generateTimeSlots(nowMs = Date.now()) {
  const stepMs = TIME_SLOT_STEP_MINUTES * 60 * 1000;
  const earliestMs = nowMs + TIME_SLOT_LEAD_MINUTES * 60 * 1000;
  // Round UP to the next 15-min boundary (in UTC; boundaries are tz-aligned).
  const firstMs = Math.ceil(earliestMs / stepMs) * stepMs;

  const slots = [];
  for (let i = 0; i < TIME_SLOT_MAX_OPTIONS; i++) {
    const ms = firstMs + i * stepMs;
    slots.push({ epochSecs: Math.floor(ms / 1000), label: formatGmt7Label(ms) });
  }
  return slots;
}

// Format an instant (ms) as a GMT+7 clock label "h:mm AM/PM". If the instant
// falls on a different GMT+7 calendar day than "today" in GMT+7, prefix the
// short weekday (e.g. "Wed 12:15 AM") to disambiguate.
function formatGmt7Label(ms, nowMs = Date.now()) {
  const shifted = new Date(ms + TIME_ZONE_OFFSET_MINUTES * 60 * 1000);
  const nowShifted = new Date(nowMs + TIME_ZONE_OFFSET_MINUTES * 60 * 1000);

  // Read UTC getters on the shifted date == local GMT+7 wall-clock values.
  let h = shifted.getUTCHours();
  const m = shifted.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  const mm = String(m).padStart(2, '0');
  let label = `${h}:${mm} ${ampm}`;

  const sameDay =
    shifted.getUTCFullYear() === nowShifted.getUTCFullYear() &&
    shifted.getUTCMonth() === nowShifted.getUTCMonth() &&
    shifted.getUTCDate() === nowShifted.getUTCDate();
  if (!sameDay) {
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][shifted.getUTCDay()];
    label = `${weekday} ${label}`;
  }
  return label;
}

// Build a GMT+7 start-time select row (shared by the party + carry flows).
// Each option label is a Server-time (GMT+7) clock label; value = epoch secs.
function buildTimeSelectRow(customId) {
  const slots = generateTimeSlots();
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(`Select start time (${TIME_ZONE_DISPLAY})`)
    .addOptions(
      ...slots.map(slot =>
        new StringSelectMenuOptionBuilder()
          .setLabel(slot.label)
          .setValue(String(slot.epochSecs)),
      ),
    );
  return new ActionRowBuilder().addComponents(select);
}

// Per-category Join button styles (mirrors the source).
const CATEGORY_STYLE = {
  Tank: ButtonStyle.Primary,
  Heal: ButtonStyle.Success,
  DPS:  ButtonStyle.Danger,
};

// ---------------------------------------------------------------------------
// Gates / lookups
// ---------------------------------------------------------------------------
function hasPartyfinderRole(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return PARTYFINDER_ROLE_IDS.some(roleId => member.roles?.cache?.has?.(roleId));
}

function hasCarryRole(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return member.roles?.cache?.has?.(CARRY_ROLE_ID) ?? false;
}

// Look up the member's class category (Tank/Heal/DPS) + class name.
// Returns { category, className } or { category: null, className: null }.
// NOTE: legacy single-category lookup — join eligibility uses getAllowedCategories.
function getMemberCategory(interaction) {
  const cache = interaction.member?.roles?.cache;
  if (!cache) return { category: null, className: null };
  for (const [roleId, category] of Object.entries(CLASS_CATEGORY_BY_ROLE_ID)) {
    if (cache.has(roleId)) {
      const className = CLASS_ROLE_BY_ID[roleId] || roleId;
      return { category, className };
    }
  }
  return { category: null, className: null };
}

// Multi-role eligibility: union of allowed categories across ALL class roles the
// member holds (most hold one), preserving listed order (primary first). Returns
// { allowed: ['Tank','DPS', ...], className } — allowed is [] if no class role.
// className is a "/"-joined list when the member somehow holds multiple classes.
function getAllowedCategories(interaction) {
  const cache = interaction.member?.roles?.cache;
  if (!cache) return { allowed: [], className: null };

  const allowed = [];
  const classNames = [];
  for (const [roleId, cats] of Object.entries(CLASS_ALLOWED_CATEGORIES)) {
    if (!cache.has(roleId)) continue;
    classNames.push(CLASS_ROLE_BY_ID[roleId] || roleId);
    for (const cat of cats) {
      if (!allowed.includes(cat)) allowed.push(cat); // union, order-preserving
    }
  }
  return { allowed, className: classNames.length ? classNames.join(' / ') : null };
}

function displayName(interaction) {
  return interaction.member?.displayName ?? interaction.user.username;
}

// ---------------------------------------------------------------------------
// Embed builders (build_party_embed / build_carry_embed equivalents)
// ---------------------------------------------------------------------------
// Build the live party embed. When `open` (default), it includes the live
// recruitment-closes countdown field. The full / cancelled / expired states
// pass open=false and override title/color/components separately.
function buildPartyEmbed(party, { open = true } = {}) {
  const filled = ps.totalFilled(party);
  const startLine = party.startEpochSecs
    ? `${party.serverTime} — ${TIME_ZONE_DISPLAY}\n<t:${party.startEpochSecs}:R>`
    : party.serverTime;

  const embed = new EmbedBuilder()
    .setTitle(`🎉 Party Request: ${party.eventName}`)
    .setColor(0x3498db) // blue
    .addFields(
      { name: 'Leader',                 value: party.leaderName,                inline: true },
      { name: '🕒 Start Time',          value: startLine,                       inline: true },
      { name: 'Preferred Power Rating', value: party.powerRating,               inline: true },
      { name: 'Party Size',             value: `${filled}/${party.partySize}`,  inline: true },
    );

  for (const category of CATEGORIES) {
    const needed = party.roleCounts[category] || 0;
    if (needed === 0) continue;
    const members = party.slots[category];
    const lines = members.map(m => `• ${m.name}`);
    while (lines.length < needed) lines.push('• _open_');
    embed.addFields({
      name: `${category} (${members.length}/${needed})`,
      value: lines.length ? lines.join('\n') : '_open_',
      inline: false,
    });
  }

  // Live recruitment countdown — a FIELD (footers don't live-update). Discord
  // renders <t:..:R> as a self-updating "in 14 minutes" with zero edits. Kept
  // as the VERY LAST field, after the Tank/Heal/DPS slots. On closed states
  // (full/cancel/expire pass open=false) it's simply omitted.
  if (open && party.expiryEpochSecs) {
    embed.addFields({
      name: '⏳ Recruitment closes',
      value: `<t:${party.expiryEpochSecs}:R>`,
      inline: false,
    });
  }

  // Footer: absolute close time (Server time, GMT+7) while open + the reminder.
  const closeNote = (open && party.expiryEpochSecs)
    ? `Recruitment closes ${formatGmt7Label(party.expiryEpochSecs * 1000)} — ${TIME_ZONE_DISPLAY} • `
    : '';
  embed.setFooter({
    text: `${closeNote}⚠️ Power rating is self-reported. Please be honest — don't overstate your rating.`,
  });
  return embed;
}

// Build the carry embed. When `open` (default), includes the live request-closes
// countdown field (last). Cancelled / expired states pass open=false to drop it.
function buildCarryEmbed(req, { open = true } = {}) {
  const responders = req.responders.length
    ? req.responders.map(r => `• ${r.name}`).join('\n')
    : '_no responders yet_';

  const startLine = req.startEpochSecs
    ? `${req.serverTime} — ${TIME_ZONE_DISPLAY}\n<t:${req.startEpochSecs}:R>`
    : req.serverTime;

  const embed = new EmbedBuilder()
    .setTitle(`🆘 Carry Request: ${req.eventName}`)
    .setColor(0x9b59b6) // purple
    .addFields(
      { name: 'Requested by',         value: req.leaderName,  inline: true },
      { name: '🕒 Start Time',        value: startLine,       inline: true },
      { name: 'Carriers responding',  value: responders,      inline: false },
    );

  // Live request countdown — LAST field (same placement as the party embed).
  if (open && req.expiryEpochSecs) {
    embed.addFields({
      name: '⏳ Request closes',
      value: `<t:${req.expiryEpochSecs}:R>`,
      inline: false,
    });
  }

  const closeNote = (open && req.expiryEpochSecs)
    ? `Request closes ${formatGmt7Label(req.expiryEpochSecs * 1000)} — ${TIME_ZONE_DISPLAY} • `
    : '';
  embed.setFooter({ text: `${closeNote}Only members with the Carry role can respond.` });
  return embed;
}

// ---------------------------------------------------------------------------
// Component builders
// ---------------------------------------------------------------------------
function buildPartyJoinComponents(partyId) {
  const joinRow = new ActionRowBuilder().addComponents(
    ...CATEGORIES.map(category =>
      new ButtonBuilder()
        .setCustomId(`${IDS.JOIN_PREFIX}:${category}:${partyId}`)
        .setLabel(`Join as ${category}`)
        .setStyle(CATEGORY_STYLE[category]),
    ),
  );
  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.CANCEL_PREFIX}:${partyId}`)
      .setLabel('Cancel (Leader only)')
      .setStyle(ButtonStyle.Secondary),
  );
  return [joinRow, cancelRow];
}

function buildCarryComponents(requestId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.CARRY_RESPOND_PREFIX}:${requestId}`)
        .setLabel("I'll carry this")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${IDS.CARRY_CANCEL_PREFIX}:${requestId}`)
        .setLabel('Cancel (Requester only)')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Entry point: /partyfinder posts the entry card. (Exported for the command.)
// ---------------------------------------------------------------------------
function buildEntryEmbed() {
  return new EmbedBuilder()
    .setTitle('🎮 Party Finder')
    .setDescription('Click a button below to find a party or request a carry.')
    .setColor(0xf1c40f); // gold
}

function buildEntryComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.ENTRY_START)
        .setLabel('Start Party')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(IDS.ENTRY_CARRY)
        .setLabel('I Need Carry')
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Start Party flow
// ---------------------------------------------------------------------------

// Entry-card "Start Party" button -> gate, class check, then size select.
async function handleStartPartyButton(interaction) {
  if (!hasPartyfinderRole(interaction)) {
    await interaction.reply({
      content: "Sorry — you don't have permission to use the Party Finder.",
      ephemeral: true,
    });
    return;
  }

  const { allowed } = getAllowedCategories(interaction);
  if (allowed.length === 0) {
    await interaction.reply({
      content:
        "You don't have a recognized class role yet. Ask an officer to assign your class role before starting a party.",
      ephemeral: true,
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(IDS.SIZE_SELECT)
    .setPlaceholder('Select party size')
    .addOptions(
      ...PARTY_SIZE_OPTIONS.map(size =>
        new StringSelectMenuOptionBuilder().setLabel(size).setValue(size),
      ),
    );

  await interaction.reply({
    content: 'Pick your party size:',
    components: [new ActionRowBuilder().addComponents(select)],
    ephemeral: true,
  });
}

// Party-size select -> show the GMT+7 start-time select (select->reply, legal).
// The size token rides forward in the time-select customId (pf:time:<sizeToken>).
async function handleSizeSelect(interaction) {
  const choice = interaction.values[0];
  const sizeToken = choice === 'Custom' ? 'custom' : parseInt(choice, 10);

  await interaction.update({
    content: `Pick the **start time** — ${TIME_ZONE_DISPLAY}:`,
    components: [buildTimeSelectRow(`${IDS.TIME_SELECT}:${sizeToken}`)],
  });
}

// Start-time select -> show the Details modal. Both size token and chosen start
// epoch ride in the modal customId (pf:details:<sizeToken>:<epoch>). select->modal
// is permitted. There is NO modal->modal anywhere.
async function handleTimeSelect(interaction, sizeToken) {
  const startEpochSecs = parseInt(interaction.values[0], 10);
  await interaction.showModal(buildDetailsModal(sizeToken, startEpochSecs));
}

// Build the "Start Party — Details" modal. The start time is NOT here (picked
// via the pf:time select). When sizeToken === 'custom', a "Party size" text
// input is prepended. The chosen start epoch is baked into the customId.
// discord.js caps a modal at 5 rows — custom uses 3, preset uses 2.
function buildDetailsModal(sizeToken, startEpochSecs) {
  const isCustom = sizeToken === 'custom';
  const modal = new ModalBuilder()
    .setCustomId(`${IDS.DETAILS_PREFIX}:${sizeToken}:${startEpochSecs}`)
    .setTitle('Start Party — Details');

  const rows = [];

  if (isCustom) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELDS.PARTY_SIZE)
          .setLabel('Party size (1-50)')
          .setPlaceholder('e.g. 8')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(2)
          .setRequired(true),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(FIELDS.EVENT_NAME)
        .setLabel('Event name')
        .setPlaceholder('e.g. EDDGA MVP')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(FIELDS.POWER_RATING)
        .setLabel('Preferred power rating')
        .setPlaceholder("e.g. 50000+ — please don't overstate yours")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(50)
        .setRequired(true),
    ),
  );

  modal.addComponents(...rows);
  return modal;
}

// Validate a custom party-size string. Returns an integer 1-50 or null.
function parsePartySize(raw) {
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (n < 1 || n > 50) return null;
  return n;
}

// Party Details modal submit. sizeToken is a number (preset) or 'custom';
// startEpochSecs is the chosen GMT+7 start instant. Stash details, then REPLY
// (ephemeral) with a "Set role counts" bridge button — NOT a modal.
async function handlePartyDetailsModal(interaction, sizeToken, startEpochSecs) {
  // Resolve party size.
  let partySize;
  if (sizeToken === 'custom') {
    partySize = parsePartySize(interaction.fields.getTextInputValue(FIELDS.PARTY_SIZE));
    if (partySize === null) {
      await interaction.reply({
        content: 'Please enter a valid party size (1-50).',
        ephemeral: true,
      });
      return;
    }
  } else {
    partySize = sizeToken;
  }

  const { allowed } = getAllowedCategories(interaction);
  if (allowed.length === 0) {
    // Defensive — they had a class role at Start; if lost mid-flow, stop cleanly.
    await interaction.reply({
      content:
        "You no longer have a recognized class role. Ask an officer to assign your class role and restart.",
      ephemeral: true,
    });
    return;
  }
  // Primary category = first allowed (listed order) — drives the Roles-modal prefill.
  const primaryCategory = allowed[0];

  // Carry the Details values forward. The start time comes from the select (in
  // the customId), so it's not in PENDING_DETAILS. Discord can't re-read a closed
  // modal, so we stash event/power in a short-lived store keyed by user id.
  PENDING_DETAILS.set(interaction.user.id, {
    eventName: interaction.fields.getTextInputValue(FIELDS.EVENT_NAME).trim(),
    powerRating: interaction.fields.getTextInputValue(FIELDS.POWER_RATING).trim(),
    partySize,
    leaderCategory: primaryCategory,
    startEpochSecs,
  });

  // Bridge button — a modal-submit may reply with components, just not a modal.
  // The "Set role counts" button (a Button interaction) is allowed to showModal.
  // primaryCategory rides forward to prefill the leader's own slot to 1.
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.ROLES_OPEN_PREFIX}:${partySize}:${primaryCategory}:${startEpochSecs}`)
      .setLabel('Set role counts')
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({
    content:
      `Party size **${partySize}**, start **${formatGmt7Label(startEpochSecs * 1000)}, ` +
      `${TIME_ZONE_DISPLAY}**. Next, click **Set role counts** to enter how many ` +
      `Tank / Heal / DPS slots you need (must total ${partySize}).`,
    components: [row],
    ephemeral: true,
  });
}

// "Set role counts" bridge button -> show the Roles Needed modal. Button->modal
// is permitted. size + leaderCategory + start epoch ride in the customId.
async function handleRolesOpenButton(interaction, partySize, leaderCategory, startEpochSecs) {
  const modal = new ModalBuilder()
    .setCustomId(`${IDS.ROLES_PREFIX}:${partySize}:${leaderCategory}:${startEpochSecs}`)
    .setTitle('Roles Needed');

  const mk = (id, cat) =>
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(`${cat} slots needed (total)`)
      .setPlaceholder(`Total ${cat} slots, including you if you're ${cat}`)
      .setStyle(TextInputStyle.Short)
      .setMaxLength(2)
      .setRequired(true)
      .setValue(leaderCategory === cat ? '1' : '0');

  modal.addComponents(
    new ActionRowBuilder().addComponents(mk(FIELDS.TANK_COUNT, 'Tank')),
    new ActionRowBuilder().addComponents(mk(FIELDS.HEAL_COUNT, 'Heal')),
    new ActionRowBuilder().addComponents(mk(FIELDS.DPS_COUNT, 'DPS')),
  );

  await interaction.showModal(modal);
}

// Short-lived store bridging Party Details -> Roles Needed modals.
const PENDING_DETAILS = new Map();

// Roles Needed modal submit -> validate + post the public party card.
async function handleRolesModal(interaction, partySize, leaderCategory, startEpochSecs) {
  const tankRaw = interaction.fields.getTextInputValue(FIELDS.TANK_COUNT).trim();
  const healRaw = interaction.fields.getTextInputValue(FIELDS.HEAL_COUNT).trim();
  const dpsRaw  = interaction.fields.getTextInputValue(FIELDS.DPS_COUNT).trim();

  const isInt = s => /^\d+$/.test(s);
  if (!isInt(tankRaw) || !isInt(healRaw) || !isInt(dpsRaw)) {
    await interaction.reply({ content: 'Role counts must be whole numbers.', ephemeral: true });
    return;
  }

  const tankN = parseInt(tankRaw, 10);
  const healN = parseInt(healRaw, 10);
  const dpsN  = parseInt(dpsRaw, 10);
  const total = tankN + healN + dpsN;

  if (total !== partySize) {
    await interaction.reply({
      content:
        `❌ Role counts add up to ${total}, but party size is ${partySize}. ` +
        `Please restart and make sure Tank + Heal + DPS = party size.`,
      ephemeral: true,
    });
    return;
  }

  const roleCounts = { Tank: tankN, Heal: healN, DPS: dpsN };

  // Multi-role leader seating: the leader must be seatable into at least ONE of
  // the categories their class can fill. Seat into the FIRST allowed category
  // (listed order) that has a free slot.
  const { allowed, className } = getAllowedCategories(interaction);
  if (allowed.length === 0) {
    await interaction.reply({
      content:
        "You no longer have a recognized class role. Ask an officer to assign your class role and restart.",
      ephemeral: true,
    });
    return;
  }
  const seatCategory = allowed.find(cat => (roleCounts[cat] || 0) >= 1) ?? null;
  if (seatCategory === null) {
    await interaction.reply({
      content:
        `❌ You set 0 slots for any role your class (${className}) can fill (${allowed.join(' / ')}). ` +
        `Add at least one.`,
      ephemeral: true,
    });
    return;
  }

  // Pull the Details values stashed by the previous modal.
  const pending = PENDING_DETAILS.get(interaction.user.id);
  PENDING_DETAILS.delete(interaction.user.id);
  if (!pending) {
    await interaction.reply({
      content: 'Something went wrong reading your party details — please restart.',
      ephemeral: true,
    });
    return;
  }

  const partyId = ps.newId();

  // Post the public card into the party-finder channel.
  let channel = null;
  try {
    channel = await interaction.client.channels.fetch(PARTY_FINDER_CHANNEL_ID);
  } catch (err) {
    console.warn('[partyfinder] Could not fetch party-finder channel:', err?.message || err);
  }
  if (!channel || typeof channel.send !== 'function') {
    console.warn(`[partyfinder] Party-finder channel ${PARTY_FINDER_CHANNEL_ID} missing or not sendable.`);
    await interaction.reply({
      content: "Sorry — couldn't post the party right now. Please contact staff.",
      ephemeral: true,
    });
    return;
  }

  let sentMessage;
  try {
    // Placeholder send so we have a message id (parity with the source two-step).
    sentMessage = await channel.send({
      embeds: [new EmbedBuilder().setTitle('Creating party...').setColor(0x3498db)],
    });
  } catch (err) {
    console.warn('[partyfinder] Could not post party card:', err?.message || err);
    await interaction.reply({
      content: "Sorry — couldn't post the party right now. Please contact staff.",
      ephemeral: true,
    });
    return;
  }

  // Recruitment closes EXPIRY_LEAD_MINUTES_BEFORE_START minutes before the
  // chosen start time. startEpochSecs is known (threaded through the customIds).
  const expiryEpochSecs = startEpochSecs - EXPIRY_LEAD_MINUTES_BEFORE_START * 60;
  const startLabel = formatGmt7Label(startEpochSecs * 1000);

  const party = ps.createParty({
    partyId,
    leaderId: interaction.user.id,
    leaderName: displayName(interaction),
    leaderCategory: seatCategory, // first allowed category with a free slot
    eventName: pending.eventName,
    partySize,
    roleCounts,
    serverTime: startLabel,
    startEpochSecs,
    expiryEpochSecs,
    powerRating: pending.powerRating,
    messageId: sentMessage.id,
    channelId: channel.id,
  });

  await sentMessage.edit({
    embeds: [buildPartyEmbed(party)],
    components: buildPartyJoinComponents(partyId),
  });

  await interaction.reply({
    content: `✅ Party posted in <#${PARTY_FINDER_CHANNEL_ID}>.`,
    ephemeral: true,
  });

  scheduleExpiry(interaction.client, 'party', partyId, channel.id, sentMessage.id, expiryEpochSecs);
}

// Join as {category} button — CLASS-BASED eligibility (multi-role) + switching.
// A member must hold a recognized class role and may only join/switch to a
// category their class is allowed to fill (CLASS_ALLOWED_CATEGORIES). Switching
// between allowed categories is supported (e.g. Knight Tank<->DPS).
async function handleJoinButton(interaction, category, partyId) {
  const party = ps.getParty(partyId);
  if (party === null || party.closed) {
    await interaction.reply({ content: 'This party request has closed.', ephemeral: true });
    return;
  }

  if ((party.roleCounts[category] || 0) === 0) {
    await interaction.reply({
      content: `This party doesn't need a ${category} slot.`,
      ephemeral: true,
    });
    return;
  }

  // Class eligibility (multi-role).
  const { allowed, className } = getAllowedCategories(interaction);
  if (allowed.length === 0) {
    await interaction.reply({
      content:
        "You don't have a recognized class role, so you can't join. " +
        'Ask an officer to assign your class role.',
      ephemeral: true,
    });
    return;
  }
  if (!allowed.includes(category)) {
    await interaction.reply({
      content:
        `❌ Your class (${className}) can't apply as ${category}. ` +
        `You can apply as: ${allowed.join(' / ')}.`,
      ephemeral: true,
    });
    return;
  }

  const userId = interaction.user.id;
  const currentCat = ps.currentCategory(party, userId);

  // Already sitting in the target slot — nothing to do.
  if (currentCat === category) {
    await interaction.reply({ content: `You're already in the ${category} slot.`, ephemeral: true });
    return;
  }

  // Target slot full — refuse; the member keeps their current slot (if any).
  if (ps.categoryFull(party, category)) {
    await interaction.reply({
      content: `❌ The ${category} slot(s) are already full.`,
      ephemeral: true,
    });
    return;
  }

  if (currentCat !== null) {
    // Switch: vacate the old slot, take the new one.
    ps.removeMember(party, currentCat, userId);
    ps.addMember(party, category, userId, displayName(interaction));
    await interaction.reply({ content: `✅ Switched to ${category}!`, ephemeral: true });
  } else {
    // Fresh join.
    ps.addMember(party, category, userId, displayName(interaction));
    await interaction.reply({ content: `✅ You joined as ${category}!`, ephemeral: true });
  }

  // Update the public card.
  if (ps.isFull(party)) {
    party.closed = true;
    const fullEmbed = buildPartyEmbed(party, { open: false })
      .setColor(0x2ecc71) // green
      .setTitle(`✅ PARTY FULL: ${party.eventName}`);
    try {
      await interaction.message.edit({ embeds: [fullEmbed], components: [] });
    } catch (err) {
      console.warn('[partyfinder] Could not lock full party card:', err?.message || err);
    }

    // Ping every joined member (content mentions, so they actually notify).
    try {
      const memberIds = CATEGORIES.flatMap(cat => party.slots[cat].map(m => m.userId));
      const mentions = memberIds.map(id => `<@${id}>`).join(' ');
      const channel = interaction.message.channel;
      await channel.send({
        content:
          `🎉 Your party for **${party.eventName}** is organized! ${mentions} — ` +
          `start time is **${party.serverTime}, ${TIME_ZONE_DISPLAY}**. ` +
          `Please be on time, don't be late!`,
        allowedMentions: { users: memberIds },
      });
    } catch (err) {
      console.warn('[partyfinder] Could not send full-party ping:', err?.message || err);
    }

    ps.removeParty(partyId);
  } else {
    try {
      await interaction.message.edit({ embeds: [buildPartyEmbed(party)] });
    } catch (err) {
      console.warn('[partyfinder] Could not update party card:', err?.message || err);
    }
  }
}

// Cancel (Leader only).
async function handleCancelButton(interaction, partyId) {
  const party = ps.getParty(partyId);
  if (party === null || party.closed) {
    await interaction.reply({ content: 'Already closed.', ephemeral: true });
    return;
  }
  if (interaction.user.id !== party.leaderId) {
    await interaction.reply({
      content: 'Only the party leader can cancel this request.',
      ephemeral: true,
    });
    return;
  }

  party.closed = true;
  const embed = buildPartyEmbed(party, { open: false })
    .setTitle(`🚫 CANCELLED: ${party.eventName}`)
    .setColor(0x607d8b); // dark grey
  await interaction.update({ embeds: [embed], components: [] });
  ps.removeParty(partyId);
}

// ---------------------------------------------------------------------------
// I Need Carry flow
// ---------------------------------------------------------------------------

// Entry-card "I Need Carry" button -> gate, then GMT+7 start-time select.
// button->select (legal); the modal comes after the select (select->modal).
async function handleNeedCarryButton(interaction) {
  if (!hasPartyfinderRole(interaction)) {
    await interaction.reply({
      content: "Sorry — you don't have permission to use the Party Finder.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: `Pick the **start time** — ${TIME_ZONE_DISPLAY}:`,
    components: [buildTimeSelectRow(IDS.CARRY_TIME_SELECT)],
    ephemeral: true,
  });
}

// Carry time-select -> show the Carry Details modal (event name only). The
// chosen start epoch is baked into the modal customId (pf:carrydetails:<epoch>).
// select->modal is permitted; zero modal->modal in the carry flow.
async function handleCarryTimeSelect(interaction) {
  const startEpochSecs = parseInt(interaction.values[0], 10);

  const modal = new ModalBuilder()
    .setCustomId(`${IDS.CARRY_DETAILS}:${startEpochSecs}`)
    .setTitle('I Need Carry — Details');

  const event = new TextInputBuilder()
    .setCustomId(FIELDS.EVENT_NAME)
    .setLabel('Event name')
    .setPlaceholder('e.g. EDDGA MVP')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(event));

  await interaction.showModal(modal);
}

// Carry Details modal submit -> post the public carry card. startEpochSecs comes
// from the modal customId (chosen in the preceding time select).
async function handleCarryDetailsModal(interaction, startEpochSecs) {
  const eventName = interaction.fields.getTextInputValue(FIELDS.EVENT_NAME).trim();

  const requestId = ps.newId();

  let channel = null;
  try {
    channel = await interaction.client.channels.fetch(PARTY_FINDER_CHANNEL_ID);
  } catch (err) {
    console.warn('[partyfinder] Could not fetch party-finder channel:', err?.message || err);
  }
  if (!channel || typeof channel.send !== 'function') {
    console.warn(`[partyfinder] Party-finder channel ${PARTY_FINDER_CHANNEL_ID} missing or not sendable.`);
    await interaction.reply({
      content: "Sorry — couldn't post the carry request right now. Please contact staff.",
      ephemeral: true,
    });
    return;
  }

  let sentMessage;
  try {
    sentMessage = await channel.send({
      embeds: [new EmbedBuilder().setTitle('Creating carry request...').setColor(0x9b59b6)],
    });
  } catch (err) {
    console.warn('[partyfinder] Could not post carry card:', err?.message || err);
    await interaction.reply({
      content: "Sorry — couldn't post the carry request right now. Please contact staff.",
      ephemeral: true,
    });
    return;
  }

  // Recruitment closes EXPIRY_LEAD_MINUTES_BEFORE_START minutes before start.
  const expiryEpochSecs = startEpochSecs - EXPIRY_LEAD_MINUTES_BEFORE_START * 60;
  const startLabel = formatGmt7Label(startEpochSecs * 1000);

  const req = ps.createCarryRequest({
    requestId,
    leaderId: interaction.user.id,
    leaderName: displayName(interaction),
    eventName,
    serverTime: startLabel,
    startEpochSecs,
    expiryEpochSecs,
    messageId: sentMessage.id,
    channelId: channel.id,
  });

  await sentMessage.edit({
    embeds: [buildCarryEmbed(req)],
    components: buildCarryComponents(requestId),
  });

  await interaction.reply({
    content: `✅ Carry request posted in <#${PARTY_FINDER_CHANNEL_ID}>.`,
    ephemeral: true,
  });

  scheduleExpiry(interaction.client, 'carry', requestId, channel.id, sentMessage.id, expiryEpochSecs);
}

// "I'll carry this" — gate to Carry role, dedupe, append responder, edit embed.
async function handleCarryRespondButton(interaction, requestId) {
  const req = ps.getCarryRequest(requestId);
  if (req === null || req.closed) {
    await interaction.reply({ content: 'This request has closed.', ephemeral: true });
    return;
  }

  if (!hasCarryRole(interaction)) {
    await interaction.reply({
      content: '❌ Only members with the Carry role can respond to carry requests.',
      ephemeral: true,
    });
    return;
  }

  if (ps.hasResponded(req, interaction.user.id)) {
    await interaction.reply({ content: "You've already responded.", ephemeral: true });
    return;
  }

  ps.addResponder(req, interaction.user.id, displayName(interaction));
  await interaction.reply({ content: "✅ You've offered to carry — thank you!", ephemeral: true });

  try {
    await interaction.message.edit({ embeds: [buildCarryEmbed(req)] });
  } catch (err) {
    console.warn('[partyfinder] Could not update carry card:', err?.message || err);
  }
}

// Cancel (Requester only).
async function handleCarryCancelButton(interaction, requestId) {
  const req = ps.getCarryRequest(requestId);
  if (req === null || req.closed) {
    await interaction.reply({ content: 'Already closed.', ephemeral: true });
    return;
  }
  if (interaction.user.id !== req.leaderId) {
    await interaction.reply({ content: 'Only the requester can cancel this.', ephemeral: true });
    return;
  }

  req.closed = true;
  const embed = buildCarryEmbed(req, { open: false })
    .setTitle(`🚫 CANCELLED: ${req.eventName}`)
    .setColor(0x607d8b);
  await interaction.update({ embeds: [embed], components: [] });
  ps.removeCarryRequest(requestId);
}

// ---------------------------------------------------------------------------
// Auto-expiry — fires AT expiryEpochSecs (15 min before the chosen start time).
// If still open, BOTH party and carry KEEP the message and edit it to a grey
// closed state (countdown dropped, buttons removed). Build the closed embed from
// the still-present item BEFORE dropping state. Delay is clamped to >= 0 (guards
// the should-not-happen case where expiry is already past). setTimeout-based;
// max start is ~6h out, well under the ceiling; timers don't survive restart (v1).
// ---------------------------------------------------------------------------
function scheduleExpiry(client, kind, id, channelId, messageId, expiryEpochSecs) {
  const delayMs = Math.max(0, expiryEpochSecs * 1000 - Date.now());
  setTimeout(async () => {
    const item = kind === 'party' ? ps.getParty(id) : ps.getCarryRequest(id);
    if (item === null || item.closed) return; // already filled or cancelled

    let closedEmbed;
    if (kind === 'party') {
      // open:false omits the live countdown; append a static "Recruitment
      // closed" line as the last field to make the closed state explicit.
      closedEmbed = buildPartyEmbed(item, { open: false })
        .setTitle(`⌛ Recruitment Closed: ${item.eventName}`)
        .setColor(0x607d8b) // grey
        .addFields({ name: '⏳ Recruitment closes', value: 'Recruitment closed', inline: false });
      item.closed = true;
      ps.removeParty(id);
    } else {
      closedEmbed = buildCarryEmbed(item, { open: false })
        .setTitle(`⌛ Carry Request Closed: ${item.eventName}`)
        .setColor(0x607d8b) // grey
        .addFields({ name: '⏳ Request closes', value: 'Request closed', inline: false });
      item.closed = true;
      ps.removeCarryRequest(id);
    }

    try {
      const channel = await client.channels.fetch(channelId);
      const message = await channel.messages.fetch(messageId);
      await message.edit({ embeds: [closedEmbed], components: [] });
    } catch (err) {
      console.warn(`[partyfinder] Expiry close-edit failed for ${kind} ${id}:`, err?.message || err);
    }
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Router — called from events/interactionCreate.js. Returns true if it handled
// the interaction (so the officerapp / guildapp routers are skipped).
// ---------------------------------------------------------------------------
async function route(interaction) {
  // Buttons
  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id === IDS.ENTRY_START) {
      await handleStartPartyButton(interaction);
      return true;
    }
    if (id === IDS.ENTRY_CARRY) {
      await handleNeedCarryButton(interaction);
      return true;
    }
    if (id.startsWith(`${IDS.ROLES_OPEN_PREFIX}:`)) {
      // pf:rolesopen:<size>:<leaderCategory>:<startEpochSecs>  (bridge -> Roles modal)
      const parts = id.split(':');
      await handleRolesOpenButton(interaction, parseInt(parts[2], 10), parts[3], parseInt(parts[4], 10));
      return true;
    }
    if (id.startsWith(`${IDS.JOIN_PREFIX}:`)) {
      // pf:join:<category>:<partyId>
      const parts = id.split(':');
      await handleJoinButton(interaction, parts[2], parts[3]);
      return true;
    }
    if (id.startsWith(`${IDS.CANCEL_PREFIX}:`)) {
      // pf:cancel:<partyId>
      await handleCancelButton(interaction, id.split(':')[2]);
      return true;
    }
    if (id.startsWith(`${IDS.CARRY_RESPOND_PREFIX}:`)) {
      // pf:carryrespond:<reqId>
      await handleCarryRespondButton(interaction, id.split(':')[2]);
      return true;
    }
    if (id.startsWith(`${IDS.CARRY_CANCEL_PREFIX}:`)) {
      // pf:carrycancel:<reqId>
      await handleCarryCancelButton(interaction, id.split(':')[2]);
      return true;
    }
    return false;
  }

  // Select menus
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === IDS.SIZE_SELECT) {
      await handleSizeSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith(`${IDS.TIME_SELECT}:`)) {
      // pf:time:<sizeToken>
      const token = interaction.customId.split(':')[2];
      const sizeToken = token === 'custom' ? 'custom' : parseInt(token, 10);
      await handleTimeSelect(interaction, sizeToken);
      return true;
    }
    if (interaction.customId === IDS.CARRY_TIME_SELECT) {
      // pf:carrytime  (GMT+7 start-time select for the carry flow)
      await handleCarryTimeSelect(interaction);
      return true;
    }
    return false;
  }

  // Modal submits
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;

    if (id.startsWith(`${IDS.DETAILS_PREFIX}:`)) {
      // pf:details:<sizeToken>:<startEpochSecs>  — sizeToken is 'custom' or a number.
      const parts = id.split(':');
      const sizeToken = parts[2] === 'custom' ? 'custom' : parseInt(parts[2], 10);
      const startEpochSecs = parseInt(parts[3], 10);
      await handlePartyDetailsModal(interaction, sizeToken, startEpochSecs);
      return true;
    }
    if (id.startsWith(`${IDS.ROLES_PREFIX}:`)) {
      // pf:roles:<size>:<leaderCategory>:<startEpochSecs>
      const parts = id.split(':');
      await handleRolesModal(interaction, parseInt(parts[2], 10), parts[3], parseInt(parts[4], 10));
      return true;
    }
    if (id.startsWith(`${IDS.CARRY_DETAILS}:`)) {
      // pf:carrydetails:<startEpochSecs>
      const startEpochSecs = parseInt(id.split(':')[2], 10);
      await handleCarryDetailsModal(interaction, startEpochSecs);
      return true;
    }
    return false;
  }

  return false;
}

module.exports = {
  route,
  buildEntryEmbed,
  buildEntryComponents,
  hasPartyfinderRole,
  // Exported for testing the GMT+7 slot generator / label formatter + embeds + expiry scheduling.
  generateTimeSlots,
  formatGmt7Label,
  buildPartyEmbed,
  buildCarryEmbed,
  scheduleExpiry,
};
