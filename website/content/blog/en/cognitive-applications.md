---
title: Apps for an Agent: Cognitive Applications in Morphz
description: Morphz packages specialized working methods, reference knowledge, and executable programs as installable cognitive applications. The same agent can use different methods for different tasks while retaining its understanding of the user and the project.
published: 2026-09-09
author: Morphz Project
category: Product Mechanisms
---

An agent can write code, draft a novel, and help produce a video. Doing that work well takes more than a model that answers questions. Code review needs an inspection and verification method. A novel needs consistent characters and plot. Video editing needs operations organized around footage and a timeline.

People need different interfaces for that work, too. A diff makes code changes visible. A character map can explain relationships more clearly than a paragraph in a chat reply. An edit needs to be played back and inspected.

Morphz organizes these specialized capabilities as **cognitive applications**: installable working methods, reference knowledge, and executable programs. The applications can differ while the agent remains the same, retaining its understanding of the user and the project and learning across the work it does. Specialized interfaces to accompany these methods are still being explored in the desktop client.

## The application supplies a method; the agent keeps its knowledge

A cognitive application gives the agent a domain-specific method for applying its general capabilities to a task.

A code review application, for example, can define which problems warrant a report, provide procedures for examining changes, and specify how to present verification results. The agent still knows the project's earlier decisions and the user's compatibility requirements. The application guides the work; the agent's existing knowledge helps it apply that guidance to this project.

When it later writes release notes, the agent can use another method. Findings from the review do not first have to become a handoff document for an assistant that took no part in the work. Once relevant conclusions have been committed to shared cognitive state, subsequent work can use them.

<figure class="article-figure">
  <a href="/images/articles/cognitive-applications-en-v1.svg" target="_blank" rel="noopener noreferrer" aria-label="Open the full diagram in a new window">
    <img src="/images/articles/cognitive-applications-en-v1.svg" width="600" height="470" loading="lazy" decoding="async" alt="One Morphz agent retains shared project knowledge, user requirements, and experience. Code review and release writing use separate applications, submitting actions and context changes to the same runtime." />
  </a>
  <figcaption>Two pieces of work can use different applications while sharing the same cognitive state. The review and release-writing applications illustrate the design; they are not a list of bundled apps. <span class="article-figure__hint">Click to enlarge.</span></figcaption>
</figure>

An application is not a global mode for the entire agent. Morphz binds it to a particular evaluation: the reasoning and actions for the work at hand. Separate evaluations can use different applications and run concurrently under the same scheduler. Selecting a writing application for one piece of work does not switch an ongoing code review into writing mode.

## A working method can include executable code

Some instructions require judgment. Others describe steps a program can execute directly.

“Report only problems that affect actual use” calls for model judgment. “Read this file, then pass its contents to the model for analysis” can be a program. The model does not need to decide that sequence from scratch each time. A cognitive application can contain both.

Morphz currently distributes the execution component of cognitive applications as `.hns` packages. The domain program inside a package is called a Harness. It organizes reasoning and execution for the work. A package can provide:

- **A working contract:** the objects, requirements, and expected outcome.
- **Reference knowledge:** default knowledge and experience relevant to the method.
- **An entry program and functions:** executable procedures that call the model where judgment is needed.

Morphz's Yao language supports two entry points. With `infer`, the model chooses the next steps under the working contract, which suits open-ended tasks. With `eval`, the runtime executes a program and invokes the model at designated steps, which suits established procedures. Both use Morphz's existing tools, scheduling, and context transactions.

A file-review application can read a file in code and then ask the model to analyze it. This complete minimal package can be saved as `file-review.hns`:

```lisp
(manifest
  (id file-review)
  (version "1.0.0")
  (title "File Review")
  (capabilities (tools read)))

(contract
  (purpose "Review the supplied file for concrete issues.")
  (output "Explain each issue and its impact. Do not invent test results."))

(eval
  (requires (tools read))
  (seq
    (bind document
      (call read (path "README.md")))
    (infer
      (captures document)
      (returns String)
      "Review this document using the current contract.")))
```

