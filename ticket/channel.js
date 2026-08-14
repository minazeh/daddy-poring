// ---------------------------------------------------------------------------
// Private ticket-channel lifecycle: create -> lock -> delete.
//
// PRIVACY IS ENFORCED ON THE CHANNEL, EXPLICITLY, AND ATOMICALLY.
// Two things that guards against:
//   1. A channel created and THEN locked down is briefly visible to the whole
//      server. Passing permissionOverwrites to guild.channels.create() means
//      the channel never exists in a readable state — there is no window.
//   2. The overwrites are EXPLICIT, not inherited. A new channel normally syncs
//      its parent category's permissions, so if that category were ever opened
//      up to a role, every ticket inside it would open up with it. Writing an
//      explicit @everyone deny plus an explicit allow-list makes each ticket's
//      privacy independent of whatever the category is set to.
// ---------------------------------------------------------------------------

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const {
  TICKET_OFFICER_ROLE_IDS,
  CHANNELS,
  CATEGORY_CHILD_LIMIT,
} = require('./constants');

// What the creator and the officer roles get inside a ticket channel.
const MEMBER_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
];

// Discord channel names: lowercase, no spaces, 100 chars. Anything outside
// [a-z0-9-] is dropped rather than transliterated — the ticket number carries
// the identity, so a name that degrades to `ticket-0042-` is still unique and
// still correct.
function sanitiseForChannelName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function ticketChannelName(ticket) {
  const num = String(ticket.number).padStart(4, '0');
  const who = sanitiseForChannelName(ticket.username || ticket.displayName);
  return who ? `ticket-${num}-${who}` : `ticket-${num}`;
}

// ---------------------------------------------------------------------------
// Category capacity. Checked BEFORE creating so a full category produces a
// specific, actionable message instead of an opaque Discord API error.
// Returns { ok: true } or { ok: false, reason: '...' }.
// ---------------------------------------------------------------------------
async function checkCategoryCapacity(guild) {
  try {
    const category = await guild.channels.fetch(CHANNELS.CATEGORY);
    if (!category || category.type !== ChannelType.GuildCategory) {
      return { ok: false, reason: `Ticket category \`${CHANNELS.CATEGORY}\` was not found, or is not a category.` };
    }
    const children = guild.channels.cache.filter(c => c.parentId === CHANNELS.CATEGORY).size;
    if (children >= CATEGORY_CHILD_LIMIT) {
      return {
        ok: false,
        reason:
          `The ticket category is full (${children}/${CATEGORY_CHILD_LIMIT} channels — Discord's hard cap). ` +
          'Resolve and clear some existing tickets before accepting new ones.',
      };
    }
    return { ok: true, category };
  } catch (err) {
    return { ok: false, reason: `Could not read the ticket category: ${err?.message || err}` };
  }
}

// ---------------------------------------------------------------------------
// Create the private channel for a ticket.
// Throws on failure — the caller releases the claim and reports specifically.
// ---------------------------------------------------------------------------
async function createTicketChannel(guild, ticket) {
  const overwrites = [
    // Everyone else: invisible. This is the whole privacy model.
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    // The ticket creator.
    {
      id: ticket.userId,
      allow: MEMBER_ALLOW,
    },
    // Every officer role — all seven can see and act on every ticket.
    ...TICKET_OFFICER_ROLE_IDS.map(roleId => ({
      id: roleId,
      allow: MEMBER_ALLOW,
    })),
    // The bot itself, plus what it needs to manage the channel afterwards.
    {
      id: guild.members.me.id,
      allow: [
        ...MEMBER_ALLOW,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
    },
  ];

  return guild.channels.create({
    name: ticketChannelName(ticket),
    type: ChannelType.GuildText,
    parent: CHANNELS.CATEGORY,
    topic: `Ticket #${String(ticket.number).padStart(4, '0')} — ${ticket.subject}`.slice(0, 1024),
    permissionOverwrites: overwrites,   // atomic: never visible before this applies
    reason: `Support ticket ${ticket._id} accepted`,
  });
}

// ---------------------------------------------------------------------------
// Lock a resolved ticket: the creator loses SendMessages but keeps read access
// during the grace period, officers keep full access. Renamed so the channel
// list reads at a glance.
//
// Best-effort throughout — a resolved ticket whose channel could not be renamed
// is a cosmetic problem, and the transcript is already saved by this point.
// ---------------------------------------------------------------------------
async function lockTicketChannel(channel, ticket) {
  try {
    await channel.permissionOverwrites.edit(
      ticket.userId,
      { SendMessages: false },
      { reason: `Ticket ${ticket._id} resolved` },
    );
  } catch (err) {
    console.warn(`[ticket/channel] Could not revoke SendMessages on ${channel.id}:`, err?.message || err);
  }

  try {
    const num = String(ticket.number).padStart(4, '0');
    const who = sanitiseForChannelName(ticket.username || ticket.displayName);
    await channel.setName(who ? `closed-${num}-${who}` : `closed-${num}`,
      `Ticket ${ticket._id} resolved`);
  } catch (err) {
    console.warn(`[ticket/channel] Could not rename ${channel.id}:`, err?.message || err);
  }
}

// Best-effort delete. Every failure mode (already gone, no access) is non-fatal.
// Returns true if the channel is gone afterwards, one way or another.
async function deleteTicketChannel(client, channelId, reason) {
  if (!channelId) return true;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return true;
    await channel.delete(reason);
    return true;
  } catch (err) {
    const code = err?.code;
    // 10003 Unknown Channel — already gone, which is the desired end state.
    if (code === 10003) return true;
    console.warn(`[ticket/channel] Could not delete ${channelId}:`, err?.message || err);
    return false;
  }
}

module.exports = {
  ticketChannelName,
  sanitiseForChannelName,
  checkCategoryCapacity,
  createTicketChannel,
  lockTicketChannel,
  deleteTicketChannel,
  MEMBER_ALLOW,
};
