---
title: CLI reference
description: Complete command index and top-level help generated from the current Morphz Clap schema.
section: reference
order: 400
status: current
source: generated-cli-schema
---

> This page is generated from the current Morphz CLI schema. Do not edit it directly; run the generator to refresh it.

## Command index

| Command | Description |
|---|---|
| `morphz exec` | Run one prompt and print the final reply |
| `morphz resume` | Reattach an existing or recently active Session |
| `morphz serve` | Start the HTTP/WebSocket runtime and embedded Dashboard |
| `morphz dashboard` | Start the Dashboard and open it in the default browser |
| `morphz edge` | Pair and run an outbound Execution Node |
| `morphz edge pairing-code` | Create a short-lived pairing code for the current Principal |
| `morphz edge nodes` | List Execution Nodes owned by the current Principal |
| `morphz edge revoke` | Revoke one paired Execution Node |
| `morphz edge local-leases` | List Provider-local capability leases for this Node |
| `morphz edge revoke-local-lease` | Revoke one Provider-local capability lease |
| `morphz edge pair` | Pair this device with a Morphz Gateway |
| `morphz edge run` | Run the authenticated outbound Edge worker |
| `morphz edge rotate-key` | Rotate this Node's device identity key |
| `morphz edge status` | Show the paired Node credential and local Target identity |
| `morphz target` | Inspect and administer Execution Targets |
| `morphz target list` | List Targets visible to the current Principal |
| `morphz target show` | Inspect one Target |
| `morphz target enable` | Enable one Target |
| `morphz target disable` | Disable one Target |
| `morphz target authorize` | Restrict a Target to an Agent, Context or Thread scope |
| `morphz target authorizations` | List scoped Target authorizations |
| `morphz target revoke-authorization` | Revoke one scoped Target authorization |
| `morphz lease` | Inspect and revoke Target capability leases |
| `morphz lease list` | List active capability leases |
| `morphz lease revoke` | Revoke one capability lease |
| `morphz execution` | Inspect and control durable physical Execution Jobs |
| `morphz execution list` | List Execution Jobs |
| `morphz execution show` | Inspect one Execution Job |
| `morphz execution output` | Read durable stdout/stderr chunks for one Job |
| `morphz execution cancel` | Request cancellation of one Job |
| `morphz setup` | Open guided model provider setup |
| `morphz provider` | Inspect and verify model providers |
| `morphz provider list` | List catalog and configured providers |
| `morphz provider test` | Verify a provider catalog, stream and tool call |
| `morphz provider show` | Show one effective Provider Instance |
| `morphz provider set` | Validate and persist a Provider Instance TOML file |
| `morphz provider account` | Manage provider authentication accounts |
| `morphz provider account list` | List account configuration and runtime state |
| `morphz provider account login` | Start an OAuth login |
| `morphz provider account complete` | Complete or poll an OAuth login |
| `morphz provider account logout` | Revoke a stored OAuth login |
| `morphz provider account set` | Validate and persist non-secret Auth Account TOML |
| `morphz provider account enable` | Enable one account |
| `morphz provider account disable` | Disable one account |
| `morphz provider account test` | Diagnose one account through a compatible Model Route |
| `morphz model` | Discover or select models |
| `morphz model list` | List models exposed by a provider |
| `morphz model use` | Persist the default provider and model |
| `morphz model refresh` | Refresh and verify the remote catalog for one Model Route |
| `morphz model route` | Manage logical Model Routes |
| `morphz model route list` | List effective Model Routes |
| `morphz model route show` | Show one Model Route |
| `morphz model route set` | Validate and persist a Model Route TOML file |
| `morphz model route test` | Diagnose route resolution, account auth and provider health |
| `morphz profile` | Inspect or select configuration profiles |
| `morphz profile list` | List available profiles |
| `morphz profile show` | Show the resolved contents of a profile |
| `morphz profile use` | Select the default profile |
| `morphz context` | Inspect persistent Cognitive Contexts |
| `morphz context list` | List Cognitive Contexts |
| `morphz context show` | Show one Cognitive Context |
| `morphz context status` | Show Context state, Sessions and active work |
| `morphz context audit` | Verify the Context Mind projection against its event history |
| `morphz context recall-index` | Inspect or rebuild the derived lexical Recall index |
| `morphz context recall-index inspect` | Show Recall index capability and document counts |
| `morphz context recall-index rebuild` | Rebuild the derived Recall index from Event History and Mind |
| `morphz context recall` | Search Context memory or traverse one Mind Frame lineage |
| `morphz context recall search` | Search indexed Event and Mind Frame documents |
| `morphz context recall frame` | Traverse Mind Frame sources and relations |
| `morphz scheduler` | Inspect authoritative Scheduler state |
| `morphz scheduler show` | Show Threads, activations, jobs, approvals and schedules |
| `morphz scheduler thread` | Inspect and control one durable Thread |
| `morphz scheduler thread show` | Show one Thread causal chain and structured Outcome |
| `morphz scheduler thread pause` | Pause a Thread |
| `morphz scheduler thread resume` | Resume a Thread |
| `morphz scheduler thread close` | Close a Thread |
| `morphz session` | Manage Session identities and Context mounts |
| `morphz session list` | List Sessions |
| `morphz session show` | Show one Session |
| `morphz session create` | Create a Session mounted in a selected Context |
| `morphz session resume` | Reattach an existing or recently active Session |
| `morphz agent` | Manage persistent Agents |
| `morphz agent list` | List Agents |
| `morphz agent show` | Show one Agent |
| `morphz agent create` | Create an Agent with a Root Context and initial Session |
| `morphz harness` | Install and inspect versioned Harness packages |
| `morphz harness list` | List installed Harness versions |
| `morphz harness show` | Show one exact installed Harness version |
| `morphz harness install` | Validate and install a .hns file or directory |
| `morphz objective` | Manage long-lived Objectives |
| `morphz objective list` | List Objectives in a Context |
| `morphz objective show` | Show one Objective |
| `morphz objective create` | Create and run a long-lived Objective |
| `morphz objective edit` | Replace an Objective goal using revision fencing |
| `morphz objective pause` | Pause an Objective |
| `morphz objective resume` | Resume an Objective |
| `morphz objective cancel` | Cancel an Objective |
| `morphz job` | Inspect or cancel delegated Sub Agent jobs |
| `morphz job list` | List delegated jobs |
| `morphz job cancel` | Cancel a delegated job and its descendants |
| `morphz config` | Inspect resolved configuration and provenance |
| `morphz config show` | Print the resolved configuration |
| `morphz config check` | Validate all loaded configuration layers |
| `morphz config path` | List loaded configuration files in precedence order |
| `morphz config explain` | Explain the source of every resolved value |
| `morphz doctor` | Check storage, workspace, permissions and provider setup |
| `morphz completion` | Generate shell completion definitions |
| `morphz version` | Print the Morphz version |

