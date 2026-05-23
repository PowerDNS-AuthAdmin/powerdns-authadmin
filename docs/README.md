# PowerDNS-AuthAdmin documentation

Practical, task-oriented guides for installing, configuring, and operating
PowerDNS-AuthAdmin — a self-hosted DNS administration UI for PowerDNS
Authoritative.

New here? Start with the **[Quickstart](./01-QUICKSTART.md)** — a running stack with
demo zones in about two minutes — then come back for the production guides.

## Guides

| Guide                                            | Read it when you want to…                                     |
| ------------------------------------------------ | ------------------------------------------------------------- |
| [Quickstart](./01-QUICKSTART.md)                 | Try the app end-to-end on a throwaway stack.                  |
| [Installation](./02-INSTALLATION.md)             | Run it for real — SQLite or Postgres, TLS, backups, upgrades. |
| [Configuration](./03-CONFIGURATION.md)           | Look up an environment variable and what it does.             |
| [Connecting PowerDNS backends](./04-BACKENDS.md) | Wire up primaries, secondaries, and clusters.                 |
| [OIDC single sign-on](./05-OIDC.md)              | Set up SSO with group → role mapping.                         |
| [First-boot provisioning](./06-PROVISIONING.md)  | Bring up a fully-configured install from one YAML file.       |
| [Roles & permissions (RBAC)](./07-RBAC.md)       | Understand who can do what, and scope it.                     |
| [Hardening & best practices](./08-HARDENING.md)  | Lock down a production deployment.                            |
| [Upgrading](./09-UPGRADING.md)                   | Move to a new version safely.                                 |
| [Troubleshooting](./10-TROUBLESHOOTING.md)       | Fix a startup error or a backend that won't connect.          |

## Reference

| Reference                                                      | What it is                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`docs/FEATURES.md`](./FEATURES.md)                            | The full feature catalog with module pointers.                         |
| [`docs/dev-setup.md`](./dev-setup.md)                          | Local development workflow (HMR, tests, migrations).                   |
| [`docs/adr/`](./adr/)                                          | Architecture Decision Records — _why_ the codebase is shaped this way. |
| [`../.env.example`](../.env.example)                           | Every environment variable, annotated.                                 |
| [`../provisioning.example.yaml`](../provisioning.example.yaml) | Exhaustive provisioning template.                                      |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md)                     | Code standards, testing, security, perf budgets.                       |
| [`../SECURITY.md`](../SECURITY.md)                             | Vulnerability reporting policy.                                        |

## Getting help

- **Bug or feature request:** [open an issue](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/issues).
- **Security vulnerability:** follow [`SECURITY.md`](../SECURITY.md) — please don't file a public issue.
