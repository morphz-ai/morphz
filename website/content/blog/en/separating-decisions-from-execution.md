---
title: Separating Decisions from Execution: How Morphz Calls Tools
description: Different devices can use the same agent, sharing sessions, work in progress, and cognition while retaining their own execution environments. This article explains how Morphz separates decisions from execution to make that possible.
published: 2026-09-08
author: Morphz Project
category: Engineering
---

Putting session management, model calls, and tool execution in one local program is a straightforward way to build an agent. But a user's work may span more than that computer. If each environment gets an independent agent, background has to be explained again and progress synchronized separately. Distributing the tools ends up dividing the understanding of the work as well.

That coupling is unnecessary. Accessing local files and running local software requires a program that can execute operations there. It does not require the agent that understands the task and makes decisions to be deployed there too. The execution program and the agent can communicate over a network.

Morphz separates decisions from execution on that basis. One agent service maintains cognition, sessions, and tasks; devices provide their own files, tools, and computing resources. Users can reach the same agent from a different terminal, and adding another execution environment does not require another independent body of cognition.

<figure class="article-figure">
  <a href="/images/articles/decision-execution-en-v2.png" target="_blank" rel="noopener noreferrer" aria-label="Open the full-size illustration in a new tab">
    <img src="/images/articles/decision-execution-en-v2.png" width="1536" height="1024" loading="lazy" decoding="async" alt="Three user computers connect to one Morphz agent service. The service maintains cognition, tasks, and sessions and calls a cloud LLM. Computers retain their own files, tools, and permissions, receive operations, and return results. They do not need to pair with each other or select a primary computer." />
  </a>
  <figcaption>Clients access the same agent's service state, while devices provide their own execution environments. The connections represent session interaction and tool calls, not automatic file replication between computers. <span class="article-figure__hint">Click the image to view it full-size.</span></figcaption>
</figure>

## The same agent across devices

Morphz manages sessions, cognition, and execution devices separately. A session handles interaction with the user. Cognition holds the agent's understanding of the work. An execution device determines where file operations and commands actually run.

The terminal from which a message arrives therefore does not determine where the task must execute. A user can check progress and give instructions from one terminal while the work runs on a connected, authorized device.

Morphz already supports multiple sessions sharing one cognitive context. Judgments and experience formed in one session can be used in another. Each session retains its own input, output, and progress, with replies routed back to the session that initiated the interaction. Users can continue existing work from a different terminal or start a new session for something else.

Sessions can also advance work concurrently. While one waits for a tool result, another can handle a new request. Work threads modify shared cognition through context transactions, with the runtime managing commits and conflict checks. Execution results return to the appropriate thread rather than losing their ownership when the user switches terminals.

Continuity across devices is therefore not a matter of moving memories between independent agents. Users access the same agent, whose service already maintains the tasks, sessions, and cognition they need to continue.

## Keep tools in the environments that need them

Agents are often installed on a user's computer because they need its files, commands, and software. The model endpoint may be in the cloud, but changing a project, running tests, or accessing a private-network service still requires the appropriate execution environment.

Those requirements determine where an operation must happen. They do not require the decision-making agent logic to be deployed there too.

Morphz models execution environments separately. The agent service organizes model calls, maintains context, and schedules work. Execution programs carry out operations in the specified environment and return results. The two parts can run on the same machine or communicate over a network.

A user's computer can run just `morphz-edge`. It does not call a model or maintain another agent's cognition. After pairing with the service, it establishes an outbound connection, receives operations, checks permissions locally, and executes them. This also works for private-network devices that the service cannot reach directly.

Each computer connects to the service independently. Computers do not have to pair with each other or choose a primary machine. Connecting a device means declaring the capabilities and permissions it provides, not setting up another agent to take responsibility for the same work.

## How a tool call reaches the right device

When one agent uses several environments, each tool call needs an unambiguous destination. Otherwise, even the meaning of a command's working directory becomes unclear.

Morphz uses an Execution Target to identify the environment in which an operation happens. Each target has a stable identity and records its platform, workspace, available tools, authorization scope, and connection state. The model can discover targets with `list_targets`, examine one with `inspect_target`, and resolve an SSH destination with `resolve_target`.

The `target` argument specifies where a tool runs. For example, suppose a Linux test machine is registered as `target-linux-tests`, with the code to test already available in its `/srv/project` directory. The model can submit this request to `exec`:

