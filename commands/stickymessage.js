// ---------------------------------------------------------------------------
// /stickymessage — general-purpose sticky messages (Godfathers + officers).
//
//   /stickymessage set     — opens the modal; sticks the result to THIS channel
//   /stickymessage edit    — reopens the modal PRE-FILLED with the current
//                            content, for the sticky in this channel
//   /stickymessage remove  — takes the sticky down and stops watching
//   /stickymessage list    — every active sticky in the server
//
// `set` in a channel that already has one REPLACES it, and the ephemeral
// confirmation says so.
//
// Spec: docs/STICKY_MESSAGE_SPEC.md
// ---------------------------------------------------------------------------

const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const db = require('../sticky/db');
const engine = require('../sticky/engine');
const handlers = require('../sticky/handlers');
const {
  MODES,
  LIST_PREVIEW_CHARS,
  LIST_CONTENT_MAX,
  COPY,
} = require('../sticky/constants');

const ephemeral = (content) => ({
  content,
  flags: MessageFlags.Ephemeral,
  // Nothing this command echoes back — officer names, sticky previews — should
  // ever ping anybody.
  allowedMentions: { parse: [] },
});

// Threads, forums, DMs and voice-text are out of scope (spec §10). Only the two
// channel types a sticky makes sense in.
const ALLOWED_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

function isSupportedChannel(channel) {
  return Boolean(channel) && ALLOWED_CHANNEL_TYPES.has(channel.type) && !channel.isThread?.();
}

// Can the bot actually post here? Checked BEFORE the modal is shown, so the
// officer is told now rather than after typing 4,000 characters.
function botCanPost(interaction, channel) {
  const me = interaction.guild?.members?.me;
  if (!me || typeof channel.permissionsFor !== 'function') return true; // unknown — let the send decide
  const perms = channel.permissionsFor(me);
  if (!perms) return true;
  return perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.SendMessages);
}

// One line of /stickymessage list. The PREVIEW is truncated — the posted sticky
// never is.
function renderListRow(doc) {
  const fmt = engine.formatFor(doc);
  const shape = fmt.mode === 'plain'
    ? 'plain text'
    : (fmt.promoted ? 'embed (over 2,000 chars)' : `embed — "${String(doc.title).slice(0, 60)}"`);

  const flat = String(doc.content ?? '').replace(/\s+/g, ' ').trim();
  const preview = flat.length > LIST_PREVIEW_CHARS
    ? `${flat.slice(0, LIST_PREVIEW_CHARS)}…`
    : flat;

  return `• <#${doc._id}> — ${shape}, set by **${doc.setByName || doc.setBy}**\n  ${preview}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stickymessage')
    .setDescription('Keep a message pinned to the bottom of a channel (Godfathers + officers).')
    .addSubcommand(sub =>
      sub.setName('set').setDescription('Set (or replace) the sticky message in this channel.'))
    .addSubcommand(sub =>
      sub.setName('edit').setDescription("Edit this channel's sticky message, pre-filled."))
    .addSubcommand(sub =>
      sub.setName('remove').setDescription('Remove the sticky message from this channel.'))
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List every active sticky message in the server.')),

  async execute(interaction) {
    // Gate — Godfathers + officers, every subcommand including list.
    if (!handlers.isStickyOfficer(interaction)) {
      await interaction.reply(ephemeral(COPY.NO_PERMISSION));
      return;
    }

    // Graceful degradation — no store means no sticky operations.
    if (!db.isReady()) {
      await interaction.reply(ephemeral(COPY.DB_DOWN));
      return;
    }

    const sub = interaction.options.getSubcommand();

    // -----------------------------------------------------------------------
    // list — server-wide, so it does not care about the current channel.
    // -----------------------------------------------------------------------
    if (sub === 'list') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const docs = await db.listForGuild(interaction.guildId);
      if (!docs.length) {
        await interaction.editReply({ content: COPY.LIST_EMPTY, allowedMentions: { parse: [] } });
        return;
      }

      const header = `📌 **Active sticky messages — ${docs.length}**\n`;
      const rows = [];
      let budget = LIST_CONTENT_MAX - header.length;
      let omitted = 0;

      for (const doc of docs) {
        const row = renderListRow(doc);
        if (row.length + 1 > budget) { omitted += 1; continue; }
        rows.push(row);
        budget -= row.length + 1;
      }
      if (omitted) rows.push(`… and **${omitted}** more (too long to show).`);

      await interaction.editReply({
        content: header + rows.join('\n'),
        allowedMentions: { parse: [] },
      });
      return;
    }

    // -----------------------------------------------------------------------
    // Everything below acts on THE CHANNEL THE COMMAND WAS RUN IN (spec §3).
    // -----------------------------------------------------------------------
    const channel = interaction.channel;

    if (!interaction.guild || !isSupportedChannel(channel)) {
      await interaction.reply(ephemeral(COPY.NOT_TEXT_CHANNEL));
      return;
    }

    // ---------------------------------------------------------------------
    // remove
    // ---------------------------------------------------------------------
    if (sub === 'remove') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const doc = await db.get(channel.id);
      if (!doc) {
        // Nothing in the store. Drop any stale watch anyway — a Map entry with
        // no record behind it would repost forever with nothing to persist to.
        engine.forget(channel.id);
        await interaction.editReply(COPY.NOTHING_HERE);
        return;
      }

      await engine.uninstall(interaction.client, channel.id, doc.messageId ?? null);
      await interaction.editReply({
        content: COPY.REMOVED(`<#${channel.id}>`),
        allowedMentions: { parse: [] },
      });
      return;
    }

    // ---------------------------------------------------------------------
    // edit — the modal is PRE-FILLED with what is currently posted.
    //
    // showModal MUST be the first response, so every refusal below replies
    // ephemerally INSTEAD of showing a modal; none of them defer first.
    // ---------------------------------------------------------------------
    if (sub === 'edit') {
      const doc = await db.get(channel.id);
      if (!doc) {
        await interaction.reply(ephemeral(COPY.NOTHING_HERE));
        return;
      }
      await interaction.showModal(handlers.buildModal(channel.id, MODES.EDIT, doc));
      return;
    }

    // ---------------------------------------------------------------------
    // set
    // ---------------------------------------------------------------------
    if (sub === 'set') {
      if (!botCanPost(interaction, channel)) {
        await interaction.reply(ephemeral(COPY.CANNOT_POST(`<#${channel.id}>`)));
        return;
      }

      // STICKY-ON-STICKY (spec §5). Refused here, before a single character is
      // typed, and the refusal names the feature that owns the channel.
      const owner = await handlers.conflictOwnerFor(channel.id);
      if (owner) {
        await interaction.reply(ephemeral(COPY.CONFLICT(`<#${channel.id}>`, owner)));
        return;
      }

      // Prefill from an existing sticky so "replace" is an edit-in-place rather
      // than retyping — the confirmation still says REPLACED.
      const existing = await db.get(channel.id);
      await interaction.showModal(handlers.buildModal(channel.id, MODES.SET, existing));
      return;
    }
  },
};
