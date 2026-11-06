<!-- AUTO-GENERATED FILE, DO NOT EDIT. Run `pnpm run build:reference` to regenerate. -->

# mcpc command reference

Complete `--help` output for every `mcpc` command, in the order the commands are listed
by `mcpc --help`. It is generated from the CLI itself, so it always matches the installed
version — run `mcpc help <command>` to get the same text in your terminal.

New to mcpc? Start with the [README](../README.md), or run `mcpc help --skill` for the agent guide.

- [`mcpc connect`](#mcpc-connect)
- [`mcpc close`](#mcpc-close)
- [`mcpc restart`](#mcpc-restart)
- [`mcpc login`](#mcpc-login)
- [`mcpc logout`](#mcpc-logout)
- [`mcpc events-hook`](#mcpc-events-hook)
- [`mcpc supervise`](#mcpc-supervise)
- [`mcpc clean`](#mcpc-clean)
- [`mcpc grep`](#mcpc-grep)
- [`mcpc x402`](#mcpc-x402)
  - [`mcpc x402 init`](#mcpc-x402-init)
  - [`mcpc x402 import`](#mcpc-x402-import)
  - [`mcpc x402 remove`](#mcpc-x402-remove)
  - [`mcpc x402 sign`](#mcpc-x402-sign)
- [`mcpc help`](#mcpc-help)
- [`mcpc @<session>`](#mcpc-session)
  - [`mcpc @<session> close`](#mcpc-session-close)
  - [`mcpc @<session> restart`](#mcpc-session-restart)
  - [`mcpc @<session> grep`](#mcpc-session-grep)
  - [`mcpc @<session> tools-list`](#mcpc-session-tools-list)
  - [`mcpc @<session> tools-get`](#mcpc-session-tools-get)
  - [`mcpc @<session> tools-call`](#mcpc-session-tools-call)
  - [`mcpc @<session> tasks-list`](#mcpc-session-tasks-list)
  - [`mcpc @<session> tasks-get`](#mcpc-session-tasks-get)
  - [`mcpc @<session> tasks-result`](#mcpc-session-tasks-result)
  - [`mcpc @<session> tasks-cancel`](#mcpc-session-tasks-cancel)
  - [`mcpc @<session> prompts-list`](#mcpc-session-prompts-list)
  - [`mcpc @<session> prompts-get`](#mcpc-session-prompts-get)
  - [`mcpc @<session> completion-complete`](#mcpc-session-completion-complete)
  - [`mcpc @<session> resources-list`](#mcpc-session-resources-list)
  - [`mcpc @<session> resources-read`](#mcpc-session-resources-read)
  - [`mcpc @<session> resources-subscribe`](#mcpc-session-resources-subscribe)
  - [`mcpc @<session> resources-unsubscribe`](#mcpc-session-resources-unsubscribe)
  - [`mcpc @<session> resources-templates-list`](#mcpc-session-resources-templates-list)
  - [`mcpc @<session> resources-directory-read`](#mcpc-session-resources-directory-read)
  - [`mcpc @<session> skills-list`](#mcpc-session-skills-list)
  - [`mcpc @<session> skills-get`](#mcpc-session-skills-get)
  - [`mcpc @<session> events-list`](#mcpc-session-events-list)
  - [`mcpc @<session> events-subscribe`](#mcpc-session-events-subscribe)
  - [`mcpc @<session> events-unsubscribe`](#mcpc-session-events-unsubscribe)
  - [`mcpc @<session> events-route`](#mcpc-session-events-route)
  - [`mcpc @<session> events-tail`](#mcpc-session-events-tail)
  - [`mcpc @<session> events-ack`](#mcpc-session-events-ack)
  - [`mcpc @<session> events-status`](#mcpc-session-events-status)
  - [`mcpc @<session> events-deliver`](#mcpc-session-events-deliver)
  - [`mcpc @<session> logging-set-level`](#mcpc-session-logging-set-level)
  - [`mcpc @<session> ping`](#mcpc-session-ping)
  - [`mcpc @<session> server-discover`](#mcpc-session-server-discover)
  - [`mcpc @<session> logs`](#mcpc-session-logs)

## `mcpc`

```text
Usage: mcpc [<@session>] [<command>] [options]

Universal command-line client for the Model Context Protocol (MCP).

Commands:
  connect [<server>] [@session]  Connect to an MCP server and start a new named @session
  close <@session>               Close a session
  restart <@session>             Restart a session (losing all state)
  login <server>                 Log in to a server and save an OAuth profile
  logout <server>                Delete an OAuth profile for a server
  events-hook <event>            Claude Code hook: show pending events (see below)
  supervise                      Keep sessions that receive events connected
  clean [resources...]           Clean up mcpc data (sessions, profiles, logs, all)
  grep <pattern>                 Search tools and instructions across all active sessions
  x402 [subcommand] [args...]    Configure an x402 payment wallet (EXPERIMENTAL)
  help [command] [subcommand]    Show help for a command

Options:
  --json                         Output in JSON format for scripting
  --verbose                      Enable debug logging
  --profile <name>               OAuth profile for the server ("default" if not provided)
  --timeout <seconds>            Request timeout in seconds (default: 60)
  --max-chars <n>                Truncate output to n characters (ignored in --json mode)
  --insecure                     Skip TLS certificate verification (for self-signed certs)
  -v, --version                  Output the version number
  -h, --help                     Display help

MCP session commands (after connecting):
  <@session>                     Show MCP server info, capabilities, and tools overview
  <@session> grep <pattern>      Search tools and instructions
  <@session> tools-list          List all server tools
  <@session> tools-get <name>    Get tool details and schema
  <@session> tools-call <name> [arg:=val ... | <json> | <stdin]
  <@session> tasks-list
  <@session> tasks-get <taskId>
  <@session> tasks-result <taskId>
  <@session> tasks-cancel <taskId>
  <@session> prompts-list
  <@session> prompts-get <name> [arg:=val ... | <json> | <stdin]
  <@session> completion-complete prompt|resource <ref> <arg:=val ... | <json> | <stdin>
  <@session> resources-list
  <@session> resources-read <uri> [-o <file> | --raw]
  <@session> resources-subscribe <uri> <file>
  <@session> resources-unsubscribe <uri>
  <@session> resources-templates-list
  <@session> resources-directory-read <uri>
  <@session> skills-list
  <@session> skills-get <skill> [file] [--raw]
  <@session> events-list
  <@session> events-subscribe <name> [arg:=val ... | <json>]
  <@session> events-unsubscribe <name>
  <@session> events-route <name> [--add <agent>...] [--path <path>]
  <@session> events-tail [--follow] [--all] [--agent <name>]
  <@session> events-ack <seq>... | --all [--agent <name>]
  <@session> events-status [--agent <name>]
  <@session> events-deliver --agent <name> --claude-session <id> [--cwd <dir>]
  <@session> logging-set-level <level>
  <@session> ping
  <@session> server-discover
  <@session> logs [-n N] [--follow] [--since 1h]

Run "mcpc" without arguments to show active sessions and OAuth profiles.
Run "mcpc --json" to get the same data as `{ sessions: [...], profiles: [...] }`.

Agent guide: mcpc help --skill
```

## `mcpc connect`

```text
Usage: mcpc connect [<server>] [@session] [options]

Connect to an MCP server and start a new named @session

Options:
  -H, --header <header>         HTTP header (can be repeated)
  --profile <name>              OAuth profile to use ("default" if skipped)
  --no-profile                  Skip OAuth profile (connect anonymously)
  --proxy <[host:]port>         Start proxy MCP server for session
  --proxy-bearer-token <token>  Require authentication for access to proxy server
  --stdio                       Launch all local stdio servers from selected config files
  --protocol-version <version>  Pin the MCP protocol version (see below)
  --x402 [scheme]               Enable x402 auto-payment (see below)
  --json                        Output in JSON format

Server formats:
  mcp.apify.com                 Remote HTTP server (https:// auto-added)
  ~/.vscode/mcp.json:puppeteer  Config file entry (file:entry)
  ~/.vscode/mcp.json            Config file — bulk connect every entry
  (no server)                   Auto-discover configs and connect everything

  Stdio entries run a local command on connect, so only use configs you
  trust. Bulk connects skip them; pass --stdio to include them.

Auto-discovery:
  Without <server>, mcpc finds MCP config files in ./ and ~ and bulk connects
  every entry: .mcp.json, mcp.json, mcp_config.json, .cursor/mcp.json,
  .vscode/mcp.json, .kiro/settings/mcp.json, ~/.claude.json,
  ~/.codeium/windsurf/mcp_config.json, plus VS Code & Claude Desktop configs.
  For security, configs in ./ are untrusted: entries that reference ${VAR}
  are skipped and -H is refused. To connect those: mcpc connect ./.mcp.json

Session name:
  Omit @session to auto-generate from the server (mcp.apify.com → @apify)
  or config entry. Matching sessions (same server, profile, header keys)
  are reused. Bulk connects don't accept @session.

Protocol version:
  mcpc negotiates the newest MCP version both sides support, from
  2026-07-28 down to 2024-10-07. Pass --protocol-version to pin one exact
  version instead — the connection fails if the server does not offer it.

x402 payments (experimental):
  --x402 pays for paid tool calls from the wallet set up with: mcpc x402
  Schemes: auto (default, prefers upto), upto, exact.
  For more info, run: mcpc help x402

Output:
  For a single server, shows session, server info, capabilities, and tools.
  Bulk connects list every session with its state, then a summary.

JSON output (--json):
  Array of `InitializeResult` or `DiscoverResult` objects extended with `toolNames` and `_mcpc`:
  `[{ protocolVersion?, supportedVersions?, capabilities?, serverInfo?, instructions?, _meta?, toolNames?, _mcpc: { ... } }]`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult
          https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult
```

## `mcpc close`

```text
Usage: mcpc close <@session> [options]

Close a session

Options:
  --json  Output in JSON format

JSON output (--json):
  `{ sessionName, closed: true }`
```

## `mcpc restart`

```text
Usage: mcpc restart <@session> [options]

Restart a session (losing all state)

Options:
  --json  Output in JSON format

Output:
  After restarting, shows session, server info, capabilities, and tools.

JSON output (--json):
  `InitializeResult` or `DiscoverResult` object extended with `toolNames` and `_mcpc`:
  `{ protocolVersion?, supportedVersions?, capabilities?, serverInfo?, instructions?, _meta?, toolNames?, _mcpc: { ... } }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult
          https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult
```

## `mcpc login`

```text
Usage: mcpc login <server> [options]

Log in to a server and save an OAuth profile

Options:
  --profile <name>              Profile name (default: "default")
  --scope <scopes>              OAuth scopes to request (e.g. --scope "read write")
  --grant <type>                Grant: authorization-code (default), client-credentials, id-jag
  --client-metadata-url <url>   HTTPS URL of an OAuth CIMD (default: mcpc CIMD)
  --no-client-metadata-url      Disable CIMD; force DCR on CIMD-capable servers
  --client-name <name>          Client name to register with DCR (default: mcpc)
  --client-id <id>              Pre-registered OAuth client ID (skips CIMD and DCR)
  --client-secret <secret>      Pre-registered OAuth client secret (requires --client-id)
  --client-key <pem-or-path>    Private key (PEM path or literal) for private_key_jwt auth
  --client-key-alg <alg>        JWT signing algorithm for --client-key (default: RS256)
  --token-endpoint <url>        OAuth token endpoint (client-credentials only, auto-discovered)
  --idp <url>                   Enterprise IdP issuer URL (id-jag only)
  --idp-client-id <id>          Client ID pre-registered at the enterprise IdP (id-jag only)
  --idp-client-secret <secret>  Client secret for the enterprise IdP (id-jag only)
  --idp-scope <scopes>          OIDC scopes for the IdP SSO (id-jag only, see below)
  --callback-port <port>        Loopback port for OAuth callback (default: 13316/31613/16133)
  --callback-host <host>        OAuth callback host: 127.0.0.1 (default) or localhost
  --json                        Output in JSON format

Interactive login:
  By default, the command opens your browser to authorize the server,
  then saves the credentials as a reusable profile any session can use:

  default profile: mcpc login mcp.apify.com
  named profile:   mcpc login mcp.apify.com --profile work
  then connect:    mcpc connect mcp.apify.com @app --profile work

Client registration (how mcpc identifies itself to the server):
  1. Client ID Metadata Documents (CIMD): the default. mcpc's hosted CIMD at
     https://apify.github.io/mcpc/client-metadata.json identifies all mcpc
     installs as one client. Override with --client-metadata-url <url>, or
     disable with --no-client-metadata-url.
  2. Pre-registration: pass --client-id (and --client-secret if issued). If the
     client's redirect URI uses localhost (e.g. localhost:3118), match it with
     --callback-host localhost --callback-port 3118.
  3. Dynamic Client Registration (DCR): fallback when CIMD is unsupported or
     disabled and the server exposes a registration_endpoint. Registers as
     "mcpc"; --client-name <name> registers under another name (disables CIMD).

  See https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

Machine-to-machine authentication (for CI/CD and daemons):
  Pass --grant client-credentials, --client-id, and one credential:

  mcpc login mcp.example.com --grant client-credentials \
    --client-id my-svc --client-secret s3cr3t --scope "read write"
  mcpc login mcp.example.com --grant client-credentials \
    --client-id my-svc --client-key ./key.pem

  --client-secret uses client_secret_basic; --client-key signs a private_key_jwt
  assertion (RFC 7523). The token endpoint is auto-discovered; pin it with
  --token-endpoint <url> for servers without discoverable metadata.

  See https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials

Enterprise-managed authorization (SSO via your organization's IdP):
  Pass --grant id-jag when your organization controls MCP server access
  centrally through its identity provider (e.g. Okta). You sign in once with
  your corporate SSO; mcpc then obtains MCP tokens via identity assertion
  grants (ID-JAG) without any per-server consent screens:

  mcpc login mcp.example.com --grant id-jag \
    --idp https://acme.okta.com --idp-client-id <idp-client> \
    --client-id <mcp-as-client> --client-secret <secret>

  Both clients are pre-registered by your IT team: --idp-client-id at the
  enterprise IdP (add --idp-client-secret if it is a confidential client),
  --client-id/--client-secret at the MCP server's authorization server.
  --scope requests MCP-server scopes; --idp-scope overrides the OIDC scopes
  used for the SSO itself (default: "openid profile email offline_access").

  See https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization

JSON output (--json):
  Interactive prompts go to stderr; stdout is a clean JSON object:
  `{ profile, serverUrl, scopes }`
```

## `mcpc logout`

```text
Usage: mcpc logout <server> [options]

Delete an OAuth profile for a server

Options:
  --profile <name>  Profile name (default: "default")
  --json            Output in JSON format

JSON output (--json):
  `{ profile, serverUrl, deleted: true, affectedSessions }`
```

## `mcpc events-hook`

```text
Usage: mcpc events-hook [options] <event>

Claude Code hook: show pending events (see below)

Options:
  --json  Output in JSON format

Notes:
  Run by Claude Code hooks (the mcpc-events plugin installs them), with the hook
  JSON on stdin. <event> is session-start or stop. session-start adds this
  agent's unacknowledged events to the new session's context; stop keeps the
  agent working when events arrived it has not seen yet. Events stay until the
  agent runs events-ack. The agent is MCPC_AGENT (default "default"); the MCP
  sessions are MCPC_EVENTS_SESSIONS (comma-separated), else every session with
  an event journal.

Example (settings.json hook command):
  MCPC_AGENT=reviewer mcpc events-hook stop

JSON output (--json):
  Claude Code hook output: `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }` or `{ decision: "block", reason }`; nothing when there is nothing to show
```

## `mcpc supervise`

```text
Usage: mcpc supervise [options]

Keep sessions that receive events connected

Options:
  --once             Check and restart once, then exit
  --interval <secs>  Seconds between checks (default: "30")
  --install          Install as a launchd (macOS) or systemd (Linux) user service
  --uninstall        Remove the installed service
  --json             Output in JSON format

Notes:
  Watches every session with an active events-subscribe subscription or a
  claude/channel listener, and restarts its bridge when it is not running; the
  bridge resumes polling from its journaled cursor. Needed for push-only
  sources (claude/channel), which lose whatever is sent while no bridge listens.
  Unauthorized or expired sessions are reported, not retried. In a loop only
  changes are printed (one line per restart or problem).

Examples:
  mcpc supervise --once
  mcpc supervise --install

JSON output (--json):
  With --once: `[{ session, state: "healthy"|"restarted"|"needs-attention"|"error", detail? }]`; in a loop: one such object per line with `at`; with --install / --uninstall: `{ installed|uninstalled: true, service, path }`
```

## `mcpc clean`

```text
Usage: mcpc clean [options] [resources...]

Clean up mcpc data (sessions, profiles, logs, all)

Options:
  --json  Output in JSON format

Resources:
  sessions    Remove stale/crashed session records
  profiles    Remove authentication profiles
  logs        Remove bridge log files
  all         Remove all of the above

  Without arguments, performs safe cleanup of stale data only.

JSON output (--json):
  `{ crashedBridges, expiredSessions, orphanedBridgeLogs, sessions, profiles, logs }`
```

## `mcpc grep`

```text
Usage: mcpc grep <pattern> [options]

Search tools and instructions across all active sessions

Options:
  --tools                Search tools
  --resources            Search resources
  --prompts              Search prompts
  --instructions         Search server instructions
  -E, --regex            Treat pattern as a regular expression
  -s, --case-sensitive   Case-sensitive matching
  -m, --max-results <n>  Limit the number of results
  --json                 Output in JSON format

Type filters:
  By default, tools and instructions are searched. Use --resources or --prompts
  to search those instead. Combine flags to search multiple types (e.g. --tools --resources).

Examples:
  mcpc grep "search"                        Search tools and instructions in all sessions
  mcpc grep "search" --resources            Search resources only
  mcpc grep "search" --tools --prompts      Search tools and prompts
  mcpc grep "search|find" -E                Regex search across tools and instructions
  mcpc @apify grep "actor"                  Search within a single session
  mcpc grep "file" --json                   JSON output for scripting
  mcpc grep "actor" -m 5                    Show at most 5 results

Exit codes:
  0 = matches found, 1 = no matches (grep convention)

JSON output (--json):
  `[{ sessionName, tools?: Tool[], resources?: Resource[], prompts?: Prompt[], instructions?: string[] }]`
```

## `mcpc x402`

```text
Usage: mcpc x402 [options] [command]

x402 wallet management and payment signing (EXPERIMENTAL)

Options:
  --json                             Output in JSON format
  --verbose                          Enable debug logging
  -h, --help                         Display help

Commands:
  init                               Create a new x402 wallet (generates a random private key)
  import <private-key>               Import an existing wallet from a private key
  remove                             Remove the wallet
  sign [options] <payment-required>  Sign a payment from a base64 PAYMENT-REQUIRED header
  help [command]                     Display help for command

sign options:
  --amount <usd>         Override amount in USD (for upto: max authorization cap)
  --expiry <seconds>     Override expiry in seconds
  --scheme <preference>  Payment scheme: auto (default), upto, or exact
  --no-approve           Skip the upto Permit2 allowance check & auto-approval

JSON output (--json):
  `{ address, createdAt, balances: { eth, usdc } | null }` (null if no wallet)
```

### `mcpc x402 init`

```text
Usage: mcpc x402 init [options]

Create a new x402 wallet (generates a random private key)

Options:
  -h, --help  Display help

JSON output (--json):
  `{ address }`
```

### `mcpc x402 import`

```text
Usage: mcpc x402 import [options] <private-key>

Import an existing wallet from a private key

Options:
  -h, --help  Display help

JSON output (--json):
  `{ address }`
```

### `mcpc x402 remove`

```text
Usage: mcpc x402 remove [options]

Remove the wallet

Options:
  -h, --help  Display help

JSON output (--json):
  `{ removed: true }`
```

### `mcpc x402 sign`

```text
Usage: mcpc x402 sign [options] <payment-required>

Sign a payment from a base64 PAYMENT-REQUIRED header

Options:
  --amount <usd>              Override amount in USD (for upto: max authorization cap)
  --expiry <seconds>          Override expiry in seconds
  --scheme <auto|upto|exact>  Payment scheme preference (default: "auto")
  --no-approve                Skip the upto Permit2 allowance check & auto-approval
  -h, --help                  Display help

Signs the given base64-encoded PAYMENT-REQUIRED header offline using the configured
wallet and prints the resulting PAYMENT-SIGNATURE header (plus an MCP config snippet)
to stdout. Useful for pre-signing payments or integrating with other MCP clients.

JSON output (--json):
  `{ paymentSignature, from, to, amount, amountAtomicUnits, network, expiresAt }`
```

## `mcpc help`

```text
Usage: mcpc help [options] [command] [subcommand]

Show help for a command

Options:
  --skill  Print the agent skill (mental model, workflows, examples)
  --json   Output in JSON format
```

## `mcpc @<session>`

```text
Usage: mcpc @<session> [options] [command]

Show MCP session info or execute commands.

Options:
  --json                                Output in JSON format for scripting and code mode
  --verbose                             Enable debug logging
  --profile <name>                      OAuth profile override
  --timeout <seconds>                   Request timeout in seconds (default: 60)
  --max-chars <n>                       Truncate output to n characters (ignored in --json mode)
  --insecure                            Skip TLS certificate verification (for self-signed certs)
  -h, --help                            Display help

Commands:
  close                                 Close MCP session.
  restart                               Restart MCP session (losing all state).
  grep <pattern>                        Search MCP session objects.
  tools-list                            List all MCP tools.
  tools-get <name>                      Get details and schema for an MCP tool.
  tools-call <name> [args...]           Call an MCP tool with arguments.
  tasks-list                            List MCP tasks (see below).
  tasks-get <taskId>                    Get MCP task status.
  tasks-result <taskId>                 Get a task's result (waits until it finishes).
  tasks-cancel <taskId>                 Cancel an MCP task.
  resources-list                        List all MCP resources.
  resources-read <uri>                  Read an MCP resource by URI.
  resources-subscribe <uri> <file>      Subscribe to an MCP resource and sync it to a local file.
  resources-unsubscribe <uri>           Stop syncing a resource, keep the local file.
  resources-templates-list              List MCP resource templates.
  events-list                           List the event types the server offers.
  events-subscribe <name> [args...]     Subscribe to an event type; events are journaled.
  events-unsubscribe <name>             Stop an event subscription, keep its journal.
  events-route <name>                   Show or change which agents receive a subscription.
  events-tail                           Print journaled events not yet acknowledged.
  events-ack [seqs...]                  Acknowledge journaled events by seq.
  events-deliver                        Wake an agent's Claude session on new events.
  events-status                         Show event subscriptions and unacknowledged counts.
  skills-list                           List the agent skills the server serves.
  skills-get <skill> [file]             Read a skill's SKILL.md, or one of its files (see below).
  resources-directory-read <uri>        List a directory resource's direct children.
  prompts-list                          List all MCP prompts.
  prompts-get <name> [args...]          Get an MCP prompt with arguments.
  completion-complete <type> <ref> ...  Suggest values for a prompt or template argument.
  logging-set-level <level>             Set MCP server logging level (deprecated).
  ping                                  Ping the MCP server.
  server-discover                       Ask the server what it supports (MCP 2026-07-28+).
  logs                                  Show or follow the bridge log file for this session.

Output:
  When no command is given, shows session, server info, capabilities, and tools.

JSON output (--json):
  `InitializeResult` or `DiscoverResult` object extended with `toolNames` and `_mcpc`:
  `{ protocolVersion?, supportedVersions?, capabilities?, serverInfo?, instructions?, _meta?, toolNames?, _mcpc: { ... } }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult
          https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult
```

### `mcpc @<session> close`

```text
Usage: mcpc @<session> close [options]

Close MCP session.

Options:
  --json  Output in JSON format

JSON output (--json):
  `{ sessionName, closed: true }`
```

### `mcpc @<session> restart`

```text
Usage: mcpc @<session> restart [options]

Restart MCP session (losing all state).

Options:
  --json  Output in JSON format

Output:
  After restarting, shows session, server info, capabilities, and tools.

JSON output (--json):
  `InitializeResult` or `DiscoverResult` object extended with `toolNames` and `_mcpc`:
  `{ protocolVersion?, supportedVersions?, capabilities?, serverInfo?, instructions?, _meta?, toolNames?, _mcpc: { ... } }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult
          https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult
```

### `mcpc @<session> grep`

```text
Usage: mcpc @<session> grep <pattern> [options]

Search MCP session objects.

Options:
  --tools                Search tools
  --resources            Search resources
  --prompts              Search prompts
  --instructions         Search server instructions
  -E, --regex            Treat pattern as a regular expression
  -s, --case-sensitive   Case-sensitive matching
  -m, --max-results <n>  Limit the number of results
  --json                 Output in JSON format

Type filters:
  By default, tools and instructions are searched. Use --resources or --prompts
  to search those instead. Combine flags to search multiple types.

Examples:
  mcpc @<session> grep "search"                  Search tools and instructions
  mcpc @<session> grep "search" --resources      Search resources only
  mcpc @<session> grep "search|find" -E          Regex search

Exit codes:
  0 = matches found, 1 = no matches (grep convention)

JSON output (--json):
  `{ tools?: Tool[], resources?: Resource[], prompts?: Prompt[], instructions?: string[] }`
```

### `mcpc @<session> tools-list`

```text
Usage: mcpc @<session> tools-list [options]

List all MCP tools.

Options:
  --full  Show full tool details including schema
  --json  Output in JSON format

JSON output (--json):
  Array of `Tool` objects:
  `[{ name, description?, inputSchema, outputSchema?, annotations? }, ...]`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#tool
```

### `mcpc @<session> tools-get`

```text
Usage: mcpc @<session> tools-get [options] <name>

Get details and schema for an MCP tool.

Options:
  --schema <file>       Validate tool schema against expected schema
  --schema-mode <mode>  Schema validation mode: strict, compatible (default), ignore
  --json                Output in JSON format

Schema validation:
  --schema <file>       Validate against expected schema (save with tools-get --json)
  --schema-mode <mode>  strict | compatible (default) | ignore

JSON output (--json):
  `Tool` object:
  `{ name, description?, inputSchema, outputSchema?, annotations? }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#tool
```

### `mcpc @<session> tools-call`

```text
Usage: mcpc @<session> tools-call [options] <name> [args...]

Call an MCP tool with arguments.

Options:
  --task                Use async task execution; Ctrl+C prints the task ID and exits (experimental)
  --detach              Start task and return immediately with task ID (implies --task)
  --schema <file>       Validate tool schema against expected schema before calling
  --schema-mode <mode>  Schema validation mode: strict, compatible (default), ignore
  --json                Output in JSON format

Arguments:
  key:=value pairs    mcpc @<session> tools-call search query:=hello limit:=10
  Inline JSON         mcpc @<session> tools-call search '{"query":"hello"}'
  Stdin pipe          echo '{"query":"hello"}' | mcpc @<session> tools-call search

  Values are auto-parsed: strings, numbers, booleans, JSON objects/arrays.
  To force a string, wrap in quotes: id:='"123"'
  Tip: mcpc @<session> tools-call <tool> --help prints the tool's parameter schema.

Async tasks (--task, --detach):
  --task shows a progress spinner; Ctrl+C leaves the task running and prints
  its ID for tasks-get, tasks-result or tasks-cancel.
  --detach prints the task ID (the whole Task with --json) once the server
  has created the task.
  Both fail unless the server supports tasks (the tasks capability on MCP
  2025-11-25, per-tool in tools-list; the tasks extension on 2026-07-28).
  A 2026-07-28 server decides per call: a plain call it turns into a task is
  waited for, and --detach prints the tool result if it ran synchronously.

Schema validation:
  --schema <file>       Validate tool schema before calling (save with tools-get --json)
  --schema-mode <mode>  strict | compatible (default) | ignore

JSON output (--json):
  `CallToolResult` object:
  `{ content: [{ type, text?, ... }], isError?, structuredContent?: { ... } }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#calltoolresult

  With `--detach`: the created `Task` object,
  on MCP 2025-11-25: `{ taskId, status, ttl, createdAt, lastUpdatedAt, statusMessage?, pollInterval? }`
  on MCP 2026-07-28: `{ taskId, status, ttlMs, createdAt, lastUpdatedAt, statusMessage?, pollIntervalMs?,
                      result? (completed), error? (failed), inputRequests? (input_required) }`
  or the `CallToolResult` above when the server ran the tool synchronously.
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#task
          https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md

  With `--x402` on the session: the server's settlement receipt, when it sends
  one, is at `_meta["x402/payment-response"]`.
```

### `mcpc @<session> tasks-list`

```text
Usage: mcpc @<session> tasks-list [options]

List MCP tasks (see below).

Options:
  --json  Output in JSON format

Notes:
  MCP 2025-11-25 servers list all their tasks. The 2026-07-28 tasks extension
  has no listing, so there this shows the tasks this session created.

JSON output (--json):
  `{ tasks: Task[] }`, each `Task` shaped:
  on MCP 2025-11-25: `{ taskId, status, ttl, createdAt, lastUpdatedAt, statusMessage?, pollInterval? }`
  on MCP 2026-07-28: `{ taskId, status, ttlMs, createdAt, lastUpdatedAt, statusMessage?, pollIntervalMs?,
                      result? (completed), error? (failed), inputRequests? (input_required) }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#task
          https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md
```

### `mcpc @<session> tasks-get`

```text
Usage: mcpc @<session> tasks-get [options] <taskId>

Get MCP task status.

Options:
  --json  Output in JSON format

Notes:
  On MCP 2026-07-28 a finished task carries its result or error (shown with
  --json).

JSON output (--json):
  `Task` object:
  on MCP 2025-11-25: `{ taskId, status, ttl, createdAt, lastUpdatedAt, statusMessage?, pollInterval? }`
  on MCP 2026-07-28: `{ taskId, status, ttlMs, createdAt, lastUpdatedAt, statusMessage?, pollIntervalMs?,
                      result? (completed), error? (failed), inputRequests? (input_required) }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#task
          https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md
```

### `mcpc @<session> tasks-result`

```text
Usage: mcpc @<session> tasks-result [options] <taskId>

Get a task's result (waits until it finishes).

Options:
  --json  Output in JSON format

Notes:
  Polls tasks/get on MCP 2026-07-28. A task waiting for client input
  (input_required) is reported as an error: mcpc never prompts.

JSON output (--json):
  `CallToolResult` object:
  `{ content: [{ type, text?, ... }], isError?, structuredContent?: { ... } }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#calltoolresult
```

### `mcpc @<session> tasks-cancel`

```text
Usage: mcpc @<session> tasks-cancel [options] <taskId>

Cancel an MCP task.

Options:
  --json  Output in JSON format

Notes:
  On MCP 2026-07-28 cancellation is cooperative: the status shown right after
  may still be working. Exit code 2 only if the task had already finished.

JSON output (--json):
  `Task` object (its state after the request):
  on MCP 2025-11-25: `{ taskId, status, ttl, createdAt, lastUpdatedAt, statusMessage?, pollInterval? }`
  on MCP 2026-07-28: `{ taskId, status, ttlMs, createdAt, lastUpdatedAt, statusMessage?, pollIntervalMs?,
                      result? (completed), error? (failed), inputRequests? (input_required) }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#task
          https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md
```

### `mcpc @<session> prompts-list`

```text
Usage: mcpc @<session> prompts-list [options]

List all MCP prompts.

Options:
  --json  Output in JSON format

JSON output (--json):
  Array of `Prompt` objects:
  `[{ name, description?, arguments?: [{ name, required? }] }, ...]`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#prompt
```

### `mcpc @<session> prompts-get`

```text
Usage: mcpc @<session> prompts-get [options] <name> [args...]

Get an MCP prompt with arguments.

Options:
  --json  Output in JSON format

Arguments:
  key:=value pairs    mcpc @<session> prompts-get summarize style:=brief lang:=en
  Inline JSON         mcpc @<session> prompts-get summarize '{"style":"brief"}'
  Stdin pipe          echo '{"style":"brief"}' | mcpc @<session> prompts-get summarize

  Values are auto-parsed: strings, numbers, booleans, JSON objects/arrays.
  To force a string, wrap in quotes: id:='"123"'

JSON output (--json):
  `GetPromptResult` object:
  `{ description?, messages: [{ role, content: { type, text?, ... } }] }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#getpromptresult
```

### `mcpc @<session> completion-complete`

```text
Usage: mcpc @<session> completion-complete [options] <type> <ref> [args...]

Suggest values for a prompt or template argument.

Options:
  --json  Output in JSON format

Arguments:
  <type>     `prompt` or `resource` (the MCP ref/prompt or ref/resource reference)
  <ref>      Prompt name, or resource URI template (`file:///{path}`)
  [args...]  Prompt or template arguments, in one of the three forms below. The last
             one is the argument to complete, with the text typed so far as its value
             (`name:=` for none); the ones before it are sent as context.

  key:=value pairs    mcpc @<session> completion-complete prompt code_review language:=py
  Inline JSON         mcpc @<session> completion-complete prompt code_review '{"language":"py"}'
  Stdin pipe          echo '{"language":"py"}' | mcpc @<session> completion-complete prompt code_review

  Values are always sent as strings: `count:=10` sends "10", and a JSON object
  or array is sent as its JSON text.

Examples:
  mcpc @<session> completion-complete prompt code_review language:=
  mcpc @<session> completion-complete prompt code_review language:=python framework:=fla
  mcpc @<session> completion-complete resource 'file:///{path}' path:=/ho

Notes:
  The server must declare the completions capability (shown by: mcpc @<session>).
  Servers return at most 100 suggestions, ranked by relevance; `total` is the
  number of matches when known, `hasMore` says if there are more than returned.

JSON output (--json):
  `CompleteResult` object:
  `{ completion: { values: string[], total?: number, hasMore?: boolean }, _meta? }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#completeresult
```

### `mcpc @<session> resources-list`

```text
Usage: mcpc @<session> resources-list [options]

List all MCP resources.

Options:
  --json  Output in JSON format

JSON output (--json):
  Array of `Resource` objects:
  `[{ uri, name, description?, mimeType? }, ...]`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#resource
```

### `mcpc @<session> resources-read`

```text
Usage: mcpc @<session> resources-read [options] <uri>

Read an MCP resource by URI.

Options:
  -o, --output <file>  Save the resource to a file (decodes binary content)
  --raw                Print only the resource content, suitable for piping
  --json               Output in JSON format

Output:
  Default: pretty view; binary (blob) content is summarized, never dumped.
  --raw prints the bare content (binary requires a redirect or -o).
  -o <file> saves the content; base64 `blob` data is decoded to bytes.
  If the server returns multiple content items, --raw and -o use the item
  matching <uri> (or the first one) — use --json to get all items.

JSON output (--json):
  `ReadResourceResult` object:
  `{ contents: [{ uri, mimeType?, text? | blob? }], ttlMs?, cacheScope? }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#readresourceresult

  `ttlMs`/`cacheScope` are caching hints only present on 2026-07-28 connections.
  With `-o`: `{ uri, file, bytes, mimeType? }` summary instead.
```

### `mcpc @<session> resources-subscribe`

```text
Usage: mcpc @<session> resources-subscribe [options] <uri> <file>

Subscribe to an MCP resource and sync it to a local file.

Options:
  --json  Output in JSON format

Behavior:
  Downloads the resource to <file> now; afterwards the session bridge rewrites
  the file whenever the server announces a change for <uri> (the MCP
  notifications/resources/updated flow). Requires the server capability
  `resources.subscribe` — check with `mcpc @<session>`. Subscriptions are
  re-established automatically when the session reconnects or restarts.
  Subscribing to the same <uri> again just changes the target <file>.

Example:
  mcpc @<session> resources-subscribe file:///app/config.json ./config.json

JSON output (--json):
  `{ subscribed: true, uri, file, bytes, mimeType? }`
```

### `mcpc @<session> resources-unsubscribe`

```text
Usage: mcpc @<session> resources-unsubscribe [options] <uri>

Stop syncing a resource, keep the local file.

Options:
  --json  Output in JSON format

JSON output (--json):
  `{ unsubscribed: true, uri, file }`
```

### `mcpc @<session> resources-templates-list`

```text
Usage: mcpc @<session> resources-templates-list [options]

List MCP resource templates.

Options:
  --json  Output in JSON format

JSON output (--json):
  Array of `ResourceTemplate` objects:
  `[{ uriTemplate, name, description?, mimeType? }, ...]`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#resourcetemplate
```

### `mcpc @<session> resources-directory-read`

```text
Usage: mcpc @<session> resources-directory-read [options] <uri>

List a directory resource's direct children.

Options:
  --json  Output in JSON format

Notes:
  Part of the skills extension; needs `"directoryRead": true` in the server's
  declaration. Lists one level: descend by re-running on a child directory
  (children with MIME type `inode/directory`). Directory URIs have no
  trailing slash.

Examples:
  mcpc @<session> resources-directory-read skill://pdf-processing
  mcpc @<session> resources-directory-read skill://pdf-processing/templates

JSON output (--json):
  Array of `Resource` objects (the direct children):
  `[{ uri, name?, mimeType? }, ...]`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#resource
```

### `mcpc @<session> skills-list`

```text
Usage: mcpc @<session> skills-list [options]

List the agent skills the server serves.

Options:
  --json  Output in JSON format

Notes:
  Each entry carries the skill's frontmatter and its complete file manifest
  (every file with a SHA-256 digest and byte size). A listing may be partial:
  a skill you know the URI of is readable even when it is not listed.

JSON output (--json):
  Array of `Skill` entries:
  `[{ uri, frontmatter: { name, description, ... }, resources: [{ uri, digest, size }] | "dynamic" }, ...]`
  Schema: https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/beta/skills.mdx
```

### `mcpc @<session> skills-get`

```text
Usage: mcpc @<session> skills-get [options] <skill> [file]

Read a skill's SKILL.md, or one of its files (see below).

Options:
  --raw   Print only the file content, suitable for piping
  --json  Output in JSON format

Arguments:
  <skill>  Skill name, path (`acme/billing/refunds`), or its SKILL.md URI
  [file]   Path of a supporting file inside the skill (`references/FORMS.md`)

Notes:
  Content is checked against the skill's manifest (size, digest, and for
  SKILL.md its frontmatter) and is not printed when the check fails.
  With --json, --raw is ignored and `contents` holds only the verified item.

Examples:
  mcpc @<session> skills-get pdf-processing
  mcpc @<session> skills-get pdf-processing --raw > SKILL.md
  mcpc @<session> skills-get pdf-processing references/FORMS.md

JSON output (--json):
  The skill entry plus the content that was read:
  `{ skill: { uri, frontmatter, resources }, contents: [{ uri, mimeType?, text? | blob? }] }`
  Schema: https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/beta/skills.mdx
```

### `mcpc @<session> events-list`

```text
Usage: mcpc @<session> events-list [options]

List the event types the server offers.

Options:
  --json  Output in JSON format

Notes:
  Requires an MCP 2026-07-28 connection to a server that declares the
  io.modelcontextprotocol/events extension (a Draft, SEP-3415).

JSON output (--json):
  Array of event descriptors:
  `[{ name, description?, delivery: ["poll"|"push"|"webhook", ...], inputSchema?, payloadSchema? }, ...]`
  Schema: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415
```

### `mcpc @<session> events-subscribe`

```text
Usage: mcpc @<session> events-subscribe [options] <name> [args...]

Subscribe to an event type; events are journaled.

Options:
  --agent <name>  Deliver to this agent (default: $MCPC_AGENT, else all)
  --route <path>  Record path naming recipients, e.g. data.meta.to
  --json          Output in JSON format

Behavior:
  The session bridge receives the event type (over events/stream when the server
  offers push, else by polling; a dropped stream is caught up by polling) and
  appends every event to a durable journal (~/.mcpc/events/<session>/) before
  advancing its cursor, so events
  survive bridge crashes and restarts. Delivery starts now: earlier events are
  not replayed. Subscriptions resume automatically when the session restarts.
  Arguments filter or shape the events, as in tools-call (key:=value or JSON).

Agents:
  Several agents can share one session: each agent that subscribes (--agent or
  MCPC_AGENT) is added to the subscription's recipients, and the event is
  journaled once. A subscription nobody named an agent for goes to every agent.
  With --route, a record naming recipients at that path (a name or a list)
  goes only to them; see events-route.

Examples:
  mcpc @<session> events-subscribe email.received from:="*@example.com"
  MCPC_AGENT=triage mcpc @<session> events-subscribe ticket.created --route data.assignee

JSON output (--json):
  `{ subscribed: true, id, name, arguments?, delivery: ["poll"|"push", ...], subscribedAt, route: { agents?, path? } }`
```

### `mcpc @<session> events-unsubscribe`

```text
Usage: mcpc @<session> events-unsubscribe [options] <name>

Stop an event subscription, keep its journal.

Options:
  --agent <name>  Only remove this agent (default: $MCPC_AGENT)
  --json          Output in JSON format

Notes:
  <name> is the event name, or the subscription id shown by events-status when
  several subscriptions share a name. With an agent (--agent or MCPC_AGENT),
  only that agent stops receiving it; polling stops when no agent is left.

JSON output (--json):
  `{ unsubscribed: true, id, name }` or, while other agents remain, `{ unsubscribed: true, id, agent, remainingAgents }`
```

### `mcpc @<session> events-route`

```text
Usage: mcpc @<session> events-route [options] <name>

Show or change which agents receive a subscription.

Options:
  --add <agent...>     Deliver to these agents too
  --remove <agent...>  Stop delivering to these agents
  --path <path>        Record path naming recipients, e.g. data.meta.to
  --clear-path         Stop routing by a recipient path
  --json               Output in JSON format

Notes:
  Works for any subscription, including "claude/channel" (channel messages need
  no subscribe step). No agents means every agent receives it. With a path, a
  record naming recipients there goes only to them; one naming none of the
  subscription's agents is "unrouted" (events-tail --unrouted), never dropped.
  Changes apply to records not yet acknowledged.

Example:
  mcpc @<session> events-route claude/channel --add alice bob --path data.meta.to

JSON output (--json):
  `{ id, agents?, path? }`
```

### `mcpc @<session> events-tail`

```text
Usage: mcpc @<session> events-tail [options]

Print journaled events not yet acknowledged.

Options:
  -f, --follow    Keep running and print new events as they arrive
  --all           Print every journaled record, for any agent
  --unrouted      Print records that name no subscribed agent
  --agent <name>  Agent whose acks to use (default: $MCPC_AGENT or "default")
  --json          Output in JSON format

Notes:
  Delivery is at-least-once: an event is printed again on every run until it
  is acknowledged with events-ack, so consumers should be idempotent by seq.
  Gap records mark events that could not be delivered (the server skipped past
  our cursor, an event type without replay restarted, or the server ended the
  subscription, or a push-only source was unreachable). Works while the session
  bridge is down. Each agent has its own acknowledgements (--agent/MCPC_AGENT).
  Servers declaring the claude/channel capability (Claude Code channels, MCP
  2025-11-25 sessions) are journaled automatically as `sub: "claude/channel"`.

Examples:
  mcpc @<session> events-tail
  mcpc @<session> events-tail --follow --json | while read -r e; do ...; done

JSON output (--json):
  Array of journal records (with --follow: one record per line):
  `{ seq, kind: "event", sub, name, eventId, timestamp, receivedAt, data, _meta? }` or `{ seq, kind: "gap", sub, name, reason: "truncated"|"no-replay"|"terminated"|"disconnected", detail?, receivedAt }`
```

### `mcpc @<session> events-ack`

```text
Usage: mcpc @<session> events-ack [options] [seqs...]

Acknowledge journaled events by seq.

Options:
  --all           Acknowledge every journaled record
  --agent <name>  Agent whose acks to use (default: $MCPC_AGENT or "default")
  --json          Output in JSON format

Notes:
  Acknowledging is idempotent; an unknown seq fails without changing anything.

Examples:
  mcpc @<session> events-ack 3 4 5
  mcpc @<session> events-ack --all --agent reviewer

JSON output (--json):
  `{ agent, ackedThrough, acked: [seq, ...], unacked }`
```

### `mcpc @<session> events-status`

```text
Usage: mcpc @<session> events-status [options]

Show event subscriptions and unacknowledged counts.

Options:
  --agent <name>  Agent whose acks to use (default: $MCPC_AGENT or "default")
  --json          Output in JSON format

JSON output (--json):
  Object:
  `{ agent, unacked, unackedGaps, unrouted, subscriptions: [{ source: "events"|"channel", id, name, arguments?, delivery?, subscribedAt?, cursor, cursorUpdatedAt?, lastError?, terminatedAt?, route: { agents?, path? }, unacked }] }`
```

### `mcpc @<session> events-deliver`

```text
Usage: mcpc @<session> events-deliver [options]

Wake an agent's Claude session on new events.

Options:
  --agent <name>         Agent whose events wake it (default: $MCPC_AGENT)
  --claude-session <id>  Claude Code session id to resume
  --cwd <dir>            Folder of that Claude session (default: current)
  --plugin-dir <dir>     mcpc-events plugin dir, if not installed
  --remove               Stop waking the agent
  --json                 Output in JSON format

Notes:
  Without --claude-session, lists the delivery targets. When events routed to
  the agent arrive, the session bridge runs "claude -p --resume <id>" in the
  folder with a short nudge; the mcpc-events plugin's hooks show the events.
  A session Claude Code reports as running (claude agents --json) is not
  resumed again: its own Stop hook delivers. Each event wakes it at most once;
  unacknowledged events show again at the next session start.

Example:
  mcpc @<session> events-deliver --agent reviewer --claude-session 0f9b1d93-... --cwd ~/repo

JSON output (--json):
  List: `[{ agent, driver: "claude", claudeSession, cwd, claudeBin, mcpcBin, pluginDir? }]`; add: the target with `saved: true`; --remove: `{ removed: true, agent }`
```

### `mcpc @<session> logging-set-level`

```text
Usage: mcpc @<session> logging-set-level [options] <level>

Set MCP server logging level (deprecated).

Options:
  --json  Output in JSON format

Deprecated:
  MCP 2026-07-28 removed logging/setLevel, so this works on 2025-11-25 (and older)
  servers only and will be removed in a future mcpc release. Use --verbose for
  client-side logging instead.

JSON output (--json):
  `{ level: string }`
```

### `mcpc @<session> ping`

```text
Usage: mcpc @<session> ping [options]

Ping the MCP server.

Options:
  --json  Output in JSON format

Notes:
  Measures the request roundtrip. MCP 2026-07-28 removed `ping`, so on modern
  connections the liveness probe is `server/discover` instead — run
  `mcpc @<session> server-discover` to see what that request returns.

JSON output (--json):
  `{ success: true, durationMs: number }`
```

### `mcpc @<session> server-discover`

```text
Usage: mcpc @<session> server-discover [options]

Ask the server what it supports (MCP 2026-07-28+).

Options:
  --json  Output in JSON format

Notes:
  A live `server/discover` request; `mcpc @<session>` shows the cached connect-time
  answer instead — use it on 2025-11-25 (and older) connections, where this fails.

JSON output (--json):
  `DiscoverResult` object, verbatim:
  `{ supportedVersions: [...], capabilities: { ... }, instructions?, _meta? }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult
```

### `mcpc @<session> logs`

```text
Usage: mcpc @<session> logs [options]

Show or follow the bridge log file for this session.

Options:
  -n, --tail <n>   Number of recent lines to show (default: 50)
  --follow         Stream new log lines as they are written
  --since <value>  Only show entries newer than a duration (30s, 5m, 2h, 1d) or ISO timestamp
  --json           Output in JSON format

Examples:
  mcpc @<session> logs                  Last 50 lines
  mcpc @<session> logs -n 200           Last 200 lines
  mcpc @<session> logs --follow         Stream new lines (ESC/Ctrl+C/q to stop)
  mcpc @<session> logs --since 1h       Lines from the last hour
  mcpc @<session> logs --since 30m -n 50

Notes:
  Reads ~/.mcpc/logs/bridge-@<session>.log and transparently spans
  rotated files (.log.1 … .log.5) when -n or --since needs older lines.
  Continuation lines (e.g. stack traces) fold into the preceding entry's msg.

JSON output (--json):
  Array of log records (JSONL when streaming with --follow):
  `[{ time, level, context?, msg } | { raw }, ...]`
```
