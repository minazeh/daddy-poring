const { SlashCommandBuilder } = require('discord.js');
const engine = require('../monsterquiz/engine');
const {
  ALLOWED_CHANNEL_ID,
  DEFAULT_QUESTIONS,
  MIN_QUESTIONS,
  MAX_QUESTIONS,
} = require('../monsterquiz/constants');

// Clamp defensively even though the option enforces min/max — protects against
// any client that sends an out-of-range value.
function clampQuestions(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_QUESTIONS;
  return Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, v));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roquiz')
    .setDescription('Start an RO Quiz — pick a category: unscramble names, or Hoppy / Banquet / Scholar trivia.')
    .addIntegerOption((opt) =>
      opt
        .setName('questions')
        .setDescription(`How many rounds (${MIN_QUESTIONS}–${MAX_QUESTIONS}, default ${DEFAULT_QUESTIONS}).`)
        .setMinValue(MIN_QUESTIONS)
        .setMaxValue(MAX_QUESTIONS)
        .setRequired(false)),

  // Available to EVERYONE, but only in the ONE allowed channel. The wrong-channel
  // reply is the SOLE ephemeral in this feature (a command gate, not game flow);
  // once a game starts every engine reply is public.
  //
  // No rodb readiness gate here: the category menu always posts. Three of the
  // four categories (Hoppy / Guild Banquet / Scholar) run from bundled banks and
  // work with the game database offline; only the jumble category needs rodb, and
  // it fails gracefully at pick time if the DB is down (see routeCategorySelect).
  async execute(interaction) {
    // Channel gate: /roquiz only works in ALLOWED_CHANNEL_ID. Elsewhere, tell the
    // user where to go (ephemeral) and start no game.
    if (interaction.channelId !== ALLOWED_CHANNEL_ID) {
      await interaction.reply({
        content: `⚠️ /roquiz can only be used in <#${ALLOWED_CHANNEL_ID}>.`,
        ephemeral: true,
      });
      return;
    }

    const raw = interaction.options.getInteger('questions');
    const questions = raw == null ? DEFAULT_QUESTIONS : clampQuestions(raw);

    await engine.startGame(interaction, { questions });
  },

  // Exported for unit/simulation testing (ignored by the command loader).
  clampQuestions,
};