This example reads only `README.md` in the working directory, then requests a review. Reading the file is a defined step; identifying problems and explaining their impact is the model's job. It demonstrates how an application runs, not a complete code review methodology. [Download the example package](/examples/file-review.hns) to try it.

Larger applications can encapsulate repeated steps in functions. The model sees an exported function's name, parameters, description, and required capabilities, and can call it when needed. The implementation does not all have to appear in the model's context.

## Install once, select when needed

Install the example file with:

```bash
morphz harness install ./file-review.hns
morphz harness list --format=json
```

Installation validates the package structure and stores an exact version. It does not execute the program. To use the method for an objective:

```bash
morphz objective create --harness=file-review@1.0.0 \
  "Review README.md and explain any concrete issues."
```

Ordinary conversations can use applications too; selecting one does not require creating a long-running objective first. The model can use `harness_list` to discover compact descriptions of installed applications, then `harness_select` to choose an exact ID and version. The runtime loads that application's contract, reference knowledge, and entry program in a subsequent evaluation.

The entire application catalog is not inserted into every request. The agent first discovers available methods, then loads the details of the selected one. Adding applications does not require every conversation to carry all their instructions.

Once an evaluation has selected an application, its ID, version, and content hash are recorded with the execution. Installing a newer version does not silently change the rules of work already in progress.

## Application knowledge and experience have different owners

An application's reference knowledge comes from its author. The agent's working experience comes from its own interactions. Morphz keeps them distinct.

A review application might provide the general method “confirm a problem before suggesting a change.” The requirement “this project must remain compatible with an older configuration format” may instead come from the user. The first is loaded with the application; the second belongs to the agent's own cognitive state.

Morphz presents the application's contract and default knowledge as read-only material for the evaluation. Installing or selecting an application does not automatically write that material into the agent's long-term state. If the model decides something is worth retaining, it still submits an explicit context transaction.

Changing applications therefore does not require clearing existing knowledge, and installation does not overwrite the agent's understanding of a project. Reusable methods and accumulated experience can evolve separately.

## Interface extensions: an exploration in the desktop client

The current HNS specification defines the execution component of cognitive applications. Morphz core has not yet implemented a UI specification or its supporting mechanisms. The desktop client currently has a provisional implementation of its own.

We want specialized applications to provide appropriate interfaces for people, too. A novel-writing application could place character notes beside chapters: a user selects a passage and requests a revision, and the agent uses those notes to rewrite it. An editing application could display footage, a preview, and a timeline for the user to inspect.

The design calls for an optional, platform-specific GUI. Clients that support it would render the interface, while execution would continue to use Morphz's cognition and task capabilities. A terminal would not need graphical rendering to run a cognitive application.

The desktop client currently uses provisional interface packages that reference installed Harnesses, exploring how to connect custom interfaces, work objects, and agent input. This tests the interaction model; it is not a unified UI contract for Morphz cognitive applications.

## Reuse the runtime, without building another agent

Application authors can concentrate on the domain: what information to collect, which steps to specify in code, which decisions to leave to the model, and how to check the result. Morphz continues to handle waiting threads, tool execution, context commits, and permissions.

Declaring that an application needs file access does not authorize it to read arbitrary files. Actual operations remain subject to execution-target authorization, sandboxing, and approval rules. Installation is not authorization, regardless of whether the model selects the application itself.

Morphz currently supports loading, installing, and running atomic `.hns` applications, with exact-version selection, both evaluation entry points, and package-local functions. A unified composite package format and a remote application marketplace remain future work.

Cognitive applications let developers build methods and programs for a kind of work, to be used by an agent that already knows the user and the project. Its methods can expand while its existing understanding and experience remain useful in new tasks.

See [Cognitive applications, domain programs, and Yao](/en/docs/cognitive-applications) for package and usage details. [Context transactions](/en/blog/maintaining-context-without-compaction) explain how shared knowledge changes, and [concurrent scheduling](/en/blog/one-agent-multiple-threads) explains how multiple pieces of work advance together.
