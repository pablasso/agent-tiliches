# Native Pi MCP

Requires Pi with built-in MCP support (tested with 1.0.0). This package supplies
workflow skills and a credential-free [configuration example](../config/mcp.example.json),
not an MCP client, proxy, or replacement `/mcp` extension. Installing the package
does not configure servers automatically.

Merge the example's server entries into **`~/.pi/agent/mcp.json`**, preserving any
unrelated servers/settings. Keep personal configuration outside repositories and
mode `600`. Never put personal tokens in `.pi/mcp.json` or in endpoint URLs.

## shadcn.io Pro

Endpoint: `https://www.shadcn.io/api/mcp`. Authentication uses a static Pro token
in an `Authorization` header, not an OAuth login. Pi's native `!command` header
resolver reads `~/.pi/agent/mcp-secrets/shadcnio-token` privately. Never run that
resolver as an agent tool call or paste its output into a session.

For a fresh setup, enter the token directly in your own terminal with masked
input. Do not pass it as a CLI argument or put it in shell startup files:

```sh
python3 - <<'PY'
import getpass, os, re, tempfile
from pathlib import Path
with open('/dev/tty', 'r+') as tty:
    token = getpass.getpass('shadcn.io Pro token (hidden): ', stream=tty).strip()
if not re.fullmatch(r'[A-Za-z0-9._~-]{16,512}', token):
    raise SystemExit('Expected a URL-safe token, not a URL or command')
directory = Path.home() / '.pi/agent/mcp-secrets'
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
directory.chmod(0o700)
fd, staging = tempfile.mkstemp(dir=directory)
try:
    with os.fdopen(fd, 'w') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(token + '\n')
    os.replace(staging, directory / 'shadcnio-token')
finally:
    Path(staging).unlink(missing_ok=True)
PY
```

### Credential-bearing tools are unavailable

The server has `exposure: "hidden"` and exact `codemode` overrides for 13 reviewed
tools. In live tests their representative results did not contain the token.
Both `get_install_command` and `get_icon` return authenticated install URLs and
remain hidden; future tools are hidden by default too. Icon search remains
available, but MCP icon-source retrieval is intentionally unavailable.

This is **prevention, not redaction**. Native Pi does not generically redact
server output, including structured results, logs, progress, and saved large
results. The allowlist is not a sandbox or a guarantee against an upstream
behavior change. Never widen it without reviewing the results privately. If the
server starts returning tokens from an allowed tool, disable it and rotate the
token; supporting such a tool safely requires redaction before Pi receives it.

A hidden server also prevents native resource tools from becoming an alternate
route to this server's content. Do not replace the server default with
`codemode`, `deferred`, or `direct` just to make discovery easier.

## Linear

Endpoint: `https://mcp.linear.app/mcp`. Native OAuth configuration requests
`read write` only. For a fresh grant, run this in your own terminal:

```sh
pi mcp login linear
```

Select the intended workspace; cancel if admin or broader scopes are requested.
Pi stores and refreshes the grant in `~/.pi/agent/mcp-auth.json` (mode `600`),
separately from model-provider `auth.json`. Do not print either credential file.
Existing grants can be migrated privately while preserving the original client
registration, scope, refresh token, and absolute expiry; never copy just an
access token into a static header and lose refresh support.

The [Linear skill](../skills/linear/SKILL.md) requires a concrete preview and
explicit confirmation before every write or bounded batch, with no inferred
team/project or administrative operations. These instructions are not an
enforced permission gate: native MCP does not automatically confirm mutations.

## Verify and use

```sh
pi mcp list
```

Then run `/reload` in existing sessions and inspect `/mcp`. Use `/skill:shadcn`
or `/skill:linear` for explicit workflow guidance. The default exposure uses
`codemode` discovery (`searchTools`, `describeTool`, `describeNamespace`); tools
can also be discovered with `tool_search` when available.

Read-only acceptance checks:

- shadcn: `whoami` reports `isPro: true`; search, inspect a `premium: true` item,
  and retrieve non-empty `files[].content`. Verify the two credential-bearing
  tools are unreachable and no new tool is implicitly exposed.
- Linear: `get_user({ query: "me" })` and `list_teams({ limit: 1 })` succeed.
  Confirm write tools are advertised without invoking them. Check that expired
  access tokens can refresh without broadening scope.

No component installation, test issue, comment, or other remote mutation is
needed. Local `npm run check` tests the example and skill contracts with synthetic
data only; it does not contact either service or verify subscriptions.

## Legacy cleanup

After successful native verification, remove the old machine-local shadcn
launcher and the duplicate global Linear skill, uninstall the global MCPorter
package, and remove its configuration/credential state only after checking for
other consumers. The native package skills remain useful; they are not legacy
connectors. Keep one shadcn token copy under Pi, and leave unrelated OAuth grants
and Pi's model credentials untouched. Historical connector source in another
repository is not loaded by this setup and need not be modified.
