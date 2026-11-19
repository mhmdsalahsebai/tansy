---
title: "Pwned passwords plugin (`@tansy/pwned-passwords`)"
description: "Refuses a password that has appeared in a known data breach, checked against Have I Been Pwned. Install it and it works; there is nothing to configure."
---

Refuses a password that has appeared in a known data breach, checked against
[Have I Been Pwned](https://haveibeenpwned.com/). Install it and it works; there is nothing to
configure.

```ts
// tansy.config.ts
import { pwnedPasswords } from "@tansy/pwned-passwords";

plugins: [pwnedPasswords()]
```

It is a plugin rather than a core default because a fresh install should not call an outside
service unless someone asked it to.

## 1. What it checks, and when

The plugin fills core's `auth.checkPassword` slot, so every flow where a password is chosen or
changed goes through it:

- signing up,
- changing a password,
- setting one for the first time,
- a password reset, by link or by one-time code,
- an administrator creating a user or setting someone's password,
- `tansy superadmin` and the first-run setup.

A refused password answers `400 PASSWORD_REJECTED` with the message in the language of whoever is
choosing it. The plugin ships that message in English and Arabic, and a password refused this way is
never stored. Core's own length rules under **Settings → Password** apply as well; this is an extra
check, not a replacement.

## 2. What leaves the server

Only the **first five characters of the password's SHA-1 hash**. Have I Been Pwned answers with
every hash suffix in that range, and the comparison happens here. The password itself, the rest of
its hash, the account and the request's address never leave the server, and nothing identifies the
site.

**A failed lookup refuses the password.** If the service cannot be reached or answers with an error,
the password is rejected rather than let through unchecked, so a network problem never quietly turns
the check off.

## 3. Limits to know

- It needs outbound HTTPS from the server. On a network without it, every password choice is
  refused — do not install it there.
- There is no setting, no cache and no way to allow a particular breached password through.
- Existing passwords are not re-checked. Someone whose password was breached after they chose it is
  only stopped when they next change it. There is no "must change at next sign-in" flag either: an
  administrator sets a new password on that person's page under **Dashboard → Users**, which signs
  their sessions out.
- It adds one outside call to each of the flows above. Signing in is untouched, so the cost never
  falls on ordinary traffic.
- A breach check is not a password strength check. Length is core's; complexity rules are not built.