```json
{
  "target": "target-linux-tests",
  "command": "cargo test",
  "cwd": "/srv/project"
}
```

The request uses the test machine's directory, commands, and dependencies. The location of the Morphz service does not change what those arguments mean. Preparing and transferring code and files must also account for the target environment.

A work thread retains its execution target. Its first physical operation establishes the binding; subsequent calls that omit `target` inherit that destination. Work on another machine belongs to a new thread bound to that target. Changing a session's default device does not silently move an executing thread to another machine.

Local execution, managed SSH, and edge nodes currently connect through a common execution interface. Local execution uses local tools. Managed SSH lets the runtime handle connections and host-key verification. Edge nodes receive work through outbound connections. The model uses the capabilities a target provides without rebuilding the connection procedure for every call.

## Execution jobs have their own identity and state

Sending a tool call to a remote machine only solves delivery. The work also needs a record of whether the operation started, how far it got, whether it completed, and who should receive its result.

When Morphz admits a tool call, it records an execution job with its agent, work thread, originating call, and target. The runtime checks capabilities and authorization, dispatches the job to the appropriate executor, and records the execution route and state.

Output, exit status, and completion events return to the runtime and reach the corresponding work thread. The agent uses the result to make its next decision, update cognition, or arrange further operations.

The job's identity also matters when a connection is unreliable. A disconnected link does not prove that a command never ran. If the outcome cannot yet be confirmed, the records and actual target state need to be checked rather than casually resubmitting the request to another device.

Devices still need to be online to provide their tools. If a user's computer is offline, work that depends on its local files and environment cannot continue there. Preserving the task's state in the service does not substitute for an unavailable device.

## Permissions and data handling

Connecting devices to the same agent does not require identical permissions. A development machine might allow project changes, while a production server allows only log reads. Morphz checks authorization to use the target as well as permission for the particular operation. Edge devices retain local checks and revocation controls.

The sandbox limits accessible resources, and approval determines whether an operation is allowed. Reusable permissions are managed through scoped, expiring capability leases. Approving an operation does not open the entire device indefinitely.

When a local agent uses a cloud LLM, content selected for its requests already goes to the model service. With an agent service, that content is organized by the agent service before entering the model request. Keeping execution local and cognition in the cloud neither makes the data public nor requires uploading every file on the computer.

A third-party agent host becomes another participant in that processing path and needs clear access, logging, and retention policies. Self-hosting lets the user manage that part of the path. Data handling depends on concrete permissions and service policies, not simply on whether the agent is labeled local or cloud-based.

## Execution environments extend beyond personal computers

Separating decisions from execution does not require the agent to run in the cloud.

A user can run the agent locally and send code that needs isolation to a remote sandbox. Alternatively, the agent can run as a cloud service and use environments on user computers through Edge. The division of responsibilities is the same; the locations differ.

The existing local, SSH, and edge-node interfaces let different machines expose capabilities this way. A remote sandbox can also be attached through an execution interface, with its environment managing file preparation, permissions, and job cleanup.

The same interface opens up possible integrations with robots, peripherals, and other devices. Each would need its own control, feedback, and safety adaptations, but not an independent implementation of the entire agent. New execution capabilities can be used by the existing agent in the context of its tasks and cognition.

## From a single-machine program to an agent service

Once execution environments are independent, the agent can be built and operated as a persistent service. Cognition, sessions, and task state are maintained by the service, while separately connected devices provide execution capabilities. Updating agent logic need not require updating every device's executor at the same time, and adding or replacing a device need not move the whole agent.

Engineering responsibilities become clearer: the service manages state, scheduling, and recovery; execution environments manage resources and operation permissions. Morphz's persistent job records, version checks, and execution-state tracking help those parts work reliably together, including when a connection does not complete cleanly.

For users, the change is in how they use the agent. Different terminals can reach the same agent that understands the work in progress. The agent can then use the environment appropriate to the task.

Configuration and setup are covered in [Workspaces and Execution Targets](/en/docs/execution-targets). See [Sessions and Concurrent Work](/en/docs/sessions-and-concurrency) for shared cognition, and [Threads, Activations, and Objectives](/en/docs/execution-lifecycle) for the relationship between execution jobs and work threads.
