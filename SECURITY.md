# Security

ccmux is a **local-only** proxy. It binds to `127.0.0.1` and never exposes a
network port to other machines.

## Where your credentials live

- **GitHub OAuth token** (`GH_TOKEN` / `GITHUB_TOKEN`): read from your shell
  env, `~/.config/github-copilot/apps.json` (VS Code's Copilot sign-in), or
  obtained via the GitHub device flow. When obtained via device flow it is
  persisted to `~/.config/ccmux/env` with file mode `0600` inside a `0700` dir.
- **Copilot bearer**: short-lived, exchanged from the GitHub token, held only
  in memory for the proxy process's lifetime, refreshed ~2 min before expiry.
- Your token **never leaves your machine** — the proxy only calls
  `api.github.com` and `api.githubcopilot.com` directly from localhost.

## Reporting a vulnerability

Please open a private security advisory:
<https://github.com/dondetir/ccmux/security/advisories/new>, or email the
maintainer via the email on the GitHub profile. Do **not** open a public issue
for security problems.

## Notes

- The proxy does **no client authentication** by design — it ignores the
  client's API key and forwards your Copilot credentials. Because it binds to
  loopback only, only processes on your own machine can reach it. If you run
  other people's code on the same host, treat that as a trust boundary.
- `ccmux` uses Copilot's editor-facing API, which is unofficial and not a
  published security surface. Treat it as a personal convenience tool, not a
  hardened service.
