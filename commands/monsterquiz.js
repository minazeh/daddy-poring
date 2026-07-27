const { SlashCommandBuilder } = require('discord.js');
const rodb = require('../rodb/db');
const engine = require('../monsterquiz/engine');
const {
  DEFAULT_QUESTIONS,
  MIN_QUESTIONS,
  MAX_QUESTIONS,
} = require('../monsterquiz/constants');
const { NOT_AVAILABLE_MSG } = require('../rodb/format');

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
    .setDescription('Start an anagram quiz — unscramble monster, item, and card names from the game database.')
    .addIntegerOption((opt) =>
      opt
        .setName('questions')
        .setDescription(`How many rounds (${MIN_QUESTIONS}–${MAX_QUESTIONS}, default ${DEFAULT_QUESTIONS}).`)
        .setMinValue(MIN_QUESTIONS)
        .setMaxValue(MAX_QUESTIONS)
        .setRequired(false)),

  // Available to EVERYONE. Every reply is public (no ephemeral anywhere).
  async execute(interaction) {
    // Game database must be up to source questions.
    if (!rodb.isReady()) {
      await interaction.reply({ content: NOT_AVAILABLE_MSG, allowedMentions: { parse: [] } });
      return;
    }

    const raw = interaction.options.getInteger('questions');
    const questions = raw == null ? DEFAULT_QUESTIONS : clampQuestions(raw);

    await engine.startGame(interaction, { questions });
  },

  // Exported for unit/simulation testing (ignored by the command loader).
  clampQuestions,
};
