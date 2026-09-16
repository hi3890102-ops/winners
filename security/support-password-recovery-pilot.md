# Support password recovery and administrator Auth pilot

Staging only. This replaces the pre-issued recovery-key user flow.

## User flow

1. On **비밀번호를 잊으셨나요?**, enter the username and store name. HQ accounts enter `본사`.
2. The response is intentionally identical whether an account matches or not.
3. A linked store owner may review requests only for that store's staff or managers. A platform support/admin role may review eligible requests across the platform.
4. After real-world identity confirmation, the reviewer issues a six-digit code. Only its SHA-256 hash is stored. The plaintext code is shown once and expires in 15 minutes.
5. The user enters the username, code and a new password. The server consumes the code before changing only the resolved Auth identity. Existing profile, store membership, crew and attendance IDs stay unchanged.

The reviewer never chooses or sees the new password. Store participation codes cannot reset passwords. Five failed code attempts invalidate a code. Issuing a new request expires earlier pending or issued requests.

## Administrator Auth

The administrator build signs in through Supabase Auth and derives HQ or franchise authority from `platform_admins` and `franchise_memberships`. The single active staging owner identity is linked as the first staging `super_admin`, using the password already chosen by that user. The shared PIN and legacy franchise password paths are not used by the staging administrator build.

The current phase disables legacy browser writes for franchise account creation, store deletion and ownership edits in the Auth administrator build. Those controls need dedicated Auth management APIs before they are re-enabled.

## Limits

- SMS delivery remains deferred until the business registration and provider setup are ready.
- During the pilot, identity confirmation and code delivery happen by phone, KakaoTalk or in person outside the app.
- An HQ super administrator who is the only administrator still needs database support if locked out. Add a second verified super administrator before launch.
- This pilot does not change production `main` or the production Supabase project.
