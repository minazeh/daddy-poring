const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const {
  IDS,
  FIELDS,
  OFFICER_APP_CHANNEL_ID,
  JOB_AD_CHANNEL_ID,
  OFFICER_APPLICANT_ROLE_IDS,
  OFFICER_ROLE_IDS,
} = require('./constants');
// REVIEW gate reuses the guild-app reviewer roles.
const { REVIEWER_ROLE_IDS } = require('../guildapp/constants');

// Polite copy — kept here so command + handlers agree.
const COPY = {
  SUBMIT_CONFIRM:
    "✅ Thank you! Your application has been submitted and is now under review by leadership. We'll be in touch soon!",
  APPROVE_DM:
    "🎉 Congratulations! Your application has been approved. Thank you for stepping up to help lead the guild — we're excited to have you on the team!",
  DENY_DM:
    "💛 Thank you so much for applying and for your willingness to take on more responsibility. After careful consideration, we've decided not to move forward with your application at this time. This is in no way a reflection of your value to the guild, and we'd warmly welcome you to apply again in the future. Thank you for everything you do!",
};

// ---------------------------------------------------------------------------
// Role gates.
// ---------------------------------------------------------------------------
function isReviewer(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return REVIEWER_ROLE_IDS.some(roleId => member.roles?.cache?.has?.(roleId));
}

function canApply(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return OFFICER_APPLICANT_ROLE_IDS.some(roleId => member.roles?.cache?.has?.(roleId));
}

