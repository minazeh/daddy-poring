// ---------------------------------------------------------------------------
// Guild support ticket — interaction handlers + router.
//
// Flow:
//   ticket:open                  -> the Subject/Message modal
//   ticket:modal                 -> create the record, post the officer embed
//   ticket:accept:<id>           -> private channel + sticky
//   ticket:decline:<id>          -> reason modal
//   ticket:declinemodal:<id>     -> close without a channel, DM the member
//   ticket:resolve:<id>          -> transcript -> notice -> lock -> schedule delete
//
// RESTART SAFETY: every customId above except the first carries the ticket id,
// so a process that has never seen the ticket reconstructs everything it needs
// from Mongo on the click. There is no in-memory interaction state anywhere in
// this file.
// ---------------------------------------------------------------------------

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  MessageFlags,
} = require('discord.js');

const db = require('./db');
const sticky = require('./sticky');
const channelOps = require('./channel');
const transcript = require('./transcript');
const {
  IDS,
  FIELDS,
  TICKET_OFFICER_ROLE_IDS,
  CHANNELS,
  COLORS,
  EMBED_FIELD_LIMIT,
  SUBJECT_MAX,
  MESSAGE_MAX,
  DECLINE_REASON_MAX,
  DELETE_GRACE_MS,
  DM,
} = require('./constants');

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function isOfficer(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return TICKET_OFFICER_ROLE_IDS.some(roleId => member.roles?.cache?.has?.(roleId));
}

