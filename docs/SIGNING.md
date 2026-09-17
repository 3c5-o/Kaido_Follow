# Release signing

The repository intentionally does **not** contain the private Android signing key because the repository is public.

- Alias: `kaido_follow_release`
- Certificate SHA-256: `D5:3E:76:A7:D2:A8:14:3B:A2:0E:B3:EF:23:0C:2F:13:75:36:0C:24:32:48:7B:9F:3F:5A:33:11:7F:F3:38:AB`
- The same permanent release key signs both product flavors; each flavor has a different application ID, so both can be updated independently.
- The generated keystore is PKCS12. For this signing kit, `KAIDO_KEY_PASSWORD` must use the same value as `KAIDO_STORE_PASSWORD`.
- The private JKS and passwords are distributed separately in the owner's private signing kit and must never be committed.

Required GitHub Actions secrets:

- `KAIDO_KEYSTORE_B64`
- `KAIDO_KEY_ALIAS`
- `KAIDO_STORE_PASSWORD`
- `KAIDO_KEY_PASSWORD`

The CI workflow also creates aligned unsigned release APKs for secure offline signing when repository secrets have not yet been configured.

Never replace or lose the release keystore after publishing an APK. Android updates must be signed with the same key.
