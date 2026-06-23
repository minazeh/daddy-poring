# Discord Bot — Feature Log

> All items below were **built and `node --check`-green** on the dates shown. The bot has not yet been pushed live, so each "Date & Time Deployed" is the **build date** — replace it with the actual deploy time when you restart/redeploy (e.g. `June 24, 2026 11:31 pm`). When the whole bot ships at once, you may instead stamp them all with that single deploy time.

---

Feature/Change: Bot scaffold & infrastructure — discord.js v14 (CommonJS), dynamic command/event loaders, `/ping`, slash commands auto-register on every startup, Railway deploy prep (DEPLOY-RAILWAY.md, .railwayignore, git initialized, .env untracked)
Date & Time Deployed: June 22, 2026

Feature/Change: `/guildapplication` — public "Start Application" button → modal (In-game Name / Playstyle / Previous Guild / Inviter) → posts the application embed; auto-detects the applicant's class from their onboarding role; reviewer-gated 4-button review (Main Guild → Daddy, Second Guild → Mummy, Waiting List, Reject) with ID-based role assignment and generic-polite DMs
Date & Time Deployed: June 22–23, 2026

Feature/Change: Job-Ad & Officer Application (`/jobad`) — leadership-gated; modal (Title + Description) → posts a branded job-ad embed to #job-ad with an Apply button → applicant modal (In-game Name + why-fit) → posts to #officer-applications with Daddy / Mummy / Reject review (leadership-gated); approval assigns the officer role, deletes the job-ad, and DMs the applicant. Replaced the earlier `/officerapplication` + `/openapplication` commands (retired)
Date & Time Deployed: June 23, 2026

Feature/Change: `/memberclasses` — officer-gated, public result; "All" view shows per-class Daddy vs Mummy member counts; per-class view lists member nicknames by group (Daddy / Mummy), length-guarded
Date & Time Deployed: June 23, 2026

Feature/Change: `/help` — open to everyone, ephemeral, role-filtered categories (General / Leadership / Officers); branded embed that lists only the commands the member can actually use
Date & Time Deployed: June 23, 2026

Feature/Change: Welcome-on-join — new members trigger a welcome embed in #welcome (requires the Server Members Intent enabled in the Developer Portal)
Date & Time Deployed: June 23, 2026
