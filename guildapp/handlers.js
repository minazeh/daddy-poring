const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { IDS, FIELDS, REVIEWER_ROLE_IDS, ROLE_IDS, CLASS_ROLE_BY_ID } = require('./constants');

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

  // Detect class from the applicant's self-assigned class role.
  const classRoleEntry = interaction.member?.roles?.cache
    ?.find((_role, id) => CLASS_ROLE_BY_ID[id]);
  const applicantClass = classRoleEntry ? CLASS_ROLE_BY_ID[classRoleEntry.id] : '—';

  const embed = new EmbedBuilder()
    .setTitle('Guild Application')
    .setColor(0x2b2d31)
    .setDescription(`Applicant: ${interaction.user} (${interaction.user.tag})`)
    .addFields(
      { name: 'In-game Name',         value: answers.ign || '—',       inline: false },
      { name: 'Class',                value: applicantClass,            inline: false },
      { name: 'Playstyle',            value: answers.playstyle || '—', inline: true  },
      { name: 'Previous Guild (CBT)', value: answers.prevGuild || '—', inline: true  },
      { name: 'Inviter',              value: answers.inviter || '—',   inline: false },
      { name: '​',                    value: '────────────────────',   inline: false },
      { name: 'Status',               value: 'Pending',                inline: false },
    )
    .setTimestamp();

  // Four review buttons — appreview:<action>:<applicantUserId>
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.REVIEW_PREFIX}:main:${interaction.user.id}`)
      .setLabel('Daddy')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${IDS.REVIEW_PREFIX}:second:${interaction.user.id}`)
      .setLabel('Mummy')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${IDS.REVIEW_PREFIX}:wait:${interaction.user.id}`)
      .setLabel('Waiting List')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${IDS.REVIEW_PREFIX}:reject:${interaction.user.id}`)
      .setLabel('Reject')
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
// 5. Review buttons (staff action) — four outcomes.
// ---------------------------------------------------------------------------

// Returns true only if the member holds at least one of the designated reviewer roles.
function isReviewer(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return REVIEWER_ROLE_IDS.some(roleId => member.roles?.cache?.has?.(roleId));
}

// ---------------------------------------------------------------------------
// Outcome config — drives embed presentation and role ops for each action.
// ---------------------------------------------------------------------------
const OUTCOME = {
  main: {
    statusText: '✅ Accepted — Main Guild',
    color:      0x2ecc71,
    dmText:     '🎉 Congratulations! Your guild application has been approved — welcome to the guild! We\'re so happy to have you with us. Take a moment to look around the channels and introduce yourself, and we\'ll see you in-game! 💛',
    async applyRoles(member) {
      const warnings = [];
      try {
        if (member.roles.cache.has(ROLE_IDS.RECRUIT)) {
          await member.roles.remove(ROLE_IDS.RECRUIT, 'Guild application accepted — Main Guild');
        }
      } catch (err) {
        warnings.push(`could not remove Recruit: ${err?.message || err}`);
      }
      try {
        await member.roles.add(ROLE_IDS.ACCEPTED, 'Guild application accepted — Main Guild');
      } catch (err) {
        warnings.push(`could not add Daddy: ${err?.message || err}`);
      }
      return warnings;
    },
  },
  second: {
    statusText: '✅ Accepted — Second Guild',
    color:      0x2ecc71,
    dmText:     '🎉 Congratulations! Your guild application has been approved — welcome to the guild! We\'re so happy to have you with us. Take a moment to look around the channels and introduce yourself, and we\'ll see you in-game! 💛',
    async applyRoles(member) {
      const warnings = [];
      try {
        if (member.roles.cache.has(ROLE_IDS.RECRUIT)) {
          await member.roles.remove(ROLE_IDS.RECRUIT, 'Guild application accepted — Second Guild');
        }
      } catch (err) {
        warnings.push(`could not remove Recruit: ${err?.message || err}`);
      }
      try {
        await member.roles.add(ROLE_IDS.MUMMY, 'Guild application accepted — Second Guild');
      } catch (err) {
        warnings.push(`could not add Mummy: ${err?.message || err}`);
      }
      return warnings;
    },
  },
  wait: {
    statusText: '🕓 Waiting List',
    color:      0xF1C40F,
    dmText:     '💛 Thank you so much for applying to our guild! For now, we\'ve placed your application on our waiting list — this isn\'t a no, we simply have limited space at the moment. We\'ll reach out to you the very moment a spot opens up. We truly appreciate your patience and your interest in joining us!',
    async applyRoles(member) {
      const warnings = [];
      // Keep Recruit; add Waiting List role.
      try {
        await member.roles.add(ROLE_IDS.WAITING_LIST, 'Guild application — placed on waiting list');
      } catch (err) {
        warnings.push(`could not add Waiting List: ${err?.message || err}`);
      }
      return warnings;
    },
  },
  reject: {
    statusText: '❌ Not Accepted',
    color:      0xe74c3c,
    dmText:     'Thank you so very much for taking the time to apply to our guild — it genuinely means a lot that you considered joining us. After careful and thoughtful consideration, we\'re sorry to say we\'re unable to offer you a place at this time. Please know this is in no way a reflection of you as a player or as a person, and you would be most welcome to apply again in the future. We sincerely wish you all the very best in your adventures, and we hope our paths cross again someday. 💛',
    async applyRoles(_member) {
      // No role changes on reject.
      return [];
    },
  },
};