// ---------------------------------------------------------------------------
// 1. Job-ad modal submit (jobad:modal) -> build a job-ad embed and post it to
//    #job-ad with an Apply button. Persistence is via the message id itself:
//    the Apply button's customId carries the job-ad message's OWN id, so no
//    database/file is needed. Done in two steps (send w/ temp button, then edit
//    to bake jobapply:<msg.id> in).
// ---------------------------------------------------------------------------
async function handleJobAdModalSubmit(interaction) {
  const title = interaction.fields.getTextInputValue(FIELDS.AD_TITLE).trim();
  const description = interaction.fields.getTextInputValue(FIELDS.AD_DESCRIPTION).trim();

  const guildIcon = interaction.guild?.iconURL() ?? undefined;
  const guildName = interaction.guild?.name ?? 'Recruitment';

  const adDescription = (description || '—') +
    '\n\n**How to apply:** Click the **Apply** button below to submit your application.';

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${guildName} • Recruitment`, iconURL: guildIcon })
    .setTitle(`📌 ${title || 'Job Ad'}`)
    .setColor(0xC9A227) // refined gold accent
    .setDescription(adDescription)
    .setThumbnail(guildIcon ?? null)
    .setFooter({ text: guildName, iconURL: guildIcon })
    .setTimestamp();

  // Temporary Apply button — customId gets the real message id baked in after send.
  const tempRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.APPLY_PREFIX}:pending`)
      .setLabel('Apply')
      .setStyle(ButtonStyle.Success),
  );

  // Guard the channel fetch/post — missing or not-sendable must not crash.
  let channel = null;
  try {
    channel = await interaction.client.channels.fetch(JOB_AD_CHANNEL_ID);
  } catch (err) {
    console.warn('[jobad] Could not fetch job-ad channel:', err?.message || err);
  }

  if (!channel || typeof channel.send !== 'function') {
    console.warn(`[jobad] Job-ad channel ${JOB_AD_CHANNEL_ID} missing or not sendable.`);
    await interaction.reply({
      content: "Sorry — couldn't post the job ad right now. Please contact staff.",
      ephemeral: true,
    });
    return;
  }

  try {
    const msg = await channel.send({ embeds: [embed], components: [tempRow] });

    // Bake the message's own id into the Apply button's customId.
    const finalRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.APPLY_PREFIX}:${msg.id}`)
        .setLabel('Apply')
        .setStyle(ButtonStyle.Success),
    );
    await msg.edit({ embeds: [embed], components: [finalRow] });
  } catch (err) {
    console.warn('[jobad] Could not post/edit job ad:', err?.message || err);
    await interaction.reply({
      content: "Sorry — couldn't post the job ad right now. Please contact staff.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: `✅ Job ad posted in <#${JOB_AD_CHANNEL_ID}>.`,
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// 2. Apply button (jobapply:<jobAdMessageId>) -> gate to applicant roles, then
//    show the officer-application modal carrying the job-ad id through.
// ---------------------------------------------------------------------------
async function handleApplyButton(interaction, jobAdMessageId) {
  if (!canApply(interaction)) {
    await interaction.reply({
      content: "Sorry, you're not eligible to apply for this.",
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${IDS.APP_MODAL_PREFIX}:${jobAdMessageId}`)
    .setTitle('Officer Application');

  const ign = new TextInputBuilder()
    .setCustomId(FIELDS.IGN)
    .setLabel('In-game Name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Your actual in-game name')
    .setRequired(true);

  const whyFit = new TextInputBuilder()
    .setCustomId(FIELDS.WHY_FIT)
    .setLabel('Why do you think you are fit for this role?')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(ign),
    new ActionRowBuilder().addComponents(whyFit),
  );

  await interaction.showModal(modal);
}

// ---------------------------------------------------------------------------
// 3. Officer modal submit (officerapp:modal:<jobAdMessageId>) -> fetch the job
//    ad to read its Title, then build + post the officer-application embed to
//    #officer-applications with Daddy / Mummy / Reject buttons. The title is
//    baked into the embed permanently (inherited from the ad, not typed).
// ---------------------------------------------------------------------------
async function handleOfficerModalSubmit(interaction, jobAdMessageId) {
  const ign = interaction.fields.getTextInputValue(FIELDS.IGN).trim();
  const whyFit = interaction.fields.getTextInputValue(FIELDS.WHY_FIT).trim();

  // Read the job-ad Title from the fetched message. If the ad is gone, stop.
  let jobTitle = null;
  try {
    const channel = await interaction.client.channels.fetch(JOB_AD_CHANNEL_ID);
    const adMsg = await channel.messages.fetch(jobAdMessageId);
    jobTitle = adMsg.embeds?.[0]?.title ?? null;
  } catch (err) {
    console.warn('[officerapp] Could not fetch job ad for application:', err?.message || err);
  }

  if (!jobTitle) {
    await interaction.reply({
      content: 'Sorry — this job ad is no longer available.',
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Officer Application')
    .setColor(0x2b2d31) // dark embed accent
    .setDescription(`Applicant: ${interaction.user} (${interaction.user.tag})`)
    .addFields(
      { name: 'In-game Name',                  value: ign || '—',     inline: false },
      { name: 'Applying For',                  value: jobTitle,        inline: false },
      { name: "Why they're fit for this role", value: whyFit || '—',  inline: false },
      { name: 'Status',                        value: 'Pending',       inline: false },
    )
    .setTimestamp();

  // Daddy / Mummy / Reject — officerreview:<action>:<applicantUserId>:<jobAdMessageId>
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.REVIEW_PREFIX}:daddy:${interaction.user.id}:${jobAdMessageId}`)
      .setLabel('Daddy')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${IDS.REVIEW_PREFIX}:mummy:${interaction.user.id}:${jobAdMessageId}`)
      .setLabel('Mummy')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${IDS.REVIEW_PREFIX}:reject:${interaction.user.id}:${jobAdMessageId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );

  // Guard the channel fetch/send.
  let channel = null;
  try {
    channel = await interaction.client.channels.fetch(OFFICER_APP_CHANNEL_ID);
  } catch (err) {
    console.warn('[officerapp] Could not fetch officer channel:', err?.message || err);
  }

  if (!channel || typeof channel.send !== 'function') {
    console.warn(`[officerapp] Officer channel ${OFFICER_APP_CHANNEL_ID} missing or not sendable.`);
    await interaction.reply({
      content: "Sorry — we couldn't submit your application right now. Please contact staff.",
      ephemeral: true,
    });
    return;
  }

  try {
    await channel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.warn('[officerapp] Could not post officer application embed:', err?.message || err);
    await interaction.reply({
      content: "Sorry — we couldn't submit your application right now. Please contact staff.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: COPY.SUBMIT_CONFIRM, ephemeral: true });
}

// ---------------------------------------------------------------------------
// 4. Review buttons (staff action) — Daddy / Mummy (approve) / Reject.
// ---------------------------------------------------------------------------

// Outcome config — drives embed presentation + DM copy for each action.
// Both daddy and mummy use the same generic approval DM (applicant can't tell the tier).
const OUTCOME = {
  daddy: {
    statusText: '✅ Approved — Daddy',
    color:      0x2ecc71,
    dmText:     COPY.APPROVE_DM,
    roleId:     OFFICER_ROLE_IDS.DADDY,
    approval:   true,
  },
  mummy: {
    statusText: '✅ Approved — Mummy',
    color:      0x2ecc71,
    dmText:     COPY.APPROVE_DM,
    roleId:     OFFICER_ROLE_IDS.MUMMY,
    approval:   true,
  },
  reject: {
    statusText: '❌ Not Approved',
    color:      0xe74c3c,
    dmText:     COPY.DENY_DM,
    roleId:     null,
    approval:   false,
  },
};

async function handleReviewButton(interaction, action, applicantUserId, jobAdMessageId) {
  if (!isReviewer(interaction)) {
    await interaction.reply({
      content: "You don't have permission to review applications.",
      ephemeral: true,
    });
    return;
  }

  const outcome = OUTCOME[action];
  if (!outcome) {
    // Unknown action — ignore silently (shouldn't happen with known customIds).
    return;
  }

  // Rebuild the embed from the posted message, setting Status + color + Reviewed by.
  const source = interaction.message.embeds[0];
  const embed = EmbedBuilder.from(source).setColor(outcome.color);

  const reviewerName = interaction.member?.displayName ?? interaction.user.tag;
  const fields = (source.fields || []).map(f =>
    f.name === 'Status'
      ? { name: 'Status', value: outcome.statusText, inline: f.inline }
      : { name: f.name, value: f.value, inline: f.inline },
  );
  const idx = fields.findIndex(f => f.name === 'Reviewed by');
  if (idx >= 0) {
    fields[idx] = { name: 'Reviewed by', value: reviewerName, inline: false };
  } else {
    fields.push({ name: 'Reviewed by', value: reviewerName, inline: false });
  }
  embed.setFields(fields);

  // Disable all three buttons.
  const originalComponents = interaction.message.components[0].components;
  const disabledRow = new ActionRowBuilder().addComponents(
    ...originalComponents.map(c => ButtonBuilder.from(c).setDisabled(true)),
  );

  await interaction.update({ embeds: [embed], components: [disabledRow] });

  // Role assignment for approval actions (daddy / mummy).
  let roleWarning = null;
  if (outcome.approval && outcome.roleId) {
    try {
      const member = await interaction.guild.members.fetch(applicantUserId);
      await member.roles.add(outcome.roleId);
    } catch (err) {
      if (err?.code === 10007 /* Unknown Member */) {
        // Member left the guild — skip role assign, still update embed + DM.
        console.warn(`[officerapp] Applicant ${applicantUserId} is no longer in the guild — skipping role assign.`);
      } else {
        const reason = err?.message || String(err);
        roleWarning = `Approved, but couldn't assign the role: ${reason}. Check Manage Roles + bot role is above the officer role.`;
        console.warn(`[officerapp] Role assign failed for ${applicantUserId}:`, reason);
      }
    }
  }

  // On approval, delete the job-ad message so it stops accepting applicants.
  // Reject leaves the ad open for others.
  if (outcome.approval) {
    try {
      const adChannel = await interaction.client.channels.fetch(JOB_AD_CHANNEL_ID);
      const adMsg = await adChannel.messages.fetch(jobAdMessageId);
      await adMsg.delete();
    } catch (err) {
      // Already gone / can't delete — no-op (best effort).
      console.warn(`[officerapp] Could not delete job ad ${jobAdMessageId}:`, err?.message || err);
    }
  }

  if (roleWarning) {
    await interaction.followUp({ content: roleWarning, ephemeral: true });
  }

  // Best-effort DM to the applicant — never crash if DMs are closed or member left.
  try {
    const applicant = await interaction.client.users.fetch(applicantUserId);
    await applicant.send(outcome.dmText);
  } catch (err) {
    console.warn(`[officerapp] Could not DM applicant ${applicantUserId}:`, err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Router — called from events/interactionCreate.js. Returns true if it handled
// the interaction (so the command path / guildapp router is skipped).
// Handles: jobad:modal, jobapply:<id>, officerapp:modal:<id>,
//          officerreview:<action>:<userId>:<jobAdMessageId>
// ---------------------------------------------------------------------------
async function route(interaction) {
  // Buttons
  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id.startsWith(`${IDS.APPLY_PREFIX}:`)) {
      // jobapply:<jobAdMessageId>
      const jobAdMessageId = id.split(':')[1];
      await handleApplyButton(interaction, jobAdMessageId);
      return true;
    }

    if (id.startsWith(`${IDS.REVIEW_PREFIX}:`)) {
      // officerreview:<action>:<applicantUserId>:<jobAdMessageId>
      const parts = id.split(':');
      const action = parts[1];           // daddy | mummy | reject
      const applicantUserId = parts[2];  // snowflake
      const jobAdMessageId = parts[3];   // snowflake
      await handleReviewButton(interaction, action, applicantUserId, jobAdMessageId);
      return true;
    }

    return false;
  }

  // Modal submits
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;

    if (id === IDS.JOBAD_MODAL) {
      await handleJobAdModalSubmit(interaction);
      return true;
    }

    if (id.startsWith(`${IDS.APP_MODAL_PREFIX}:`)) {
      // officerapp:modal:<jobAdMessageId> — prefix itself contains one ':'.
      const jobAdMessageId = id.slice(`${IDS.APP_MODAL_PREFIX}:`.length);
      await handleOfficerModalSubmit(interaction, jobAdMessageId);
      return true;
    }

    return false;
  }

  return false;
}

module.exports = { route };
