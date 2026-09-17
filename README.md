# Kaido Follow

Professional hybrid Android application with two independent APK editions:

- **Kaido Follow User** — `com.kaido.follow`
- **Kaido Follow Admin** — `com.kaido.follow.admin`

## What is included

- Android hybrid wrapper using WebViewAssetLoader and local app assets.
- Separate User/Admin launcher identities and icons.
- Firebase Auth + Firestore realtime data.
- Secure Firebase Functions backend for provider APIs and financial operations.
- Categories and nested categories.
- Services with provider mapping, min/max, prices and descriptions.
- Order creation with server-side price validation, idempotency and automatic refund path.
- Order status synchronization and scheduled backend sync.
- Wallet transaction ledger.
- Coupon redemption using Firestore transactions.
- Referral codes, referral attachment and earnings transfer.
- User notifications.
- Support chat and ticket close/reopen flow.
- Admin dashboard, users, orders, categories, services, providers, coupons, support, logs and settings.
- Admin balance adjustment with an audit log.
- One-time safe refund logic.
- Custom-claim based Admin/Owner authorization.
- Firestore Security Rules and required composite indexes.
- Android CI workflow and signed release workflow.

## APK build

Debug APKs are built automatically on every push to `main` by `.github/workflows/android-ci.yml`.

Signed release APKs require the permanent release keystore secrets described in `docs/SIGNING.md`. The private signing key is intentionally excluded from this public repository.

## Firebase backend

The web applications expect the backend at:

`https://us-central1-kaido-follow-508df.cloudfunctions.net/api`

Deploy Functions, rules and indexes using `.github/workflows/firebase-deploy.yml` after adding the Firebase service-account secret described in `docs/FIREBASE_SETUP.md`.

## Update safety

Do not change the Android application IDs and do not lose or replace the release keystore after publishing. Future APK versions must increment `versionCode` and be signed using the same release key.