// Neutralise anything that would let a ticket body ping the officer channel.
// Zero-width space after the @ kills the mention without mangling the text.
function defuseMentions(text) {
  return String(text || '').replace(/@(everyone|here|&\d+|!?\d+)/g, '@​$1');
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// Render every role the member holds, highest first, @everyone excluded.
//
// AN EMBED FIELD CAPS AT 1024 CHARS and a long-standing member's role list will
// exceed it. Over-length makes Discord reject the WHOLE message, so the ticket
// would silently never appear. Truncate at the last whole role that fits.
function renderRoles(roles) {
  if (!roles.length) return '—';
  const parts = [];
  let used = 0;
  let dropped = 0;

  for (const role of roles) {
    const piece = `<@&${role.id}>`;
    const cost = piece.length + (parts.length ? 1 : 0);
    // Reserve room for the " +N more" suffix.
    if (used + cost > EMBED_FIELD_LIMIT - 16) {
      dropped++;
      continue;
    }
    parts.push(piece);
    used += cost;
  }

  if (!parts.length) return `${roles.length} role(s)`;
  return dropped ? `${parts.join(' ')} +${dropped} more` : parts.join(' ');
}

// Snapshot of the member's roles at submit time, highest position first.
function snapshotRoles(member) {
  if (!member?.roles?.cache) return [];
  return [...member.roles.cache.values()]
    .filter(r => r.id !== member.guild.id)   // drop @everyone
    .sort((a, b) => b.position - a.position)
    .map(r => ({ id: r.id, name: r.name }));
}

function ts(date) {
  if (!date) return '—';
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:F> (<t:${Math.floor(new Date(date).getTime() / 1000)}:R>)`;
}

// ---------------------------------------------------------------------------
// The officer-facing ticket embed.
// ---------------------------------------------------------------------------
function buildTicketEmbed(ticket, { status, color, extraFields = [] } = {}) {
  const num = String(ticket.number).padStart(4, '0');
  return new EmbedBuilder()
    .setTitle(`🎫 Support Ticket #${num}`)
    .setColor(color ?? COLORS.OPEN)
    .setDescription(`From ${`<@${ticket.userId}>`} (${ticket.username})`)
    .addFields(
      { name: 'Member',           value: `${ticket.displayName}\n\`${ticket.userId}\``, inline: true },
      { name: 'Joined server',    value: ts(ticket.joinedAt),          inline: true },
      { name: 'Account created',  value: ts(ticket.accountCreatedAt),  inline: true },
      { name: 'Roles',            value: renderRoles(ticket.rolesSnapshot || []), inline: false },
      { name: '​',                value: '────────────────────',       inline: false },
      { name: 'Subject',          value: defuseMentions(ticket.subject).slice(0, 1024) || '—', inline: false },
      { name: 'Message',          value: defuseMentions(ticket.message).slice(0, 1024) || '—', inline: false },
      { name: 'Status',           value: status ?? '🟡 Open',          inline: false },
      ...extraFields,
    )
    .setTimestamp(new Date(ticket.createdAt));
}

function buildReviewButtons(ticketId, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.ACCEPT}:${ticketId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${IDS.DECLINE}:${ticketId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

// ---------------------------------------------------------------------------
// 1. Open Ticket button -> the modal.
// ---------------------------------------------------------------------------
async function handleOpenButton(interaction) {
  if (!db.isReady()) {
    await interaction.reply(ephemeral(
      "The ticket system isn't available right now — please try again shortly, or ping an officer directly.",
    ));
    return;
  }

  // One open ticket per member. Checked BEFORE showing the modal so nobody
  // types out a message only to be refused on submit.
  const existing = await db.findActiveTicketForUser(interaction.user.id);
  if (existing) {
    const where = existing.channelId
      ? ` Your ticket channel: <#${existing.channelId}>`
      : ' An officer will pick it up shortly.';
    await interaction.reply(ephemeral(
      `You already have an open ticket (**#${String(existing.number).padStart(4, '0')} — ${existing.subject}**).${where}`,
    ));
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(IDS.MODAL)
    .setTitle('Open a Support Ticket');

  const subject = new LabelBuilder()
    .setLabel('Subject')
    .setDescription('A short summary of what this is about.')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId(FIELDS.SUBJECT)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Missing GvG attendance credit')
        .setMaxLength(SUBJECT_MAX)
        .setRequired(true),
    );

  const message = new LabelBuilder()
    .setLabel('Message')
    .setDescription('What happened, when, and what you need.')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId(FIELDS.MESSAGE)
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Give us the details so we can help properly.')
        .setMaxLength(MESSAGE_MAX)
        .setRequired(true),
    );

  modal.addLabelComponents(subject, message);
  await interaction.showModal(modal);
}

// ---------------------------------------------------------------------------
// 2. Modal submit -> record, then officer embed.
//
// ORDER MATTERS: the Mongo write happens FIRST, the post SECOND, the message-id
// record THIRD. A crash between any two leaves a recoverable ticket, never a
// phantom embed with no record behind it.
// ---------------------------------------------------------------------------
async function handleModalSubmit(interaction) {
  if (!db.isReady()) {
    await interaction.reply(ephemeral("The ticket system isn't available right now — please try again shortly."));
    return;
  }

  const subject = interaction.fields.getTextInputValue(FIELDS.SUBJECT).trim();
  const message = interaction.fields.getTextInputValue(FIELDS.MESSAGE).trim();

  // Re-check the guard — a member could have opened the modal, waited, and
  // opened a second one in another client before submitting.
  const existing = await db.findActiveTicketForUser(interaction.user.id);
  if (existing) {
    await interaction.reply(ephemeral(
      `You already have an open ticket (**#${String(existing.number).padStart(4, '0')}**). ` +
      'Please use that one.',
    ));
    return;
  }

  const member = interaction.member;
  const ticket = await db.createTicket({
    guildId:          interaction.guildId,
    userId:           interaction.user.id,
    username:         interaction.user.tag ?? interaction.user.username,
    displayName:      member?.displayName ?? interaction.user.username,
    rolesSnapshot:    snapshotRoles(member),
    joinedAt:         member?.joinedAt ?? null,
    accountCreatedAt: interaction.user.createdAt ?? null,
    subject,
    message,
  });

  if (!ticket) {
    await interaction.reply(ephemeral("Couldn't record your ticket — please try again in a moment."));
    return;
  }

  try {
    const officerChannel = await interaction.client.channels.fetch(CHANNELS.OPEN_TICKETS);
    const posted = await officerChannel.send({
      embeds: [buildTicketEmbed(ticket)],
      components: [buildReviewButtons(ticket._id)],
    });
    await db.setReviewMessage(ticket._id, officerChannel.id, posted.id);
  } catch (err) {
    console.warn('[ticket] Could not post the officer embed:', err?.message || err);
    await interaction.reply(ephemeral(
      'Your ticket was recorded, but it could not be posted to the officer channel. ' +
      'Please let an officer know directly.',
    ));
    return;
  }

  await interaction.reply(ephemeral(
    `✅ Ticket **#${String(ticket.number).padStart(4, '0')}** submitted. ` +
    'An officer will pick it up and open a private channel with you — you\'ll get a DM when they do.',
  ));
}

// ---------------------------------------------------------------------------
// 3. Accept -> private channel + sticky.
// ---------------------------------------------------------------------------
async function handleAccept(interaction, ticketId) {
  if (!isOfficer(interaction)) {
    await interaction.reply(ephemeral("You don't have permission to action support tickets."));
    return;
  }
  if (!db.isReady()) {
    await interaction.reply(ephemeral("The ticket store isn't available right now — try again shortly."));
    return;
  }

  const ticket = await db.getTicket(ticketId);
  if (!ticket) {
    await interaction.reply(ephemeral('That ticket no longer exists.'));
    return;
  }
  if (ticket.status !== 'open') {
    await interaction.reply(ephemeral(
      `That ticket is already **${ticket.status}**` +
      (ticket.acceptedBy ? ` (actioned by <@${ticket.acceptedBy}>).` : '.'),
    ));
    return;
  }

  // Capacity first — a full category is the one predictable hard failure.
  const capacity = await channelOps.checkCategoryCapacity(interaction.guild);
  if (!capacity.ok) {
    await interaction.reply(ephemeral(`Couldn't create the ticket channel. ${capacity.reason}`));
    return;
  }

  // Atomic claim: two officers clicking at the same instant, only one wins.
  const claimed = await db.claimForAccept(ticketId, interaction.user.id);
  if (!claimed) {
    const fresh = await db.getTicket(ticketId);
    await interaction.reply(ephemeral(
      `Already actioned${fresh?.acceptedBy ? ` by <@${fresh.acceptedBy}>` : ''} — nothing to do.`,
    ));
    return;
  }

  await interaction.deferUpdate();

  let channel;
  try {
    channel = await channelOps.createTicketChannel(interaction.guild, ticket);
    await db.setChannel(ticketId, channel.id);
  } catch (err) {
    // Release the claim so the buttons stay live — never wedge in 'accepted'
    // with no channel behind it.
    await db.releaseClaim(ticketId);
    console.warn(`[ticket] Channel creation failed for ${ticketId}:`, err?.message || err);
    await interaction.followUp(ephemeral(
      `Couldn't create the ticket channel: ${err?.message || err}\n` +
      'The ticket has been returned to Open — the buttons are still live.',
    ));
    return;
  }

  // Header card so the context lives in the channel, not just in the officer
  // channel the member cannot see.
  try {
    const header = new EmbedBuilder()
      .setTitle(`🎫 Ticket #${String(ticket.number).padStart(4, '0')}`)
      .setColor(COLORS.ACCEPTED)
      .setDescription(
        `Opened by <@${ticket.userId}> — picked up by <@${interaction.user.id}>.`,
      )
      .addFields(
        { name: 'Subject', value: defuseMentions(ticket.subject).slice(0, 1024) || '—', inline: false },
        { name: 'Message', value: defuseMentions(ticket.message).slice(0, 1024) || '—', inline: false },
      )
      .setTimestamp(new Date(ticket.createdAt));

    await channel.send({
      content: `<@${ticket.userId}>`,
      embeds: [header],
      allowedMentions: { users: [ticket.userId] },
    });
  } catch (err) {
    console.warn(`[ticket] Could not post the header card in ${channel.id}:`, err?.message || err);
  }

  // Sticky last, so it is the newest message in the channel.
  try {
    await sticky.start(channel, ticketId);
  } catch (err) {
    console.warn(`[ticket] Could not post the sticky in ${channel.id}:`, err?.message || err);
    try {
      await interaction.followUp(ephemeral(
        'Channel created, but the resolve sticky failed to post. It will appear on the next message in there.',
      ));
    } catch { /* ignore */ }
  }

  // Update the officer embed.
  try {
    const updated = await db.getTicket(ticketId);
    const embed = buildTicketEmbed(updated, {
      status: '🟢 Accepted',
      color: COLORS.ACCEPTED,
      extraFields: [{ name: 'Accepted by', value: `<@${interaction.user.id}>`, inline: false }],
    });
    const linkRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Go to ticket')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${interaction.guildId}/${channel.id}`),
    );
    await interaction.message.edit({ embeds: [embed], components: [linkRow] });
  } catch (err) {
    console.warn(`[ticket] Could not update the officer embed for ${ticketId}:`, err?.message || err);
  }

  // Best-effort DM — never crash if DMs are closed.
  try {
    const user = await interaction.client.users.fetch(ticket.userId);
    await user.send(DM.accepted(`<#${channel.id}>`));
  } catch (err) {
    console.warn(`[ticket] Could not DM ${ticket.userId}:`, err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// 4. Decline -> reason modal -> close without a channel.
// ---------------------------------------------------------------------------
async function handleDeclineButton(interaction, ticketId) {
  if (!isOfficer(interaction)) {
    await interaction.reply(ephemeral("You don't have permission to action support tickets."));
    return;
  }

  const ticket = await db.getTicket(ticketId);
  if (!ticket) {
    await interaction.reply(ephemeral('That ticket no longer exists.'));
    return;
  }
  if (ticket.status !== 'open') {
    await interaction.reply(ephemeral(`That ticket is already **${ticket.status}**.`));
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${IDS.DECLINE_MODAL}:${ticketId}`)
    .setTitle(`Decline Ticket #${String(ticket.number).padStart(4, '0')}`);

  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel('Reason (sent to the member)')
      .setDescription('Optional, but it saves a follow-up question.')
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(FIELDS.DECLINE_REASON)
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('e.g. Already handled in #guild-chat — nothing outstanding.')
          .setMaxLength(DECLINE_REASON_MAX)
          .setRequired(false),
      ),
  );

  await interaction.showModal(modal);
}

async function handleDeclineModal(interaction, ticketId) {
  const reason = (interaction.fields.getTextInputValue(FIELDS.DECLINE_REASON) || '').trim();

  const claimed = await db.claimForDecline(ticketId, interaction.user.id, reason);
  if (!claimed) {
    const fresh = await db.getTicket(ticketId);
    await interaction.reply(ephemeral(`That ticket is already **${fresh?.status ?? 'gone'}** — nothing to do.`));
    return;
  }

  const ticket = await db.getTicket(ticketId);

  // Update the officer embed in place.
  try {
    const embed = buildTicketEmbed(ticket, {
      status: '❌ Declined',
      color: COLORS.DECLINED,
      extraFields: [
        { name: 'Declined by', value: `<@${interaction.user.id}>`, inline: false },
        ...(reason ? [{ name: 'Reason', value: reason.slice(0, 1024), inline: false }] : []),
      ],
    });
    const channel = await interaction.client.channels.fetch(ticket.reviewChannelId);
    const msg = await channel.messages.fetch(ticket.reviewMessageId);
    await msg.edit({ embeds: [embed], components: [buildReviewButtons(ticketId, { disabled: true })] });
  } catch (err) {
    console.warn(`[ticket] Could not update the declined embed for ${ticketId}:`, err?.message || err);
  }

  try {
    const user = await interaction.client.users.fetch(ticket.userId);
    await user.send(DM.declined(reason));
  } catch (err) {
    console.warn(`[ticket] Could not DM ${ticket.userId} about the decline:`, err?.message || err);
  }

  await interaction.reply(ephemeral(`Ticket #${String(ticket.number).padStart(4, '0')} declined.`));
}

// ---------------------------------------------------------------------------
// 5. Resolve -> transcript -> notice -> lock -> schedule delete.
//
// THE TRANSCRIPT IS POSTED BEFORE THE CHANNEL IS TOUCHED. If it fails, the
// channel is left completely intact and the officer is told — a lost
// conversation is unrecoverable, a stuck channel is a nuisance.
// ---------------------------------------------------------------------------
async function handleResolve(interaction, ticketId) {
  if (!isOfficer(interaction)) {
    await interaction.reply(ephemeral('Only officers can mark a ticket resolved.'));
    return;
  }
  if (!db.isReady()) {
    await interaction.reply(ephemeral("The ticket store isn't available right now — try again shortly."));
    return;
  }

  const ticket = await db.getTicket(ticketId);
  if (!ticket) {
    await interaction.reply(ephemeral('That ticket no longer exists.'));
    return;
  }
  if (ticket.status !== 'accepted') {
    await interaction.reply(ephemeral(`That ticket is already **${ticket.status}** — nothing to do.`));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.channel;
  const resolverName = interaction.member?.displayName ?? interaction.user.tag;

  // Transcript FIRST. Nothing destructive happens before this succeeds.
  let transcriptMsg;
  try {
    transcriptMsg = await transcript.postTranscript(interaction.client, channel, ticket, resolverName);
  } catch (err) {
    console.warn(`[ticket] Transcript failed for ${ticketId}:`, err?.message || err);
    await interaction.editReply(
      `❌ Couldn't save the transcript: ${err?.message || err}\n\n` +
      '**The ticket has NOT been closed and this channel is untouched** — nothing has been lost. ' +
      'Try again, or get the transcript channel fixed first.',
    );
    return;
  }

  // Only now is it safe to transition.
  const claimed = await db.claimForResolve(
    ticketId,
    interaction.user.id,
    new Date(Date.now() + DELETE_GRACE_MS),
  );
  if (!claimed) {
    await interaction.editReply('Someone else resolved this ticket a moment ago — the transcript was still saved.');
    return;
  }

  await db.setTranscriptMessageId(ticketId, transcriptMsg.id);

  // Replace the sticky with the terminal notice and stop watching the channel.
  try {
    await sticky.finish(channel, ticket, resolverName);
  } catch (err) {
    console.warn(`[ticket] Could not finish the sticky for ${ticketId}:`, err?.message || err);
  }

  // Lock + rename. Best-effort — cosmetic at this point.
  await channelOps.lockTicketChannel(channel, ticket);

  // Update the officer embed.
  try {
    const updated = await db.getTicket(ticketId);
    const embed = buildTicketEmbed(updated, {
      status: '🔵 Resolved',
      color: COLORS.RESOLVED,
      extraFields: [
        { name: 'Accepted by', value: updated.acceptedBy ? `<@${updated.acceptedBy}>` : '—', inline: true },
        { name: 'Resolved by', value: `<@${interaction.user.id}>`, inline: true },
      ],
    });
    const reviewChannel = await interaction.client.channels.fetch(updated.reviewChannelId);
    const msg = await reviewChannel.messages.fetch(updated.reviewMessageId);
    await msg.edit({ embeds: [embed], components: [] });
  } catch (err) {
    console.warn(`[ticket] Could not update the resolved embed for ${ticketId}:`, err?.message || err);
  }

  try {
    const user = await interaction.client.users.fetch(ticket.userId);
    await user.send(DM.resolved());
  } catch (err) {
    console.warn(`[ticket] Could not DM ${ticket.userId} about the resolution:`, err?.message || err);
  }

  const hours = Math.round(DELETE_GRACE_MS / 3_600_000);
  await interaction.editReply(
    `✅ Ticket #${String(ticket.number).padStart(4, '0')} resolved. ` +
    `Transcript saved to <#${CHANNELS.TRANSCRIPTS}>. ` +
    `This channel is now read-only for the member and will be deleted in about ${hours}h.`,
  );
}

// ---------------------------------------------------------------------------
// Router — called from events/interactionCreate.js. Returns true if it owned
// the interaction.
// ---------------------------------------------------------------------------
async function route(interaction) {
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (!id.startsWith('ticket:')) return false;

    if (id === IDS.OPEN_BUTTON) {
      await handleOpenButton(interaction);
      return true;
    }
    if (id.startsWith(`${IDS.ACCEPT}:`)) {
      await handleAccept(interaction, id.slice(IDS.ACCEPT.length + 1));
      return true;
    }
    if (id.startsWith(`${IDS.DECLINE}:`)) {
      await handleDeclineButton(interaction, id.slice(IDS.DECLINE.length + 1));
      return true;
    }
    if (id.startsWith(`${IDS.RESOLVE}:`)) {
      await handleResolve(interaction, id.slice(IDS.RESOLVE.length + 1));
      return true;
    }
    return false;
  }

  if (interaction.isModalSubmit()) {
    const id = interaction.customId;
    if (id === IDS.MODAL) {
      await handleModalSubmit(interaction);
      return true;
    }
    if (id.startsWith(`${IDS.DECLINE_MODAL}:`)) {
      await handleDeclineModal(interaction, id.slice(IDS.DECLINE_MODAL.length + 1));
      return true;
    }
    return false;
  }

  return false;
}

module.exports = {
  route,
  // exported for the command + tests
  buildTicketEmbed,
  buildReviewButtons,
  renderRoles,
  defuseMentions,
  snapshotRoles,
  isOfficer,
};
