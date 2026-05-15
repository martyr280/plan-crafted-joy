# Plan: Nelson AI rebrand + user management

## 1. Rebrand "Ned AI" → "Nelson AI"

Keep the existing auth left-rail marketing copy ("Operations, unified." + paragraph) — only swap the wordmark/name.

- `src/routes/__root.tsx` — title + meta/OG/Twitter strings
- `src/routes/auth.tsx` — header lockup, footer, "Sign in to …" copy
- `src/components/layout/AppSidebar.tsx` — sidebar header text
- Generate a new `src/assets/nelson-ai-logo.png` (navy square, "Nelson AI" wordmark, orange swoosh — same NDI palette as current logo) and replace imports of `ned-ai-logo.png`. Delete the old asset.
- Sweep `rg -i "ned ai|ned-ai"` after edits to confirm nothing remains.

## 2. User management upgrades

Build on the existing `Settings → Users & Roles` tab (admin-only). Current state: list profiles, toggle role checkboxes, claim-admin fallback.

### New capabilities
1. **Invite user by email** — admin enters email + initial roles, sends a Supabase invite (magic-link style) so they set their own password. Pending invites listed separately until accepted.
2. **Revoke access** — one-click "Remove all roles" (soft revoke; user can no longer access any module) and "Disable user" (hard revoke via auth admin API: bans the user). Both with confirm dialog.
3. **Resend invite / Reset password** — admin-triggered password reset email for an existing user.
4. **Last sign-in column** — surface `auth.users.last_sign_in_at` so admins see stale accounts.
5. **Audit trail** — write to `activity_events` on every invite / role change / revoke / disable, attributed to the acting admin. Surface a small "Recent admin actions" list at the bottom of the tab.

### Backend (server functions, admin-gated)
New file `src/lib/user-admin.functions.ts` — all use `requireSupabaseAuth` + verify caller `has_role('admin')`, then use `supabaseAdmin` for privileged ops:
- `inviteUser({ email, roles[] })` → `supabaseAdmin.auth.admin.inviteUserByEmail(...)` then insert role rows
- `resendInvite({ userId })` / `sendPasswordReset({ email })`
- `revokeAllRoles({ userId })` → delete from `user_roles`
- `setUserDisabled({ userId, disabled })` → `supabaseAdmin.auth.admin.updateUserById(id, { ban_duration: '876000h' | 'none' })`
- `listUsers()` → returns profiles joined with `last_sign_in_at` + `banned_until` from `auth.admin.listUsers()`

Each function logs an `activity_events` row (`event_type: 'admin.invite' | 'admin.role_grant' | 'admin.role_revoke' | 'admin.disable' | 'admin.enable'`).

### Frontend
Refactor `src/routes/_app.settings.tsx` `UsersAndRoles`:
- Add **Invite user** button → dialog with email + role checkboxes
- Add per-row actions menu (kebab): Resend invite, Send password reset, Revoke all roles, Disable/Enable user
- Add **Last sign-in** and **Status** (Active / Disabled / Pending) columns
- Confirm dialogs (`AlertDialog`) for destructive actions
- Recent admin actions card below the table (reads `activity_events` filtered to `event_type LIKE 'admin.%'`)

### DB
No new tables required. Optional: add a `disabled_at` column to `profiles` only if we want to show status without calling auth admin on every load — can skip and rely on `auth.admin.listUsers()` server-side.

## 3. Verification
- After rebrand: visit `/auth` and `/` (sidebar), confirm "Nelson AI" copy + new logo render, no "Ned" string left.
- After user mgmt: as admin, invite a test email, confirm invite row appears + activity event written; toggle roles; disable/enable a user; revoke all.

## Out of scope
- SSO / SCIM provisioning
- Custom branded invite email templates (uses default Supabase invite email; can wire Lovable auth email templates in a follow-up)
