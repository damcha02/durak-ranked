# Durak Ratings — physical Durak, digital rankings

A mobile-first Progressive Web App (PWA) for iOS, Android and desktop. **The physical card game is not simulated.** The app tracks tables, result votes, four mode-specific Elo ratings, friend groups, and player statistics.

> Status: **implementation starter / pre-production alpha**. This is real source code and SQL, not a deployed or end-to-end verified application. Tests of schema, SQL functions, authentication providers, and multi-phone concurrency must be run against a real Supabase project before use with friends. Do not open it to the public before the security checklist in `docs/ARCHITECTURE.md` is completed.

## Stack

- React 19 + TypeScript + Vite; installable PWA; responsive mobile UI.
- Cloudflare Pages static hosting (or any static host).
- Supabase Auth (email/password, Google, optional Apple).
- Supabase PostgreSQL with RLS, transaction-backed RPCs, server-side votes and Elo.
- Supabase Realtime Postgres Changes (initial version) + fallback refresh polling.
- SQL migrations in `supabase/migrations`; no frontend `service_role` key.

## Game modes

| Mode | Decks | Players | Physical games per round |
|---|---|---|---|
| Natural Durak **(default)** | One | 3–8 | 1 |
| Double Single | Two, combined | 3–16 | 1 |
| Single Double | Two separate, parallel | 3–8 | 2 |
| Double Double | Four; two per parallel game | 3–16 | 2 |

Parallel-mode result entry is **sequential**: Game 1 first, then Game 2. Both physical games finish before voting opens. Each confirmed result affects its mode's rating independently.

## Quick start

Requires Node.js 20+, npm and an owned Supabase project. The source alone cannot create the Supabase project or configure OAuth for you.

1. Create a Supabase project on https://supabase.com/dashboard.
2. Apply migration files **in filename order** using the Supabase CLI (`supabase db push` after linking) or Supabase SQL Editor. Using the CLI ensures migrations are tracked. Review SQL before applying it: it creates policies/functions and an Auth trigger.
3. In Supabase **Authentication → Providers**, enable Email; configure Google OAuth if desired. Apple OAuth is optional and normally requires Apple Developer Program membership. In **Authentication → URL Configuration**, set your site URL and add dev and production redirect URLs (`http://localhost:5173/**`, `https://your-site.pages.dev/**`).
4. Copy `.env.example` to `.env` and supply your Supabase **project URL** and **publishable key**. Never use your secret service-role key in the Vite environment.
5. `npm install` then `npm run dev`. Browse `http://localhost:5173`.
6. Create three accounts, join the same table, start Natural Durak, record a result, and check rating updates.
7. For deployment, build with `npm run build`. On Cloudflare Pages, connect the repository, set build command `npm run build` and output directory `dist`, and set the two `VITE_...` environment variables. `public/_redirects` supports SPA navigation.

### Configuration required for a public release

- Configure a custom SMTP service for email confirmations/password resets; Supabase's default email service is for limited testing.
- Configure allowed Auth redirect URLs and enabled OAuth providers.
- Test RLS isolation with at least 3 signed-in accounts, including an outsider.
- Check that custom SQL RPCs execute successfully and expected Postgres publications exist.
- Add database backups and monitoring. Supabase Free is not an uptime guarantee and can pause after low activity.
- Implement rate limiting/abuse protection on table creation, joining, profile names and voting endpoints before public traffic.
- Test all 24-hour correction edge cases and concurrent confirmation/revoting.

## Free project pausing

Supabase **Free** can pause after seven days of low database activity. The optional Cloudflare scheduled Worker under `cloudflare/` makes two low-privilege database reads daily. This *may* reduce the likelihood of a pause; it is **not guaranteed**. If predictable availability is non-negotiable, switch to Pro or migrate the storage/auth layer to an always-available alternative. Official policy: https://supabase.com/docs/guides/platform/free-project-pausing

To deploy the optional Worker:

1. Create a separate Cloudflare Worker using `cloudflare/worker.js` and `cloudflare/wrangler.toml` (working directory `cloudflare`).
2. Configure `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` as Worker secrets/variables. Use only the publishable key.
3. Deploy with `npx wrangler deploy`, after authenticating with your own Cloudflare account.
4. Monitor Worker logs, and check Supabase dashboard notifications. A successful heartbeat does not guarantee the platform won't pause.

## Commands

- `npm run dev` — local frontend
- `npm run build` — type-check and build static output
- `npm run test` — pure TypeScript rating-math unit tests

No databases, Supabase accounts, domains, or Cloudflare services have been provisioned by this repository itself.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for data model, workflows, security boundaries, scaling strategy, and known blockers.
