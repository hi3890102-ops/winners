# One-month launch offer

The owner approved the same one-calendar-month free trial for Google Play and
Apple, followed by KRW 9,900 per store per month, VAT included. Each additional
general-plan store costs another KRW 9,900. "30 days" must not replace "1 month".

## This release

- The owner login/signup entry and the first/final signup screens show the launch
  offer. Staff signup has no owner subscription offer.
- Additional-store totals are explained (2 stores: KRW 19,800; 3: KRW 29,700).
- Existing franchise contracts remain separate; a typed franchise code is not
  presented as a verified price or as a successful subscription purchase.
- The screen explains that signup alone does not charge the user and that payment
  registration and paid-conversion consent will be requested separately.
- The existing five-step signup, username availability check, password validation,
  account creation and store preparation continue unchanged.

## Billing work still required

This change is launch-offer UI, not a billing activation. The repository currently
has no native Google Play Billing or Apple StoreKit checkout. It does not collect
card data, calculate a charge date, start a client-side entitlement countdown, or
claim that a payment method has been saved. Do not use a browser checkbox as a
substitute for store-required paid-conversion consent.

Production billing_settings were inspected read-only: default_price=9900,
additional_store_price=4900, default_franchise_price=4900, default_trial_days=40.
These are the existing tracking settings; they have not been migrated by this
release. Existing trials, unlimited-trial flags, contract overrides, and revenue
snapshot history remain intact. Before launch, version the new plan, configure
both stores' actual products/offers, and migrate tracking/entitlements without
shortening an existing subscriber's promised trial. Trial/renewal dates must come
from verified store transactions, with calendar-month and month-end cases tested.

Official references checked on 2026-10-08:

- https://support.google.com/googleplay/android-developer/answer/140504?hl=en
- https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-up-introductory-offers-for-auto-renewable-subscriptions/
- https://support.google.com/googleplay/android-developer/answer/15722617?hl=en
- https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/consent-for-subscription-offer-conversions

## Verification

- Existing signup, login, username-check and interaction suites: 66 passed,
  0 failures. The login test harness includes the actual shared offer renderer.
- Production and staging builds, inline JavaScript syntax and git diff checks passed.
- JSDOM: signup navigation, general/franchise offer, escaped input, one submit
  button, and owner-only login pricing passed without account/payment API calls.
- Real store checkout and real account creation are outside this copy-only release.
  Local browser launching is restricted in this workspace; no screenshot or device
  verification is claimed.
