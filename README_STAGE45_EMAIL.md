# Stage 4.5 — Email + username + password

This **replaces** the previous username-only authentication patch. **Do not apply both**. If the old Stage 4.5 patch was already applied, restore your Stage 4 Git commit before using this patch.

## Functionality

- Registration: username, email, password (10+ characters).
- When Supabase **Confirm Email** is disabled, successful signup returns a session immediately and the application opens the dashboard, without a second login.
- Subsequent sign-in: email/password directly via Supabase Auth, or username/password via a small Edge Function that resolves the username to the existing Supabase identity. Supabase Auth still validates all passwords and issues the session.
- Account Settings: username changes; email changes using Supabase Auth; password change after checking the current password.
- Existing users, including `cookie`, remain intact. Existing profile IDs and Elo ratings do not change.

## IMPORTANT security trade-off

Supabase **Confirm Email = OFF** implicitly treats the address as confirmed despite not proving ownership. Someone can register another person's email and recovery workflows may become unreliable or unsafe. This is an explicitly requested testing-stage trade-off, **not** a safer alternative to email confirmation. Re-enable confirmation before public launch.

Keep **Secure email change** enabled. Supabase can send confirmation links on email change; for users with no access to their originally supplied address, secure email change may block the update. Never circumvent it with an unprotected service-role API.

## Installation (stage-by-stage)

1. Make a Git commit of your working Stage 4 app.
2. Unzip the patch into the `durak-rating` directory, where `package.json` lives. It adds only new migration, Edge Function, helper files, tests, and a one-shot Python frontend patch.
3. Run `python apply_stage45_email.py` (or `python3`).
4. Run `npm run test && npm run build`.
5. In Supabase dashboard, go **Authentication → Sign In / Providers → Email** and turn **Confirm Email OFF**. Leave **Secure email change** ON. Email provider must stay enabled.
6. Preview `npx supabase db push --linked --dry-run`; expect only `202610240004_email_username.sql`.
7. Apply `npx supabase db push --linked`.
8. Test registration with a *new* test email and username (e.g., `test_friend1`). The person should land in the dashboard automatically with 4x1200 Elo. Existing `cookie` must still sign in by email/password.
9. Username/password sign-in requires the following Edge Function to be deployed:
   ```bash
   npx supabase functions deploy username-signin --no-verify-jwt --project-ref tujimbnmlpnpampdqpyd
   ```
   The function defaults to allowing browser origins `http://localhost:5173,http://127.0.0.1:5173`. For deployment to a public URL, set `DURAK_ALLOWED_ORIGINS` to the site's exact HTTPS origin through Supabase Function secrets and redeploy.
10. Sign out from the test account and sign in using either email or username with the same password. Try the Profile settings changes.

## Verification

- Existing accounts and ratings intact.
- Case-insensitive duplicate usernames rejected, including after changing username.
- Sign-up automatically logs in when confirmation disabled.
- Both email/password and username/password login reach the same account.
- Refresh/reopen app retains session.
- Username, email, and password changes function according to Supabase Auth settings.
- Service-role key is never placed in a `VITE_` variable or sent to the browser.

## Public launch blockers

- Re-enable email confirmation and configure a real SMTP sender.
- Add abuse defenses (CAPTCHA / Turnstile + gateway rate limits and monitoring), including for standard email signup/login, not just username lookup.
- Verify mail-change flows on live accounts. Review Supabase Authentication security settings.
- Review and test Edge Function login error handling and token lifecycle against your live project.

Supabase docs: https://supabase.com/docs/guides/auth/general-configuration , https://supabase.com/docs/reference/javascript/auth-signup , https://supabase.com/docs/reference/javascript/auth-updateuser
