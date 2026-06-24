const { Events } = require('discord.js');
const db = require('../kudos/db');

const KUDOS_TRIGGER = /^\s*kudos\b/i;
const REASON_MAX = 300;

// Strip the leading "kudos" keyword and all user mentions from the raw content,
// leaving the free-text reason (trimmed, capped). Returns null if empty.
function extractReason(content) {
  let text = content.replace(KUDOS_TRIGGER, ' ');      // drop the leading "kudos"
  text = text.replace(/<@!?\d+>/g, ' ');               // drop user mentions
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, REASON_MAX);
}

// Unique recipients = mentioned users minus the author and minus bots.
function resolveRecipients(message) {
  const seen = new Set();
  const recipients = [];
  for (const user of message.mentions.users.values()) {
    if (user.id === message.author.id) continue; // no self-kudos
    if (user.bot) continue;                       // no bot kudos
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    recipients.push(user);
  }
  return recipients;
}

module.exports = {
  name: Events.MessageCreate,
  once: false,
  async execute(message) {
    // Ignore bots, system messages, and DMs (no guild).
    if (message.author?.bot) return;
    if (!message.guild) return;
    if (typeof message.content !== 'string') return;

    // Only react to "kudos ..." with at least one user mention.
    if (!KUDOS_TRIGGER.test(message.content)) return;
    if (!message.mentions?.users || message.mentions.users.size === 0) return;

    // Graceful degradation — kudos not configured.
    if (!db.isReady()) {
      try {
        await message.reply('Kudos system isn’t configured yet — ask an admin.');
      } catch { /* ignore */ }
      return;
    }

    const recipients = resolveRecipients(message);

    if (recipients.length === 0) {
      // Either they only @'d themselves, or only bots.
      const mentionedSelf = message.mentions.users.has(message.author.id);
      if (mentionedSelf) {
        try { await message.reply("You can't give yourself kudos 😄"); } catch { /* ignore */ }
      }
      // only-bots / nothing actionable -> ignore silently
      return;
    }

    try {
      const givenToday = await db.countGivenToday(message.author.id);
      const remaining = db.DAILY_LIMIT - givenToday;

      if (remaining <= 0) {
        await message.reply(
          "⚠️ You've used all 7 kudos today — resets at midnight (GMT+7).",
        );
        return;
      }

      const reason = extractReason(message.content);

      // Award to the first `remaining` recipients; the rest are capped out.
      const awarded = recipients.slice(0, remaining);
      const skipped = recipients.slice(remaining);

      for (const user of awarded) {
        await db.award(message.guild.id, message.author.id, user.id, reason);
      }

      const remainingAfter = remaining - awarded.length;
      const awardedMentions = awarded.map(u => `<@${u.id}>`).join(' ');
      let reply = `🙌 +1 kudo to ${awardedMentions}! (${remainingAfter} left today)`;
      if (skipped.length > 0) {
        const skippedMentions = skipped.map(u => `<@${u.id}>`).join(' ');
        reply += `\n⚠️ Couldn't give to ${skippedMentions} — that would exceed your daily limit of 7.`;
      }

      await message.reply({
        content: reply,
        // Ping the recipients (encouragement); never @everyone/roles.
        allowedMentions: { users: awarded.map(u => u.id) },
      });
    } catch (err) {
      console.warn('[kudos] Failed to process kudos message:', err?.message || err);
      try {
        await message.reply('Something went wrong recording that kudo — please try again in a moment.');
      } catch { /* ignore */ }
    }
  },
};
