const { SlashCommandBuilder } = require('discord.js');
const engine = require('../monsterquiz/engine');
const {
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
    .setName('monsterquiz')
    .setDescription('Start a party quiz — pick a category: unscramble names, True/False, or trivia.')
    .addIntegerOption((opt) =>
      opt
        .setName('questions')
        .setDescription(`How many rounds (${MIN_QUESTIONS}–${MAX_QUESTIONS}, default ${DEFAULT_QUESTIONS}).`)
        .setMinValue(MIN_QUESTIONS)
        .setMaxValue(MAX_QUESTIONS)
        .setRequired(false)),

  // Available to EVERYONE. Every reply is public (no ephemeral anywhere).
  //
  // No rodb readiness gate here: the category menu always posts. Three of the
  // four categories (Hoppy / Guild Banquet / Scholar) run from bundled banks and
  // work with the game database offline; only the jumble category needs rodb, and
  // it fails gracefully at pick time if the DB is down (see routeCategorySelect).
  async execute(interaction) {
    const raw = interaction.options.getInteger('questions');
    const questions = raw == null ? DEFAULT_QUESTIONS : clampQuestions(raw);

    await engine.startGame(interaction, { questions });
  },

  // Exported for unit/simulation testing (ignored by the command loader).
  clampQuestions,
};