## Top-level command help

```text
Morphz is an S-Expression Cognitive Machine with persistent Context, Sessions, Objectives and a fullscreen terminal UI. The language model is its nondeterministic semantic processor; the Runtime is its deterministic transactional kernel.

Text entered without a subcommand is sent directly to the selected Agent instance.

Usage: morphz [OPTIONS] [PROMPT]... [COMMAND]

Commands:
  exec
          Run one prompt and print the final reply
  resume
          Reattach an existing or recently active Session
  serve
          Start the HTTP/WebSocket runtime and embedded Dashboard
  dashboard
          Start the Dashboard and open it in the default browser
  edge
          Pair and run an outbound Execution Node
  target
          Inspect and administer Execution Targets
  lease
          Inspect and revoke Target capability leases
  execution
          Inspect and control durable physical Execution Jobs
  setup
          Open guided model provider setup
  provider
          Inspect and verify model providers
  model
          Discover or select models
  profile
          Inspect or select configuration profiles
  context
          Inspect persistent Cognitive Contexts
  scheduler
          Inspect authoritative Scheduler state
  session
          Manage Session identities and Context mounts
  agent
          Manage persistent Agents
  harness
          Install and inspect versioned Harness packages
  objective
          Manage long-lived Objectives
  job
          Inspect or cancel delegated Sub Agent jobs
  config
          Inspect resolved configuration and provenance
  doctor
          Check storage, workspace, permissions and provider setup
  completion
          Generate shell completion definitions
  version
          Print the Morphz version
  help
          Print this message or the help of the given subcommand(s)

Arguments:
  [PROMPT]...
          Send text directly to the Agent

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration

      --config-file <FILE>
          Load an explicit trusted configuration file

  -p, --profile <NAME>
          Load a named configuration profile

      --provider <ID>
          Override the configured model provider

  -m, --model <MODEL>
          Override the configured model

      --reasoning-effort <LEVEL>
          Set model reasoning effort

          [possible values: default, auto, none, off, low, medium, high, max]

      --agent <ID>
          Select an Agent

      --context <ID>
          Select or mount a Cognitive Context

      --session <ID>
          Reattach an existing Session

      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation

  -s, --sandbox <MODE>
          Set the command sandbox mode

          [possible values: workspace-write, full-access, danger-full-access]

  -a, --approval <MODE>
          Set the approval policy

          [possible values: human, ask, auto, auto-review, never, deny]

      --add-dir <DIR>
          Add a readable and writable directory

      --network[=<BOOL>]
          Allow sandboxed commands to access the network

          [possible values: true, false, 1, 0, yes, no, on, off]

  -c, --set <KEY=VALUE>
          Override one configuration value

      --log-level <FILTER>
          Override the tracing filter

      --theme <THEME>
          Select the TUI color theme

          [possible values: system, mono, iris, cyan, coral, no-color]

      --language <LANGUAGE>
          Select the user-interface language

          [possible values: auto, en, zh-CN]

      --format <FORMAT>
          Select management-command output format

          [possible values: human, json]

      --tui
          Force the fullscreen terminal UI

      --plain
          Use the classic line-oriented terminal

  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version

Examples:
  morphz
  morphz please help me fix this project
  morphz -- session list
  morphz session list --format=json
  morphz resume --context=context-default
```

