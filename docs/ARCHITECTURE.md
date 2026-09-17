# Kaido Follow architecture

## Android packages

- User: `com.kaido.follow`
- Admin: `com.kaido.follow.admin`

Both APKs are built from one Android module using product flavors. They use different launcher icons and different embedded web applications.

## Security boundary

The Android/WebView clients never receive provider API secrets. Provider metadata lives in `providers`, while keys live in `providerSecrets`, which Firestore Rules deny to every client. Firebase Functions uses the Admin SDK to read provider secrets.

Sensitive operations are server-side:

- create provider order
- order synchronization
- coupon redemption
- referral transfer
- provider balance/test
- admin balance adjustment
- refunds

## Firestore collections

`users`, `categories`, `services`, `providers`, `providerSecrets`, `orders`, `walletTransactions`, `coupons`, `couponRedemptions`, `notifications`, `chats`, `settings`, `admins`, `adminLogs`.

## Admin authorization

The first owner signs in with the configured owner email and calls `/bootstrap-owner`. The Function sets Firebase Auth custom claims: `admin=true`, `role=owner`. Firestore Rules then enforce admin-only writes.
