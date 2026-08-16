// ---------------------------------------------------------------------------
// Shared constants for the /petition feature.
//
// Deliberately STATELESS — no Mongo, no in-memory store, nothing to persist.
// The button's customId is static and the modal carries everything the handler
// needs, so a signature submitted after a redeploy behaves identically to one
// submitted a second after the panel was posted. Nothing to resume, nothing to
// degrade: unlike the ticket system, this feature has no "unavailable" state.
// ---------------------------------------------------------------------------

// customId namespace. Both are STATIC — see the note above.
const IDS = {
  SIGN_BUTTON: 'petition:sign',
  MODAL:       'petition:modal',
};

const FIELDS = {
  SUBJECT: 'subject',
  MESSAGE: 'message',
};

// Role permitted to run /petition. Same Godfathers role that gates
// /guildsupport, /activitycampaign and /gvgschedule — the panel signs off as
// "All the Godfathers", so it should only be postable by one.
const GODFATHERS_ROLE_ID = '1518076150692188200';

// Signatures land here.
const SIGNATURE_CHANNEL_ID = process.env.PETITION_CHANNEL_ID || '1538405902753734796';

// Modal caps.
const SUBJECT_MAX = 100;
const MESSAGE_MAX = 1000;

const COLORS = {
  PANEL:     0x2b2d31,
  SIGNATURE: 0x2ecc71,
};

// ---------------------------------------------------------------------------
// Copy. Conrad's, supplied verbatim 2026-08-16.
//
// ⚠️ PLACEHOLDER — Conrad's text contains the literal "(paste link)". The form
// URL was not supplied. Set FORM_URL below and it is substituted into the body;
// leave it null and the line renders exactly as he wrote it, placeholder and
// all, rather than silently dropping the sentence.
// ---------------------------------------------------------------------------

const FORM_URL = null;   // e.g. 'https://forms.gle/xxxxxxxx'

const PANEL_TITLE = '[PETITION FOR SOLAR — GUILD EMERGENCY]';

const PANEL_BUTTON_LABEL = 'Sign the Petition';

// The bullets are rendered as a markdown list; in Conrad's text they were
// newline-separated lines. Wording untouched.
const PANEL_BODY = [
  '**TL;DR:** Please sign the petition asking Solar to return as Godfather. It takes 1 minute. ' +
  'He’s given us thousands of hours, we can give him 60 seconds',
  '',
  'Greetings everyone!',
  '',
  "It's been a great run for our guild, competitive targets hit in GL, Polarity, and more. " +
  "Sure, we have things to improve on, but none of our success would've happened without you, " +
  'and without leaders like Solar and Dopey.',
  '',
  'Today we’re asking for a favour',
  '',
  "Solar has stepped down as Godfather. He's burnt out from running an entire guild, vetting " +
  'every recruit, building all our systems, AND maxing his own character. The WOK results were ' +
  'probably the last straw.',
  '',
  'A brief recap of the work he’s done for us so far:',
  '',
  '• Invented the Pillars System so guild work gets shared',
  '• Personally vetted every member, including running a whole 5v5 internal PvP event just to ' +
  'pick the main field members',
  '• Managed transfers between Daddy and Mommy without a single custody dispute',
  '• Built Discord automations that made operations smoother',
  "• Poured time and money into his character so he'd never show up to an event at less than 100%",
  '',
  "So here's the plan: sign the petition for his return and drop a few words of encouragement. " +
  'We\'ll compile it all into one big "please come back, we miss you (and also nothing works ' +
  'without you)" package and deliver it to him.',
  '',
  '__FORM_LINE__',
  '',
  "It's a game, and games should be fun. Solar made ours more fun. Let's return the favour?",
  '',
  'Yours sincerely,',
  'All the Godfathers.',
].join('\n');

// Substitute the form line depending on whether a URL has been supplied.
function panelDescription() {
  const formLine = FORM_URL
    ? `Form is here: ${FORM_URL} — takes 1 minute, 2 questions, or DM me your message if you prefer.`
    : 'Form is here (paste link), takes 1 minute, 2 questions, or DM me your message if you prefer.';
  return PANEL_BODY.replace('__FORM_LINE__', formLine);
}

// Whether the panel still carries the unfilled placeholder — used to warn the
// poster rather than let it go out unnoticed.
function hasUnfilledFormLink() {
  return !FORM_URL;
}

module.exports = {
  IDS,
  FIELDS,
  GODFATHERS_ROLE_ID,
  SIGNATURE_CHANNEL_ID,
  SUBJECT_MAX,
  MESSAGE_MAX,
  COLORS,
  FORM_URL,
  PANEL_TITLE,
  PANEL_BUTTON_LABEL,
  PANEL_BODY,
  panelDescription,
  hasUnfilledFormLink,
};
