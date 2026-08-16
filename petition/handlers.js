// ---------------------------------------------------------------------------
// /petition — signature collection.
//
//   petition:sign   -> the Subject/Message modal
//   petition:modal  -> post the signature embed to the signature channel
//
// STATELESS BY DESIGN. Both customIds are static, and the modal submit carries
// every value the handler needs. There is no store to read, no cache to warm
// and no resume pass — a panel posted today keeps working after any number of
// redeploys, and there is no failure mode where the feature is "unavailable".
// ---------------------------------------------------------------------------

const {
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  MessageFlags,
} = require('discord.js');

const {
  IDS,
  FIELDS,
  SIGNATURE_CHANNEL_ID,
  SUBJECT_MAX,
  MESSAGE_MAX,
  COLORS,
} = require('./constants');

// Neutralise anything that would let a signature ping the signature channel.
// Zero-width space after the @ kills the mention without mangling the text.
function defuseMentions(text) {
  return String(text || '').replace(/@(everyone|here|&\d+|!?\d+)/g, '@​$1');
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// ---------------------------------------------------------------------------
// 1. Sign button -> modal.
// ---------------------------------------------------------------------------
async function handleSignButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(IDS.MODAL)
    .setTitle('Sign the Petition');

  const subject = new LabelBuilder()
    .setLabel('Subject')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId(FIELDS.SUBJECT)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('A short headline for your message')
        .setMaxLength(SUBJECT_MAX)
        .setRequired(true),
    );

  const message = new LabelBuilder()
    .setLabel('Message')
    .setDescription('Your words of encouragement for Solar.')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId(FIELDS.MESSAGE)
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Say your piece — it all gets compiled and passed on.')
        .setMaxLength(MESSAGE_MAX)
        .setRequired(true),
    );

  modal.addLabelComponents(subject, message);
  await interaction.showModal(modal);
}

// ---------------------------------------------------------------------------
// 2. Modal submit -> signature embed.
//
// Format per Conrad: Subject, Message, From: <discord nickname>.
// "Nickname" = the server display name (member.displayName), which falls back
// to the account username when no nickname is set. The raw user id goes in the
// footer so a signature stays attributable after a rename.
// ---------------------------------------------------------------------------
async function handleModalSubmit(interaction) {
  const subject = interaction.fields.getTextInputValue(FIELDS.SUBJECT).trim();
  const message = interaction.fields.getTextInputValue(FIELDS.MESSAGE).trim();
  const nickname = interaction.member?.displayName ?? interaction.user.username;

  const embed = new EmbedBuilder()
    .setColor(COLORS.SIGNATURE)
    .addFields(
      { name: 'Subject', value: defuseMentions(subject).slice(0, 1024) || '—', inline: false },
      { name: 'Message', value: defuseMentions(message).slice(0, 1024) || '—', inline: false },
      { name: 'From',    value: defuseMentions(nickname).slice(0, 1024),       inline: false },
    )
    .setFooter({ text: `${interaction.user.tag} • ${interaction.user.id}` })
    .setTimestamp();

  const avatar = interaction.user.displayAvatarURL?.();
  if (avatar) embed.setThumbnail(avatar);

  try {
    const channel = await interaction.client.channels.fetch(SIGNATURE_CHANNEL_ID);
    if (!channel?.isTextBased?.()) {
      throw new Error(`Signature channel ${SIGNATURE_CHANNEL_ID} is missing or not text-based.`);
    }
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.warn('[petition] Could not post signature:', err?.message || err);
    await interaction.reply(ephemeral(
      "Couldn't record your signature — please try again in a moment, or DM a Godfather directly.",
    ));
    return;
  }

  await interaction.reply(ephemeral(
    '✅ Signed — thank you. Your message has been added to the pile for Solar.',
  ));
}

// ---------------------------------------------------------------------------
// Router — called from events/interactionCreate.js. Returns true if it owned
// the interaction. Claims only the `petition:` namespace.
// ---------------------------------------------------------------------------
async function route(interaction) {
  if (interaction.isButton() && interaction.customId === IDS.SIGN_BUTTON) {
    await handleSignButton(interaction);
    return true;
  }
  if (interaction.isModalSubmit() && interaction.customId === IDS.MODAL) {
    await handleModalSubmit(interaction);
    return true;
  }
  return false;
}

module.exports = { route, defuseMentions };
