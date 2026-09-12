---
title: Apps for an Agent: Cognitive Applications in Morphz
description: Morphz packages specialized working methods, reference knowledge, and executable programs as installable cognitive applications. The same agent can use different methods for different tasks while retaining its understanding of the user and the project.
published: 2026-09-09
author: Morphz Project
category: Product Mechanisms
---

An agent can write code, draft a novel, and help produce a video. Doing that work well takes more than a model that answers questions. Code review needs an inspection and verification method. A novel needs consistent characters and plot. Video editing needs operations organized around footage and a timeline.

Morphz organizes these specialized capabilities as **cognitive applications**: installable working methods, reference knowledge, and executable programs. The applications can differ while the agent remains the same, retaining its understanding of the user and the project and learning across the work it does.

`.hns` is Morphz's minimal cognitive application form. A single file can define a method, give it an identity and version, and make it available for an agent to use after installation. This article starts with these small, runnable applications to show how specialized capabilities become methods an agent can select for its work.

## The application supplies a method; the agent keeps its knowledge

A cognitive application gives the agent a domain-specific method for applying its general capabilities to a task.

A code review application, for example, can define which problems warrant a report, provide procedures for examining changes, and specify how to present verification results. The agent still knows the project's earlier decisions and the user's compatibility requirements. The application guides the work; the agent's existing knowledge helps it apply that guidance to this project.

When it later writes release notes, the agent can use another method. Findings from the review do not first have to become a handoff document for an assistant that took no part in the work. Once relevant conclusions have been committed to shared cognitive state, subsequent work can use them.

<figure class="article-figure">
  <a href="/images/articles/cognitive-applications-mechanism-en-v3.png" target="_blank" rel="noopener noreferrer" aria-label="Open the full mechanism diagram in a new window">
    <img src="/images/articles/cognitive-applications-mechanism-en-v3.png" width="1536" height="1024" loading="lazy" decoding="async" alt="Morphz minimal cognitive application mechanism: a .hns code-review application's Primary Harness loads its contract, reference knowledge, and programs into an evaluation. The same agent reads shared cognition and applies the application's methods. Findings worth retaining are committed through a context transaction, then reused by a subsequent release-notes evaluation. Both use the same runtime for tools, scheduling, transactions, and permissions." />
  </a>
  <figcaption>Code review and release notes illustrate how .hns minimal cognitive applications work: the same agent uses different methods, while subsequent work draws on cognition committed through context transactions. The two applications are illustrative examples. <span class="article-figure__hint">Click to enlarge.</span></figcaption>
</figure>

The method applies to a particular piece of work. The runtime binds a `.hns` package's Primary Harness to an evaluation: the reasoning and actions for the task at hand. Each evaluation binds one Primary Harness. Separate evaluations can select different methods and run concurrently under the same scheduler. A code review can keep examining changes while a writing task organizes chapters, each using the appropriate method.

## A working method can include executable code

Some instructions require judgment. Others describe steps a program can execute directly.

“Report only problems that affect actual use” calls for model judgment. “Read this file, then pass its contents to the model for analysis” can be a program. The model does not need to decide that sequence from scratch each time. A cognitive application can contain both.

Each `.hns` package carries one Primary Harness. As the minimal application's execution core, it brings together the contract, default cognition, and evaluation entry point:

- **A working contract:** the objects, requirements, and expected outcome.
- **Reference knowledge:** default knowledge and experience relevant to the method.
- **An entry program and functions:** executable procedures that call the model where judgment is needed.

Morphz's Yao language supports two entry points. With `infer`, the model chooses the next steps under the working contract, which suits open-ended tasks. With `eval`, the runtime executes a program and invokes the model at designated steps, which suits established procedures. Both use Morphz's existing tools, scheduling, and context transactions.

A file-review application can read a file in code and then ask the model to analyze it. This is a complete `.hns` minimal cognitive application. Save it as `file-review.hns`:

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

