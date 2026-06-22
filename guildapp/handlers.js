const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { IDS, FIELDS, REVIEWER_ROLE_IDS, ROLE_IDS } = require('./constants');

const APPLICATION_CHANNEL_ID = process.env.APPLICATION_CHANNEL_ID || '1518623626247671878';

// ---------------------------------------------------------------------------
// 2. Start button -> open the 4-input modal.
// ---------------------------------------------------------------------------
async function handleStartButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(IDS.MODAL)
    .setTitle('Guild Application');

  const ign = new TextInputBuilder()
    .setCustomId(FIELDS.IGN)
    .setLabel('In-game Name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Your actual in-game name')
    .setRequired(true);

  const playstyle = new TextInputBuilder()
    .setCustomId(FIELDS.PLAYSTYLE)
    .setLabel('Playstyle')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const prevGuild = new TextInputBuilder()
    .setCustomId(FIELDS.PREVIOUS_GUILD)
    .setLabel('Previous Guild (CBT)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Guild during Closed Beta, if any')
    .setRequired(false);

  const inviter = new TextInputBuilder()
    .setCustomId(FIELDS.INVITER)
    .setLabel('Inviter')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Who invited you? (if anyone)')
    .setRequired(false);

  // Each text input must sit in its own action row. Discord caps modals at 5.
  modal.addComponents(
    new ActionRowBuilder().addComponents(ign),
    new ActionRowBuilder().addComponents(playstyle),
    new ActionRowBuilder().addComponents(prevGuild),
    new ActionRowBuilder().addComponents(inviter),
  );

  await interaction.showModal(modal);
}

