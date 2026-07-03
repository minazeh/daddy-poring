// ---------------------------------------------------------------------------
// voiceStateUpdate — feeds the GvG attendance window capture.
//
// Fires on every voice join/leave/move/mute in the guild (needs the
// GuildVoiceStates intent — added in index.js). Delegates to
// gvg/capture.handleVoiceStateUpdate, which is a synchronous, in-memory
// no-op unless a GvG capture window is currently open, so this handler costs
// nothing outside GvG times. Errors never propagate — voice tracking must not
// crash the client.
// ---------------------------------------------------------------------------

const { Events } = require('discord.js');
const capture = require('../gvg/capture');

module.exports = {
  name: Events.VoiceStateUpdate,
  once: false,
  execute(oldState, newState) {
    try {
      if (!capture.hasActiveCaptures()) return; // fast path — no open window
      capture.handleVoiceStateUpdate(oldState, newState);
    } catch (err) {
      console.warn('[voiceStateUpdate] GvG capture handler error:', err?.message || err);
    }
  },
};
