// ---------------------------------------------------------------------------
// Class Quiz Bot — shared constants.
// Ported from inbox/discord-bot/function-2 (Python/discord.py reference).
//
// The source matched channels BY NAME ("knight"/"priest"/"wizard"). Per Conrad,
// we match by hard-coded channel IDs instead (more robust to renames).
// Full 7-class bank live: knight / priest / wizard / assassin / blacksmith /
// gunslinger / hunter. druid is wired below but has NO question bank yet —
// getRandomQuestion('druid') returns null, so channelQuizLoop warns and exits
// immediately, leaving #druid idle until a druid bank is added to questions.js.
// ---------------------------------------------------------------------------

// 1-hour answer window, in milliseconds.
const QUESTION_WINDOW_MS = 60 * 60 * 1000;

// Active-hours window: quiz only STARTS a new question during [11:00, QUIZ_ACTIVE_END_HOUR) GMT+7.
// Uses the shift-then-UTC technique (UTC getters on a shifted Date) so results are
// independent of the host machine's local timezone.
const GMT7_OFFSET_MIN = 420;           // UTC+7, no DST — 7 * 60
const QUIZ_ACTIVE_START_HOUR = 11;     // 11:00 AM GMT+7 (inclusive)
// Go-live window: 11:00 AM–7:00 PM GMT+7 (same-day). isActiveHour() also supports a
// midnight-crossing window when END <= START (used during testing); here END=19 > START=11
// takes the same-day branch.
const QUIZ_ACTIVE_END_HOUR   = 19;     // 7:00 PM GMT+7 (exclusive)

// channelKey -> Discord channel ID. Keys must match bank keys in questions.js
// (or return null from getRandomQuestion to idle gracefully).
// druid: channel wired, NO bank yet — loop will warn and skip until questions added.
const QUIZ_CHANNELS = {
  knight:      '1518082531797368922',
  priest:      '1518082566509432904',
  wizard:      '1518082600302940230',
  assassin:    '1518082757425762435',
  blacksmith:  '1518082722852114564',
  hunter:      '1518082636663488532',
  gunslinger:  '1518082820151574630',
  druid:       '1518280099043217508', // NO bank yet — idles gracefully
};

// Single leaderboard channel for the live, self-updating standings message.
const LEADERBOARD_CHANNEL_ID = '1519631947070963793';

// customId namespace. The quiz:* prefix is unique across the bot (won't collide
// with partyfinder/officerapp/guildapp), so route() can claim it safely.
const IDS = {
  // quiz:answer:<LETTER>   e.g. quiz:answer:A
  ANSWER_PREFIX: 'quiz:answer',
};

const LETTERS = ['A', 'B', 'C', 'D'];

module.exports = {
  QUESTION_WINDOW_MS,
  QUIZ_CHANNELS,
  LEADERBOARD_CHANNEL_ID,
  IDS,
  LETTERS,
  GMT7_OFFSET_MIN,
  QUIZ_ACTIVE_START_HOUR,
  QUIZ_ACTIVE_END_HOUR,
};