// ---------------------------------------------------------------------------
// 3. Modal submit -> all 4 answers are present; build + post the application
//    embed to the application channel, then ephemerally confirm to the applicant.
// ---------------------------------------------------------------------------
async function handleModalSubmit(interaction) {
  const answers = {
    ign:       interaction.fields.getTextInputValue(FIELDS.IGN).trim(),
    playstyle: interaction.fields.getTextInputValue(FIELDS.PLAYSTYLE).trim(),
    prevGuild: interaction.fields.getTextInputValue(FIELDS.PREVIOUS_GUILD).trim(),
    inviter:   interaction.fields.getTextInputValue(FIELDS.INVITER).trim(),
  };

  const embed = new EmbedBuilder()
    .setTitle('Guild Application')
    .setColor(0x2b2d31)
    .setDescription(`Applicant: ${interaction.user} (${interaction.user.tag})`)
    .addFields(
      { name: 'In-game Name',         value: answers.ign || '—',       inline: false },
      { name: 'Playstyle',            value: answers.playstyle || '—', inline: true  },
      { name: 'Previous Guild (CBT)', value: answers.prevGuild || '—', inline: true  },
      { name: 'Inviter',              value: answers.inviter || '—',   inline: false },
      { name: '​',                    value: '────────────────────',   inline: false },
      { name: 'Status',               value: 'Pending',                inline: false },
    )
    .setTimestamp();

  // Approve customId carries only the applicant id now. Format: appapprove:<applicantUserId>.
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.APPROVE_PREFIX}:${interaction.user.id}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${IDS.DENY_PREFIX}:${interaction.user.id}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
  );

  const channel = await interaction.client.channels.fetch(APPLICATION_CHANNEL_ID);
  await channel.send({ embeds: [embed], components: [row] });

  await interaction.reply({
    content: '✅ Application submitted — pending approval. Please be patient.',
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// 5. Approve / Deny buttons (staff action).
// ---------------------------------------------------------------------------

// Returns true only if the member holds at least one of the designated reviewer roles.
// ManageGuild and STAFF_ROLE_ID env var are intentionally not checked here.
function isReviewer(interaction) {
  const member = interaction.member;
  if (!member) return false;

  return REVIEWER_ROLE_IDS.some(roleId => member.roles?.cache?.has?.(roleId));
}

// ---------------------------------------------------------------------------
// Approval role management. Runs on the applicant's GuildMember:
//   - remove Recruit by ID (if present), add Daddy by ID (ROLE_IDS.ACCEPTED)
// Every guild/role op is wrapped so a failure never crashes the approve flow.
// Returns { warnings: string[] } — non-empty means surface to the reviewer.
// ---------------------------------------------------------------------------
async function applyApprovalRoles(interaction, applicantUserId) {
  const warnings = [];
  const guild = interaction.guild;

  if (!guild) {
    warnings.push('no guild context — role changes skipped');
    return { warnings };
  }

  // Fetch the member; if they've left the guild, skip role changes entirely.
  let member;
  try {
    member = await guild.members.fetch(applicantUserId);
  } catch (err) {
    warnings.push('applicant is no longer in the server — role changes skipped');
    return { warnings };
  }

  // Remove Recruit by ID (if present), add Daddy by ID.
  try {
    if (member.roles.cache.has(ROLE_IDS.RECRUIT)) {
      await member.roles.remove(ROLE_IDS.RECRUIT, 'Guild application approved');
    }
  } catch (err) {
    warnings.push(`could not remove Recruit: ${err?.message || err}`);
  }

  try {
    await member.roles.add(ROLE_IDS.ACCEPTED, 'Guild application approved');
  } catch (err) {
    warnings.push(`could not add Daddy: ${err?.message || err}`);
  }

  return { warnings };
}

async function handleReviewButton(interaction, decision /* 'approve' | 'deny' */, applicantUserId) {
  if (!isReviewer(interaction)) {
    await interaction.reply({
      content: "You don't have permission to review applications.",
      ephemeral: true,
    });
    return;
  }

  const approved = decision === 'approve';

  // Rebuild the embed from the posted message, overriding Status + color +
  // adding "Reviewed by".
  const source = interaction.message.embeds[0];
  const embed = EmbedBuilder.from(source)
    .setColor(approved ? 0x2ecc71 : 0xe74c3c);

  // Replace the Status field; append Reviewed by.
  const fields = (source.fields || []).map(f =>
    f.name === 'Status'
      ? { name: 'Status', value: approved ? '✅ Approved' : '❌ Denied', inline: f.inline }
      : { name: f.name, value: f.value, inline: f.inline },
  );
  fields.push({ name: 'Reviewed by', value: interaction.member?.displayName ?? interaction.user.tag, inline: false });
  embed.setFields(fields);

  // Disable both buttons.
  const disabledRow = new ActionRowBuilder().addComponents(
    ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true),
    ButtonBuilder.from(interaction.message.components[0].components[1]).setDisabled(true),
  );

  await interaction.update({ embeds: [embed], components: [disabledRow] });

  // On approval, manage roles. All ops are individually try/catch'd inside the
  // helper, so this never throws — it returns warnings to surface if any op
  // failed (missing perms / hierarchy / member left / missing role).
  if (approved) {
    let roleWarnings = [];
    try {
      const result = await applyApprovalRoles(interaction, applicantUserId);
      roleWarnings = result.warnings;
    } catch (err) {
      roleWarnings = [`unexpected error: ${err?.message || err}`];
    }

    if (roleWarnings.length) {
      try {
        await interaction.followUp({
          content:
            'Approved, but couldn\'t assign some roles: ' +
            roleWarnings.join('; ') +
            '. Check the bot has Manage Roles and its role is above the Daddy role in the hierarchy.',
          ephemeral: true,
        });
      } catch (e) {
        console.warn('[guildapp] Could not send role-warning followUp:', e?.message || e);
      }
    }
  }

  // Best-effort DM to the applicant — never crash if DMs are closed.
  try {
    const applicant = await interaction.client.users.fetch(applicantUserId);
    await applicant.send(
      approved
        ? 'Your guild application has been approved!'
        : 'Your guild application was not approved at this time.',
    );
  } catch (err) {
    console.warn(`[guildapp] Could not DM applicant ${applicantUserId}:`, err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Router — called from events/interactionCreate.js. Returns true if it handled
// the interaction (so the command path is skipped).
// Handles: guildapp:start, guildapp:modal, appapprove:*, appdeny:*
// ---------------------------------------------------------------------------
async function route(interaction) {
  // Buttons
  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id === IDS.START_BUTTON) {
      await handleStartButton(interaction);
      return true;
    }
    if (id.startsWith(`${IDS.APPROVE_PREFIX}:`)) {
      // appapprove:<applicantUserId>
      await handleReviewButton(interaction, 'approve', id.split(':')[1]);
      return true;
    }
    if (id.startsWith(`${IDS.DENY_PREFIX}:`)) {
      // appdeny:<applicantUserId>
      await handleReviewButton(interaction, 'deny', id.split(':')[1]);
      return true;
    }
    return false;
  }

  // Modal submit
  if (interaction.isModalSubmit() && interaction.customId === IDS.MODAL) {
    await handleModalSubmit(interaction);
    return true;
  }

  return false;
}

module.exports = { route };
