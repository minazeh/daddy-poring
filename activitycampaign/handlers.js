// ---------------------------------------------------------------------------
// Activity-campaign button handler — routed from events/interactionCreate.js.
//
// customIds are STATIC (`activitycampaign:yes` / `activitycampaign:no`) and
// the weekly record key is derived from clicker id + current ISO week (UTC),
// so clicks work across any number of restarts with zero in-memory state.
//
// The public sticky prompt is never edited or replied to publicly — every ack
// is ephemeral, so the channel stays clean.
// ---------------------------------------------------------------------------

const db = require('./db');
const sticky = require('./sticky');
const { weekKeyForDate } = sticky;
const { IDS, FIELDS, ACK_YES, ACK_NO, ACK_DB_DOWN } = require('./constants');

// ---------------------------------------------------------------------------
// Start-modal submit — activitycampaign:startmodal:<channelId>. The Godfathers
// gate + channel/perm resolution already happened in the command before the
// modal was shown; here we read the typed prompt body, reject empty input,
// and start (or move/re-text) the campaign in the encoded channel.
// ---------------------------------------------------------------------------
async function handleStartModal(interaction) {
  const channelId = interaction.customId.slice(`${IDS.START_MODAL_PREFIX}:`.length);

  // Persistence unavailable — can't start. Confirm ephemerally, don't post.
  if (!db.isReady()) {
    await interaction.reply({
      content: '⚠️ The activity campaign is unavailable right now (database not reachable). Please try again later.',
      ephemeral: true,
    });
    return true;
  }

  const promptText = (interaction.fields.getTextInputValue(FIELDS.MESSAGE) || '').trim();
  if (!promptText) {
    await interaction.reply({
      content: '⚠️ The message can\'t be empty — run `/activitycampaign start` again and type the prompt.',
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) {
      await interaction.editReply('⚠️ I can no longer find that channel — pick another and try again.');
      return true;
    }
    const { moved, previousChannelId } = await sticky.start(channel, promptText);
    await interaction.editReply(
      moved
        ? `✅ Campaign moved from <#${previousChannelId}> to <#${channelId}> with your new message — sticky prompt posted. Stop it anytime with \`/activitycampaign stop\`.`
        : `✅ Campaign active in <#${channelId}> — sticky prompt posted. Stop it anytime with \`/activitycampaign stop\`.`,
    );
  } catch (err) {
    console.warn('[activitycampaign/handlers] Start-modal failed:', err?.message || err);
    try { await interaction.editReply('⚠️ Something went wrong starting the campaign — please try again.'); } catch { /* ignore */ }
  }
  return true;
}

// Returns true if this module owned the interaction (repo router convention).
async function route(interaction) {
  // Start-modal submit.
  if (interaction.isModalSubmit() && interaction.customId.startsWith(`${IDS.START_MODAL_PREFIX}:`)) {
    return handleStartModal(interaction);
  }

  if (!interaction.isButton()) return false;
  const id = interaction.customId;
  if (id !== IDS.YES && id !== IDS.NO) return false;

  const answer = id === IDS.YES ? 'yes' : 'no';

  // Graceful degradation — store unavailable: tell the clicker, don't record.
  if (!db.isReady()) {
    await interaction.reply({ content: ACK_DB_DOWN, ephemeral: true });
    return true;
  }

  try {
    const weekKey = weekKeyForDate();
    // Server display name when available; account name as fallback (DM-less
    // button clicks always come from the guild, but stay defensive).
    const displayName =
      interaction.member?.displayName ??
      interaction.user.globalName ??
      interaction.user.username;

    // Upsert: one doc per (userId, weekKey) — latest answer this week wins;
    // a new ISO week gives a fresh doc, so everyone can answer again.
    await db.recordResponse({
      userId: interaction.user.id,
      username: interaction.user.username,
      displayName,
      answer,
      weekKey,
      guildId: interaction.guildId,
    });

    // Same ack whether it's a first answer, a change, or a same-answer
    // re-click — always confirm, always ephemeral.
    await interaction.reply({
      content: answer === 'yes' ? ACK_YES : ACK_NO,
      ephemeral: true,
    });
  } catch (err) {
    console.warn('[activitycampaign/handlers] Failed to record response:', err?.message || err);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.reply({ content: ACK_DB_DOWN, ephemeral: true }); } catch { /* ignore */ }
    }
  }
  return true;
}

module.exports = { route };
