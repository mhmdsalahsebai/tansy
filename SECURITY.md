# Security policy

Tansy runs with full access to a site's content, users and settings, so security reports come first.

## Reporting a vulnerability

**Don't open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: **Security → Report a vulnerability** on
[the repository](https://github.com/mhmdsalahsebai/tansy/security/advisories/new). If you can't use
GitHub, email mohamedsalahsebai@gmail.com with "tansy security" in the subject.

Please include:

- the version, and whether it was SQLite or Postgres
- what an attacker needs first (no account, a reader, an editor, a plugin author…)
- the steps to reproduce it, or a proof of concept
- what they can do once it works

## What happens next

- You get a reply within **3 working days** saying the report was received.
- Within **10 working days** you hear whether it's confirmed and how serious it is.
- The fix is developed in a private fork and released with a GitHub security advisory and an
  entry in [CHANGELOG.md](CHANGELOG.md) that says what to do. You're credited unless you'd rather
  not be.
- Please give us **90 days**, or until the fix is released if that comes first, before
  publishing details.

## Supported versions

Tansy is beta software. Before 1.0, only the **latest release** gets security fixes, so upgrade to
it first. From 1.0, the latest minor release of the current major version will be supported.

## Scope

In scope: the `tansy` package, `create-tansy`, and every `@tansy/*` plugin and theme published
from this repository, including the dashboard, the API, authentication, permissions and the
generated files.

Out of scope:

- third-party plugins and themes. Report those to their authors
- a site's own configuration, such as a weak `BETTER_AUTH_SECRET`, local uploads allowed in
  production, or a superadmin handing out permissions
- denial of service through volume alone, and findings from automated scanners with no
  working exploit
- the public demo, which is reset regularly. Report a bug in the code behind it, not the data in it

The rules every change has to keep are in [the security model](docs/contributing/security-model.md).