### `morphz exec`

Run one prompt and print the final reply

```text
Run one prompt and print the final reply

Usage: morphz exec [OPTIONS] <PROMPT>...

Arguments:
  <PROMPT>...
          Prompt to send to the Agent

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Examples:
  morphz exec explain this repository
  morphz exec -- --text-that-starts-with-a-dash
```

### `morphz resume`

Reattach an existing or recently active Session

```text
Reattach a Session without changing its identity. With no ID, resumes the most recently active matching Session.

Usage: morphz resume [OPTIONS] [[SESSION] [PROMPT]]...

Arguments:
  [[SESSION] [PROMPT]]...
          Optional Session ID followed by an optional prompt

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration

      --last
          Resume the most recently active matching Session

      --config-file <FILE>
          Load an explicit trusted configuration file

  -p, --profile <NAME>
          Load a named configuration profile

      --provider <ID>
          Override the configured model provider

  -m, --model <MODEL>
          Override the configured model

      --reasoning-effort <LEVEL>
          Set model reasoning effort

          [possible values: default, auto, none, off, low, medium, high, max]

      --agent <ID>
          Select an Agent

      --context <ID>
          Select or mount a Cognitive Context

      --session <ID>
          Reattach an existing Session

      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation

  -s, --sandbox <MODE>
          Set the command sandbox mode

          [possible values: workspace-write, full-access, danger-full-access]

  -a, --approval <MODE>
          Set the approval policy

          [possible values: human, ask, auto, auto-review, never, deny]

      --add-dir <DIR>
          Add a readable and writable directory

      --network[=<BOOL>]
          Allow sandboxed commands to access the network

          [possible values: true, false, 1, 0, yes, no, on, off]

  -c, --set <KEY=VALUE>
          Override one configuration value

      --log-level <FILTER>
          Override the tracing filter

      --theme <THEME>
          Select the TUI color theme

          [possible values: system, mono, iris, cyan, coral, no-color]

      --language <LANGUAGE>
          Select the user-interface language

          [possible values: auto, en, zh-CN]

      --format <FORMAT>
          Select management-command output format

          [possible values: human, json]

      --tui
          Force the fullscreen terminal UI

      --plain
          Use the classic line-oriented terminal

  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version

Examples:
  morphz resume
  morphz resume session_123
  morphz resume session_123 continue the task
  morphz resume --context=context-default
```

