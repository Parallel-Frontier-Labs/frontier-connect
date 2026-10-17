# Security

## Reporting a vulnerability

Email **security@parallelfrontier.io** with a description, steps to reproduce and the affected
version or commit. Please do not open a public issue for security reports.

We aim to acknowledge reports within two business days and will keep you updated until the issue
is resolved. We ask that you give us reasonable time to fix an issue before disclosing it.

## Scope

- The task card in this repository.
- The hosted Frontier MCP server at `api.parallelfrontier.io` and its sign-in flow.

Do not test against other customers' accounts or data, and do not run denial-of-service or
social-engineering tests.

## How this repository is protected

- CI runs the test suite and a secret scan over the full git history and the built card.
- The built card is one self-contained HTML file with no external scripts or stylesheets.
- Runtime dependencies are kept to a minimum and audited in CI.

## Contributions

Issues are welcome. We are not accepting pull requests yet.
