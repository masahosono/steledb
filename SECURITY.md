# Security Policy

## Supported versions

steledb is pre-1.0. Fixes land on the latest published minor, and there are no backports.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability

Please report privately through GitHub's [private vulnerability reporting](https://github.com/masahosono/steledb/security/advisories/new) rather than opening a public issue.

Include the version, a description of the impact, and the smallest schema or request that reproduces it. You can expect an acknowledgement within a week; once a fix is published the advisory is made public with credit unless you prefer otherwise.

## What is and is not in the threat model

**The core (`steledb`) does not read files, spawn processes or evaluate strings.** Data arrives as already-parsed arrays, and `validate()` walks it structurally. Schemas are TypeScript modules written by the project that owns them, so a schema is code and is trusted as such — `checks` are plain functions and run with the privileges of the host process.

**`steledb/node` reads the filesystem** through paths derived from schema table keys and the `dataDir` you pass, resolved with `fileFor` when supplied. Table keys come from your own schema, not from the data, so a malicious data file cannot redirect a read.

**`steledb studio` is a local development tool and nothing else.** It opens a writable HTTP server over your data directory. Three things guard it:

- the server binds to `127.0.0.1` only, never `0.0.0.0`
- every `/api` call must present a token generated fresh at each startup, delivered in the URL fragment so it stays out of shell history and server logs
- a `Host` header check blocks DNS rebinding — a page on the open internet can resolve a name to `127.0.0.1`, but it cannot forge the `Host` header the browser sends

It is still not built to be exposed. Do not forward its port, run it on a shared or multi-user host, or put it behind a tunnel. Use `--read-only` when you only need to look.

**The CLI executes your schema file.** `steledb check` and `steledb studio` import the `--schema` path, which runs that module. Pointing them at a file you did not write is equivalent to running it.

## Out of scope

- The `example/` project and `src/testing/` fixtures, which are illustrative and not published (`files: ["dist"]`)
- Denial of service from deliberately pathological schemas or data in your own repository
- Anything that requires an attacker to already be able to run code as your user