### `morphz serve`

Start the HTTP/WebSocket runtime and embedded Dashboard

```text
Start the HTTP/WebSocket runtime and embedded Dashboard. Loopback addresses may run without Dashboard authentication; non-loopback addresses require MORPHZ_DASHBOARD_TOKEN.

Usage: morphz serve [OPTIONS]

Options:
      --bind <ADDR>
          Listen address

  -C, --cwd <DIR>
          Change working directory before loading configuration

      --config-file <FILE>
          Load an explicit trusted configuration file

  -p, --profile <NAME>
          Load a named configuration profile

      --provider <ID>
          Override the configured model provider

  -m, --model <MODEL>
          Override the configured model

      --reasoning-effort <LEVEL>
          Set model reasoning effort

          [possible values: default, auto, none, off, low, medium, high, max]

      --agent <ID>
          Select an Agent

      --context <ID>
          Select or mount a Cognitive Context

      --session <ID>
          Reattach an existing Session

      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation

  -s, --sandbox <MODE>
          Set the command sandbox mode

          [possible values: workspace-write, full-access, danger-full-access]

  -a, --approval <MODE>
          Set the approval policy

          [possible values: human, ask, auto, auto-review, never, deny]

      --add-dir <DIR>
          Add a readable and writable directory

      --network[=<BOOL>]
          Allow sandboxed commands to access the network

          [possible values: true, false, 1, 0, yes, no, on, off]

  -c, --set <KEY=VALUE>
          Override one configuration value

      --log-level <FILTER>
          Override the tracing filter

      --theme <THEME>
          Select the TUI color theme

          [possible values: system, mono, iris, cyan, coral, no-color]

      --language <LANGUAGE>
          Select the user-interface language

          [possible values: auto, en, zh-CN]

      --format <FORMAT>
          Select management-command output format

          [possible values: human, json]

      --tui
          Force the fullscreen terminal UI

      --plain
          Use the classic line-oriented terminal

  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version

Examples:
  morphz serve
  morphz serve --bind=127.0.0.1:9090
  MORPHZ_DASHBOARD_TOKEN=replace-with-a-secret morphz serve --bind=0.0.0.0:8080
```

### `morphz dashboard`

Start the Dashboard and open it in the default browser

```text
Start the embedded Dashboard with a cryptographically random temporary authentication token and open its local URL in the default browser.

Usage: morphz dashboard [OPTIONS]

Options:
      --bind <ADDR>
          Listen address

  -C, --cwd <DIR>
          Change working directory before loading configuration

      --config-file <FILE>
          Load an explicit trusted configuration file

      --no-open
          Print the Dashboard URL without opening a browser

  -p, --profile <NAME>
          Load a named configuration profile

      --provider <ID>
          Override the configured model provider

  -m, --model <MODEL>
          Override the configured model

      --reasoning-effort <LEVEL>
          Set model reasoning effort

          [possible values: default, auto, none, off, low, medium, high, max]

      --agent <ID>
          Select an Agent

      --context <ID>
          Select or mount a Cognitive Context

      --session <ID>
          Reattach an existing Session

      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation

  -s, --sandbox <MODE>
          Set the command sandbox mode

          [possible values: workspace-write, full-access, danger-full-access]

  -a, --approval <MODE>
          Set the approval policy

          [possible values: human, ask, auto, auto-review, never, deny]

      --add-dir <DIR>
          Add a readable and writable directory

      --network[=<BOOL>]
          Allow sandboxed commands to access the network

          [possible values: true, false, 1, 0, yes, no, on, off]

  -c, --set <KEY=VALUE>
          Override one configuration value

      --log-level <FILTER>
          Override the tracing filter

      --theme <THEME>
          Select the TUI color theme

          [possible values: system, mono, iris, cyan, coral, no-color]

      --language <LANGUAGE>
          Select the user-interface language

          [possible values: auto, en, zh-CN]

      --format <FORMAT>
          Select management-command output format

          [possible values: human, json]

      --tui
          Force the fullscreen terminal UI

      --plain
          Use the classic line-oriented terminal

  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version

Examples:
  morphz dashboard
  morphz dashboard --no-open
  morphz dashboard --bind=0.0.0.0:8080
```

