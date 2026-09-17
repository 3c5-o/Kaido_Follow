# Firebase setup

Project: `kaido-follow-508df`

1. Enable Firebase Authentication -> Email/Password.
2. Create the owner account using the email configured by `OWNER_EMAIL` (default: `Kaido@gmail.com`).
3. Deploy Firestore Rules, indexes and Functions from this repository.
4. Sign in to the Admin APK once. The Admin app will call `bootstrap-owner`, refresh the token, and receive the `owner` claim.
5. Add providers from the Admin app. Provider API keys are stored in `providerSecrets` and are inaccessible from client apps.

For GitHub deployment, add repository secret `FIREBASE_SERVICE_ACCOUNT_KAIDO_FOLLOW` containing a Firebase service-account JSON with deployment permissions, then run the `Deploy Firebase Backend` workflow.