async function handleReviewButton(interaction, action, applicantUserId) {
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
  fields.push({ name: 'Reviewed by', value: reviewerName, inline: false });
  embed.setFields(fields);

  // Disable all four buttons.
  const originalComponents = interaction.message.components[0].components;
  const disabledRow = new ActionRowBuilder().addComponents(
    ...originalComponents.map(c => ButtonBuilder.from(c).setDisabled(true)),
  );

  await interaction.update({ embeds: [embed], components: [disabledRow] });

  // Role management — fetch member; if gone, skip roles but still update embed + DM.
  let member = null;
  const guild = interaction.guild;
  if (guild) {
    try {
      member = await guild.members.fetch(applicantUserId);
    } catch (_err) {
      // Member left — surface a soft warning, continue to DM attempt.
      try {
        await interaction.followUp({
          content: 'Outcome recorded, but applicant is no longer in the server — role changes skipped.',
          ephemeral: true,
        });
      } catch (e) {
        console.warn('[guildapp] Could not send member-left followUp:', e?.message || e);
      }
    }
  }

  if (member) {
    let roleWarnings = [];
    try {
      roleWarnings = await outcome.applyRoles(member);
    } catch (err) {
      roleWarnings = [`unexpected error: ${err?.message || err}`];
    }

    if (roleWarnings.length) {
      try {
        await interaction.followUp({
          content:
            'Outcome recorded, but couldn\'t change some roles: ' +
            roleWarnings.join('; ') +
            '. Check the bot has Manage Roles and its role is above Daddy/Mummy/Waiting List/Recruit.',
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
    await applicant.send(outcome.dmText);
  } catch (err) {
    console.warn(`[guildapp] Could not DM applicant ${applicantUserId}:`, err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Router — called from events/interactionCreate.js. Returns true if it handled
// the interaction (so the command path is skipped).
// Handles: guildapp:start, guildapp:modal, appreview:<action>:<userId>
// ---------------------------------------------------------------------------
async function route(interaction) {
  // Buttons
  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id === IDS.START_BUTTON) {
      await handleStartButton(interaction);
      return true;
    }
    if (id.startsWith(`${IDS.REVIEW_PREFIX}:`)) {
      // appreview:<action>:<applicantUserId>
      const parts = id.split(':');
      const action = parts[1];          // main | second | wait | reject
      const applicantUserId = parts[2]; // snowflake
      await handleReviewButton(interaction, action, applicantUserId);
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