### `morphz edge`

Pair and run an outbound Execution Node

```text
Pair and run an outbound Execution Node

Usage: morphz edge [OPTIONS] [COMMAND]

Commands:
  pairing-code
          Create a short-lived pairing code for the current Principal
  nodes
          List Execution Nodes owned by the current Principal
  revoke
          Revoke one paired Execution Node
  local-leases
          List Provider-local capability leases for this Node
  revoke-local-lease
          Revoke one Provider-local capability lease
  pair
          Pair this device with a Morphz Gateway
  run
          Run the authenticated outbound Edge worker
  rotate-key
          Rotate this Node's device identity key
  status
          Show the paired Node credential and local Target identity
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version
```

### `morphz target`

Inspect and administer Execution Targets

```text
Inspect and administer Execution Targets

Usage: morphz target [OPTIONS] [COMMAND]

Commands:
  list
          List Targets visible to the current Principal
  show
          Inspect one Target
  enable
          Enable one Target
  disable
          Disable one Target
  authorize
          Restrict a Target to an Agent, Context or Thread scope
  authorizations
          List scoped Target authorizations
  revoke-authorization
          Revoke one scoped Target authorization
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version
```

### `morphz lease`

Inspect and revoke Target capability leases

```text
Inspect and revoke Target capability leases

Usage: morphz lease [OPTIONS] [COMMAND]

Commands:
  list
          List active capability leases
  revoke
          Revoke one capability lease
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version
```

### `morphz execution`

Inspect and control durable physical Execution Jobs

```text
Inspect and control durable physical Execution Jobs

Usage: morphz execution [OPTIONS] [COMMAND]

Commands:
  list
          List Execution Jobs
  show
          Inspect one Execution Job
  output
          Read durable stdout/stderr chunks for one Job
  cancel
          Request cancellation of one Job
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version
```

### `morphz setup`

Open guided model provider setup

```text
Start the embedded Dashboard directly in guided model provider setup. Use --tui for the fullscreen terminal wizard on SSH or systems without a browser.

Usage: morphz setup [OPTIONS]

Options:
      --bind <ADDR>
          Dashboard listen address

  -C, --cwd <DIR>
          Change working directory before loading configuration

      --config-file <FILE>
          Load an explicit trusted configuration file

      --no-open
          Print the Setup URL without opening a browser

  -p, --profile <NAME>
          Load a named configuration profile

      --provider <ID>
          Override the configured model provider

  -m, --model <MODEL>
          Override the configured model

      --reasoning-effort <LEVEL>
          Set model reasoning effort

          [possible values: default, auto, none, off, low, medium, high, max]

      --agent <ID>
          Select an Agent

      --context <ID>
          Select or mount a Cognitive Context

      --session <ID>
          Reattach an existing Session

      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation

  -s, --sandbox <MODE>
          Set the command sandbox mode

          [possible values: workspace-write, full-access, danger-full-access]

  -a, --approval <MODE>
          Set the approval policy

          [possible values: human, ask, auto, auto-review, never, deny]

      --add-dir <DIR>
          Add a readable and writable directory

      --network[=<BOOL>]
          Allow sandboxed commands to access the network

          [possible values: true, false, 1, 0, yes, no, on, off]

  -c, --set <KEY=VALUE>
          Override one configuration value

      --log-level <FILTER>
          Override the tracing filter

      --theme <THEME>
          Select the TUI color theme

          [possible values: system, mono, iris, cyan, coral, no-color]

      --language <LANGUAGE>
          Select the user-interface language

          [possible values: auto, en, zh-CN]

      --format <FORMAT>
          Select management-command output format

          [possible values: human, json]

      --tui
          Force the fullscreen terminal UI

      --plain
          Use the classic line-oriented terminal

  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version

Examples:
  morphz setup
  morphz setup --tui
  morphz setup --no-open --bind=127.0.0.1:9090
```

