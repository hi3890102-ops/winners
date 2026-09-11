# Manee staging environment

Production project: `bhwuuxcrzxespkjlmqxr` (`staff`).
Staging project: `obpkzecgswnfuyhwvncd` (`manee-staging`), separate Database/Auth/Edge Functions.

Netlify's `deploy-preview` and `branch-deploy` contexts build against staging. Only
an explicit `production` context on `main` can build against production. Missing
or inconsistent configuration fails the build or client initialization. Public
configuration contains publishable keys only.

The publish directory is `dist`; it contains the selected `app-config.js`, HTML,
manifest, icons and service worker. It does not include the configuration for the
other environment, development scripts or administrator HTML.

Staging uses separate Auth and legacy localStorage namespaces. The page displays
`테스트 환경`; production data and credentials were not copied. Existing preview
tabs must be closed/reloaded to get the new connection. Create a new test account.

Staging push subscription changes, old service-worker push display, push sending,
scheduled reservation notifications, AI questions and receipt recognition are
disabled until their separate integration settings are configured. The server
guard runs before environment secrets, database access or outbound calls. It
does not take environment selection from client input.

The staging schema was copied as definitions only. No employee, attendance,
owner identity, Auth password, push subscription or stored image was copied.
All 26 staging tables have RLS enabled. Three previously unprotected tables have
explicit `staging_legacy_compatibility` policies to preserve existing test behavior;
the remaining legacy permissive policies also still need the later RLS rollout.
Environment isolation does not mean the authorization redesign is finished.

The current signup/login Edge source was deployed to staging. The staff Auth
link/owner-approval pilot is now implemented in security-v2 for the user preview.
See `staff-auth-pilot.md` and `staff-auth-release.json` for its scope and validation.

Checks:

```bash
node --test security/environment-isolation.test.mjs security/session-foundation.test.mjs
CONTEXT=deploy-preview node scripts/build-environment.mjs
python3 scripts/build-variants.py --output /absolute/path/outside/this/repository
```

Administrator HTML is generated from the same source but its repository has not
been deployed in this change. Preserve its separate entry behavior. For a later
production release, review application changes and database migrations together;
do not copy staging records or merge Supabase projects. Stage backwards-compatible
database changes before the approved frontend deployment.

Rollback: do not blindly revert the preview to the previous commit, because that
would reconnect it to production. Keep the isolated configuration and repair the
affected feature, or disable the preview until repaired. Production main remains
untouched by this rollout.
