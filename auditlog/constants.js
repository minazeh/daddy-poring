// ---------------------------------------------------------------------------
// Server audit-log feature — shared constants.
//
// ALL audit-log events (member, role, message, channel, server-config, and the
// bot's own app-specific systems) fire into ONE channel. Edit the channel ID
// here in one place if it ever moves.
// ---------------------------------------------------------------------------

// #server-log (single firehose destination for every audit event).
const AUDIT_LOG_CHANNEL_ID = '1518628915625722090';

// Color scheme — category-coded so the single-channel firehose stays scannable.
//   GREEN  → join / add / create / restore (positive lifecycle)
//   RED    → leave / kick / ban / delete / remove (negative lifecycle)
//   BLUE   → edit / config change
//   GOLD   → role changes (member roles + role CRUD)
//   PURPLE → app-specific (kudos, roster/party, job ads) — the bot's OWN systems
//   ORANGE → moderation-neutral (timeout applied, automod triggered)
//   GREY   → misc / unknown actor / fallback
const COLORS = {
  GREEN:  0x2ecc71,
  RED:    0xe74c3c,
  BLUE:   0x3498db,
  GOLD:   0xf1c40f,
  PURPLE: 0x9b59b6,
  ORANGE: 0xe67e22,
  GREY:   0x95a5a6,
};

module.exports = {
  AUDIT_LOG_CHANNEL_ID,
  COLORS,
};