### `morphz provider`

Inspect and verify model providers

```text
Inspect and verify model providers

Usage: morphz provider [OPTIONS] [COMMAND]

Commands:
  list
          List catalog and configured providers
  test
          Verify a provider catalog, stream and tool call
  show
          Show one effective Provider Instance
  set
          Validate and persist a Provider Instance TOML file
  account
          Manage provider authentication accounts
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Run `morphz provider <COMMAND> --help` for command-specific help.
```

### `morphz model`

Discover or select models

```text
Discover or select models

Usage: morphz model [OPTIONS] [COMMAND]

Commands:
  list
          List models exposed by a provider
  use
          Persist the default provider and model
  refresh
          Refresh and verify the remote catalog for one Model Route
  route
          Manage logical Model Routes
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Run `morphz model <COMMAND> --help` for command-specific help.
```

### `morphz profile`

Inspect or select configuration profiles

```text
Inspect or select configuration profiles

Usage: morphz profile [OPTIONS] [COMMAND]

Commands:
  list
          List available profiles
  show
          Show the resolved contents of a profile
  use
          Select the default profile
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Run `morphz profile <COMMAND> --help` for command-specific help.
```

### `morphz context`

Inspect persistent Cognitive Contexts

```text
Inspect persistent Cognitive Contexts

Usage: morphz context [OPTIONS] [COMMAND]

Commands:
  list
          List Cognitive Contexts
  show
          Show one Cognitive Context
  status
          Show Context state, Sessions and active work
  audit
          Verify the Context Mind projection against its event history
  recall-index
          Inspect or rebuild the derived lexical Recall index
  recall
          Search Context memory or traverse one Mind Frame lineage
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Run `morphz context <COMMAND> --help` for command-specific help.
```

### `morphz scheduler`

Inspect authoritative Scheduler state

```text
Inspect authoritative Scheduler state

Usage: morphz scheduler [OPTIONS] [COMMAND]

Commands:
  show
          Show Threads, activations, jobs, approvals and schedules
  thread
          Inspect and control one durable Thread
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Run `morphz scheduler <COMMAND> --help` for command-specific help.
```

### `morphz session`

Manage Session identities and Context mounts

```text
Manage Session identities and Context mounts

Usage: morphz session [OPTIONS] [COMMAND]

Commands:
  list
          List Sessions
  show
          Show one Session
  create
          Create a Session mounted in a selected Context
  resume
          Reattach an existing or recently active Session
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Run `morphz session <COMMAND> --help` for command-specific help.
```

### `morphz agent`

Manage persistent Agents

```text
Manage persistent Agents

Usage: morphz agent [OPTIONS] [COMMAND]

Commands:
  list
          List Agents
  show
          Show one Agent
  create
          Create an Agent with a Root Context and initial Session
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Run `morphz agent <COMMAND> --help` for command-specific help.
```

### `morphz harness`

Install and inspect versioned Harness packages

```text
Install and inspect versioned Harness packages

Usage: morphz harness [OPTIONS] [COMMAND]

Commands:
  list
          List installed Harness versions
  show
          Show one exact installed Harness version
  install
          Validate and install a .hns file or directory
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Run `morphz harness <COMMAND> --help` for command-specific help.
```

