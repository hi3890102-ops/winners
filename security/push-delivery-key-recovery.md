# Push delivery key consistency — 2026-10-06

An authorized one-device test returned `sent: 0, total: 1`. The subsequent
preflight identified `vapid_client_key_mismatch`: the HTML application-server
public key differed from the sender's environment value. Registration alone
therefore did not establish that a device could receive messages.

All senders now derive the public key from the existing VAPID private signing
key. This preserves the private key and produces a mathematically matched pair,
without depending on a second copied environment value. A GET endpoint publishes
only the derived public key, with no-store caching and the existing staging gate.
The browser uses that endpoint for registration.

Owner refresh checks the subscription's application-server key before reporting
enabled. A mismatched legacy device is removed from that owner's server records
and shown as needing reconnection. The browser subscription is replaced only
when the owner explicitly presses enable; refresh never requests permission or
silently creates a new subscription. Other-account records cannot be removed.

The named-account send keeps store, owner role, authenticated account ID and
subscription ID filters together. Tests confirm that other owners in the same
store are excluded and partial target arguments fail closed. Provider errors
return bounded reason codes without endpoints, encryption keys or raw bodies.

Validation: 626 passed, 9 existing optional skips, 0 failed; inline script syntax
and both environment builds checked. Coverage includes public/private pairing,
public-only configuration output, staging isolation, unavailable configuration,
legacy-key reconnection, account changes, opt-out failures, and exact recipients.
Actual recipient notification is verified separately after production rollout;
a device using a different old signing key requires its owner to reconnect.