This example reads `README.md` in the working directory, then requests a review. Reading the file is a defined step; identifying problems and explaining their impact is the model's job. [Download the example package](/examples/file-review.hns) and start adapting its contract and review requirements to develop your own method.

A single `.hns` package can also encapsulate repeated steps in functions. The model sees an exported function's name, parameters, description, and required capabilities, and can call it when needed. The implementation does not all have to appear in the model's context.

A simple method can live in one file. Larger programs can be split across files in a `.hns` directory package. Both forms use the same installation and selection mechanisms.

## Install a .hns minimal application, select when needed

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

Ordinary conversations can use these minimal applications too; selecting one does not require creating a long-running objective first. The model can use `harness_list` to discover compact descriptions of installed `.hns` packages, then `harness_select` to choose an exact ID and version. The runtime loads the corresponding Primary Harness's contract, reference knowledge, and entry program in a subsequent evaluation.

The entire application catalog is not inserted into every request. The agent first discovers available methods, then loads the details of the selected one. Adding applications does not require every conversation to carry all their instructions.

Once an evaluation has selected a Primary Harness, the corresponding `.hns` package's ID, version, and content hash are recorded with the execution. Installing a newer version does not silently change the rules of work already in progress.

## Application knowledge and experience have different owners

An application's reference knowledge comes from its author. The agent's working experience comes from its own interactions. Morphz keeps them distinct.

A review application might provide the general method “confirm a problem before suggesting a change.” The requirement “this project must remain compatible with an older configuration format” may instead come from the user. The first is loaded with the application; the second belongs to the agent's own cognitive state.

Morphz presents the application's contract and default knowledge as read-only material for the evaluation. Installing or selecting an application does not automatically write that material into the agent's long-term state. If the model decides something is worth retaining, it still submits an explicit context transaction.

Changing applications therefore does not require clearing existing knowledge, and installation does not overwrite the agent's understanding of a project. Reusable methods and accumulated experience can evolve separately.

## Interfaces bring people into the work

People need appropriate interfaces for specialized work, too. A diff makes code changes visible. A character map can explain relationships more clearly than a paragraph in a chat reply. An edit needs to be played back and inspected.

Desktop has implemented the related interface features, but they have not yet been released. It uses interface packages that reference installed Harnesses to connect custom interfaces, work objects, and agent input, so people can collaborate with the agent around the work itself.

The design calls for an optional, platform-specific GUI. Clients that support it would render the interface, while execution would continue to use Morphz's cognition and task capabilities. A terminal would not need graphical rendering to run a cognitive application.

## Reuse the runtime, without building another agent

Application authors can concentrate on the domain: what information to collect, which steps to specify in code, which decisions to leave to the model, and how to check the result. Morphz continues to handle waiting threads, tool execution, context commits, and permissions.

Declaring that an application needs file access does not authorize it to read arbitrary files. Actual operations remain subject to execution-target authorization, sandboxing, and approval rules. Installation is not authorization, regardless of whether the model selects the application itself.

Starting with a `.hns` package, developers can turn their experience into methods and programs for an agent that already knows the user and the project. Methods evolve through versions; cognition continues to accumulate. Adding a specialized capability does not require rebuilding the agent's understanding of the people and projects it works with.

For more complete applications, Morphz has reserved `.coa` for application-level packaging: organizing execution methods, optional interfaces, and resources around an application's own identity and version. Its execution component can include or reference Harnesses. Simple cognitive applications can still be distributed and run directly as `.hns` packages.

See [Cognitive applications, domain programs, and Yao](/en/docs/cognitive-applications) and the [HNS package format specification](/en/standards/hns_package_format_specification_v0_1) for package and usage details. [Context transactions](/en/blog/maintaining-context-without-compaction) explain how shared knowledge changes, and [concurrent scheduling](/en/blog/one-agent-multiple-threads) explains how multiple pieces of work advance together.