### `morphz objective`

Manage long-lived Objectives

```text
Manage long-lived Objectives

Usage: morphz objective [OPTIONS] [COMMAND]

Commands:
  list
          List Objectives in a Context
  show
          Show one Objective
  create
          Create and run a long-lived Objective
  edit
          Replace an Objective goal using revision fencing
  pause
          Pause an Objective
  resume
          Resume an Objective
  cancel
          Cancel an Objective
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Run `morphz objective <COMMAND> --help` for command-specific help.
```

### `morphz job`

Inspect or cancel delegated Sub Agent jobs

```text
Inspect or cancel delegated Sub Agent jobs

Usage: morphz job [OPTIONS] [COMMAND]

Commands:
  list
          List delegated jobs
  cancel
          Cancel a delegated job and its descendants
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Run `morphz job <COMMAND> --help` for command-specific help.
```

### `morphz config`

Inspect resolved configuration and provenance

```text
Inspect resolved configuration and provenance

Usage: morphz config [OPTIONS] [COMMAND]

Commands:
  show
          Print the resolved configuration
  check
          Validate all loaded configuration layers
  path
          List loaded configuration files in precedence order
  explain
          Explain the source of every resolved value
  help
          Print this message or the help of the given subcommand(s)

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Run `morphz config <COMMAND> --help` for command-specific help.
```

### `morphz doctor`

Check storage, workspace, permissions and provider setup

```text
Check storage, workspace, permissions and provider setup

Usage: morphz doctor [OPTIONS]

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Example:
  morphz doctor
```

### `morphz completion`

Generate shell completion definitions

```text
Generate shell completion definitions

Usage: morphz completion [OPTIONS] <SHELL>

Arguments:
  <SHELL>
          Shell to generate completions for [possible values: bash, elvish, fish, powershell, zsh]

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Example:
  morphz completion zsh > ~/.zfunc/_morphz
```

### `morphz version`

Print the Morphz version

```text
Print the Morphz version

Usage: morphz version [OPTIONS]

Options:
  -C, --cwd <DIR>
          Change working directory before loading configuration
      --config-file <FILE>
          Load an explicit trusted configuration file
  -p, --profile <NAME>
          Load a named configuration profile
      --provider <ID>
          Override the configured model provider
  -m, --model <MODEL>
          Override the configured model
      --reasoning-effort <LEVEL>
          Set model reasoning effort [possible values: default, auto, none, off, low, medium, high, max]
      --agent <ID>
          Select an Agent
      --context <ID>
          Select or mount a Cognitive Context
      --session <ID>
          Reattach an existing Session
      --harness <ID@VERSION>
          Select an exact installed Harness for the initial Evaluation
  -s, --sandbox <MODE>
          Set the command sandbox mode [possible values: workspace-write, full-access, danger-full-access]
  -a, --approval <MODE>
          Set the approval policy [possible values: human, ask, auto, auto-review, never, deny]
      --add-dir <DIR>
          Add a readable and writable directory
      --network[=<BOOL>]
          Allow sandboxed commands to access the network [possible values: true, false, 1, 0, yes, no, on, off]
  -c, --set <KEY=VALUE>
          Override one configuration value
      --log-level <FILTER>
          Override the tracing filter
      --theme <THEME>
          Select the TUI color theme [possible values: system, mono, iris, cyan, coral, no-color]
      --language <LANGUAGE>
          Select the user-interface language [possible values: auto, en, zh-CN]
      --format <FORMAT>
          Select management-command output format [possible values: human, json]
      --tui
          Force the fullscreen terminal UI
      --plain
          Use the classic line-oriented terminal
  -h, --help
          Print help
  -V, --version
          Print version

Example:
  morphz version
```

## Discover deeper help

The current binary remains authoritative for every nested flag. Use `morphz help <COMMAND>` or append `--help` to any command path. Automation should consume `--format=json` and stable IDs instead of parsing human tables or translated text.
