// Independently captured from committed Git, never from the candidate. Only
// the controller statements and five original action arrows are retained.
// Full-file migration proof is temporary evidence, not an ordinary CI lock.
export const fixedTaskRunPanel = {
  git: "d93326c0114bc6e77b2f50b0f6a19a86dd9cd774",
  path: "application/apps/web/src/TaskRunPanel.tsx",
  sourceSha256:
    "b833401c4e2a5e65adbdc31b2ff2222c80fc8d372c5fc1340365f35d27a08a05",
  statements: [
    {
      raw: "const pending = useRef(false);",
      sha256:
        "5f2f7a45e8726aa4231d952cc23cd2d4beef3fe0f37160e4a5aa458693750b28",
    },
    {
      raw: "const [busy, setBusy] = useState(false);",
      sha256:
        "1f6d272bc2bb940be854a8e42fc2acded5318dfbabd464d9d25a789876be45b9",
    },
    {
      raw: 'const [error, setError] = useState("");',
      sha256:
        "3a977a4d19d1b651616b8ad28f4eb535fc46c31cc1e9a37c98aca97896e923b1",
    },
    {
      raw: 'const [localReadError, setReadError] = useState("");',
      sha256:
        "da78f3994db76b0c988fc20861ec7b4ab26de2c22e73c888cda341de15d93fbc",
    },
    {
      raw: 'const readError = runtimeObserved ? (runtimeReadError ?? "") : localReadError;',
      sha256:
        "02385fa56dee2c3a0f192d2bf74152e37f89ada60ae021e603b5af671709e39c",
    },
    {
      raw: "const [live, setLive] = useState<{\n    scope: string;\n    taskId: string;\n    taskRevision: number;\n    view: TaskRuntime;\n  } | null>(null);",
      sha256:
        "13a7bf6b452c19c742de0a0ba5ca72daddbe07a3ddbe9c23415fbd557649efa4",
    },
    {
      raw: 'const [loadedResponses, setLoadedResponses] = useState<{\n    scope: string;\n    taskId: string;\n    taskRevision: number;\n    items: Workspace["taskResponses"];\n  } | null>(null);',
      sha256:
        "884800961310f9d1e6c6a7bd747d01f8237c684ab7d018a45337b3f9c58bfe0a",
    },
    {
      raw: "const api = useRef(client);",
      sha256:
        "5ca086632dc085fe6ca5619f3b8d0698a10b19622ffc01504cb635663e40b23e",
    },
    {
      raw: "api.current = client;",
      sha256:
        "7beaae66965cd2e1698d8ea66c0a38cc895998afbc8eca046256d15efcfe36a8",
    },
    {
      raw: "const [inspect, setInspect] = useState(false);",
      sha256:
        "169710e847a6535a00a6ae29b35efe2b74eabd83c52a11e6476b182600bbfaa2",
    },
    {
      raw: "const task = artifact.content;",
      sha256:
        "4634d62948f3d201cfc8b530f9652e9f2a2a92b2193a5eb6955533cca53e50bf",
    },
    {
      raw: 'const isTask = task.kind === "task";',
      sha256:
        "5dd5e0a54ab7f07fc8f418d5236329211cb8dd6babdecf653e487bd9ddbdef0e",
    },
    {
      raw: "const taskRunRequested = isTask ? task.runRequested : 0;",
      sha256:
        "2a1ecf84ccb0366ac8452f5d4a89206239c77a8751c52d45693fba7303f2bf9b",
    },
    {
      raw: 'const human =\n    isTask &&\n    state.actants.find((a) => a.id === task.assigneeId)?.kind === "human";',
      sha256:
        "ab2c6cc17a98597b6268c34b310e6dd5178fa09e9aff42f9cb2811229c07e4dc",
    },
    {
      raw: "const observationScope = JSON.stringify([\n    client.boot?.centerId,\n    client.boot?.principalId,\n    client.boot?.csrfToken,\n    artifact.id,\n    artifact.revision,\n    taskRunRequested,\n  ]);",
      sha256:
        "8cd5c22d668e3d99855c66f0c974d445a1ed320abb42ed0112c93a4e623ca39c",
    },
    {
      raw: 'useObservedRead({\n    scope: observationScope,\n    enabled:\n      isTask &&\n      !human &&\n      !!taskRunRequested &&\n      client.online &&\n      !runtimeObserved,\n    revision: client.workspaceChangeRevision,\n    read: async (signal) =>\n      taskRuntimeSchema.parse(\n        await api.current.taskRuntime(artifact.id, undefined, {\n          signal,\n          isCurrent: () => !signal.aborted,\n        }),\n      ),\n    publish: (view) => {\n      setLive({\n        scope: observationScope,\n        taskId: artifact.id,\n        taskRevision: artifact.revision,\n        view,\n      });\n      setReadError("");\n    },\n    failed: (cause) =>\n      setReadError(\n        cause instanceof Error ? cause.message : "无法读取执行状态。",\n      ),\n  });',
      sha256:
        "f9d546b6b38833477c7f8f2f62bfdde561784b8abb9fe04d3f5ec4cc27084062",
    },
    {
      raw: 'useObservedRead({\n    scope: observationScope,\n    enabled: isTask && !!human && !compact && client.online,\n    revision: client.workspaceChangeRevision,\n    read: () => api.current.taskResponses(artifact.id),\n    publish: (items) => {\n      setLoadedResponses({\n        scope: observationScope,\n        taskId: artifact.id,\n        taskRevision: artifact.revision,\n        items,\n      });\n      setReadError("");\n    },\n    failed: (cause) =>\n      setReadError(\n        cause instanceof Error ? cause.message : "无法读取事项回应。",\n      ),\n  });',
      sha256:
        "fbce9c2b1c31127e7fafb0aa2f796e92ad797bdf27f030baebcc3a383587333e",
    },
    {
      raw: "if (!isTask) return null;",
      sha256:
        "87a7e65a9ca519e5d7d25cfe044e0f8db910f714b8449e4f4930f9cf8a398af2",
    },
    {
      raw: "const view =\n    live?.scope === observationScope &&\n    live.taskId === artifact.id &&\n    live.taskRevision === artifact.revision\n      ? live.view\n      : client.boot?.taskRuns[artifact.id];",
      sha256:
        "b63dc756242361df22a4dfb9a5515d13d466461600566da61c6cb4a20ddfcd03",
    },
    {
      raw: "const run = view?.runs.find((r) => r.run === task.runRequested);",
      sha256:
        "72932e0cd23055864692e8a7305a84664efe0ab5633a2879fbd6acc3f4db47c5",
    },
    {
      raw: "const active = taskRunBusy(task, view);",
      sha256:
        "374f85e11cbd155ee8d84449f0e815f492ae26e95690a725898fefe29e00066b",
    },
    {
      raw: "const status = taskPresentation(task, !!human, view);",
      sha256:
        "a086875267846f1775890671d47eb5f19077d4f12643a5fb0bc4adea44092d29",
    },
    {
      raw: "const connected = client.online && client.boot?.capabilities.runtime;",
      sha256:
        "0c448efc900bef075515f5f32377613109b8bc7aea858180424f4ba502d78eba",
    },
    {
      raw: "const responses =\n    loadedResponses?.scope === observationScope &&\n    loadedResponses.taskId === artifact.id &&\n    loadedResponses.taskRevision === artifact.revision\n      ? loadedResponses.items\n      : [];",
      sha256:
        "585dcc6239570ee9484b98e14bf3998af79eff30becd4c53367b5d657446967d",
    },
    {
      raw: "const responsesLoading =\n    human &&\n    !compact &&\n    client.online &&\n    (loadedResponses?.scope !== observationScope ||\n      loadedResponses.taskId !== artifact.id ||\n      loadedResponses.taskRevision !== artifact.revision) &&\n    !readError;",
      sha256:
        "d06765926476fc96bf409c98c13a5c1dfbe99bd24629d3291a8dd61850c9f30e",
    },
    {
      raw: 'const canRespond =\n    human &&\n    client.boot?.actantId === task.assigneeId &&\n    !["completed", "cancelled"].includes(task.execution);',
      sha256:
        "c219e594507a4b915998ca101de05b844f65ab66f4833205dab1cc968bd18882",
    },
    {
      raw: "const thread = client.boot?.runtime.activity?.threads.find(\n    (t) => t.id === run?.record?.thread_id,\n  );",
      sha256:
        "85070257f730ba6586989cf8317f321aae4f55c788cea2ba38ae8c5d7987e8d8",
    },
    {
      raw: "const threadId = run?.record?.thread_id;",
      sha256:
        "b69f0ba8d1aa023676bd50a68ee38f02634769028921057f17c9ddb1ecd5a15b",
    },
    {
      raw: "const attention =\n    client.boot?.runtime.attention?.approvals.filter(\n      (a) => a.scope.threadId === run?.record?.thread_id,\n    ) ?? [];",
      sha256:
        "e205072cd98cfe3c2c4531e847a2486c7d1fd8a167bd34285d6764958730eff3",
    },
    {
      raw: 'const dependencies = status.state === "waiting" ? (view?.blockers ?? []) : [];',
      sha256:
        "8ab9768dae8cbc02eb24c59b9c840f29d34d3bbe01209156d88c4f60aeeac049",
    },
    {
      raw: 'async function perform(action: () => Promise<unknown>) {\n    if (pending.current) return;\n    pending.current = true;\n    setBusy(true);\n    setError("");\n    try {\n      await action();\n      await client.refresh();\n    } catch (e) {\n      setError(e instanceof Error ? e.message : "操作尚未确认，请核对状态。");\n    } finally {\n      pending.current = false;\n      setBusy(false);\n    }\n  }',
      sha256:
        "3744a553332989d59858838d8f5890f7116f74a351cf2777009a747287e715dd",
    },
    {
      raw: 'const start: ComposerOption = {\n    label:\n      run?.threadState === "failed"\n        ? "重试"\n        : run || ["completed", "cancelled"].includes(task.execution)\n          ? "重新执行"\n          : "开始",\n    icon: <Play />,\n    disabled: busy || !connected,\n    title: !connected\n      ? "连接智能体后可以开始执行"\n      : "按当前事项开始一次新的执行，已有结果保留",\n    onSelect: () =>\n      void perform(() =>\n        client.execute({\n          type: "request-task-run",\n          taskId: artifact.id,\n          expectedRevision: artifact.revision,\n        }),\n      ),\n  };',
      sha256:
        "7176cbcce953ce99462914842c6a1ab0d1763a4ce9a14dae535d2e678755981d",
    },
    {
      raw: 'const records: ComposerOption = {\n    label: "执行记录",\n    icon: <ListChecks />,\n    onSelect: () => setInspect(true),\n  };',
      sha256:
        "565c94c9c502775e264b678fa62b293a255912abd5e22309bba4adcdf7dd79c3",
    },
    {
      raw: 'const results: ComposerOption = {\n    label: "查看结果",\n    icon: <FileText />,\n    onSelect: () =>\n      onOpen?.(task.resultIds.length === 1 ? task.resultIds[0]! : artifact.id),\n  };',
      sha256:
        "620a1f908e344128312c8145e1c8806d8632384b07aa5a0616b6d0a696c6e148",
    },
    {
      raw: 'const detail: ComposerOption = {\n    label: "查看事项",\n    icon: <FileText />,\n    onSelect: () => onOpen?.(artifact.id),\n  };',
      sha256:
        "717ebadeabd917f1cf0d9e3da55e3f008b24ed9a6f849494fb941377dc91dc48",
    },
    {
      raw: "let primary: ComposerOption | undefined;",
      sha256:
        "c868f4e8fff0f89343ac81f845d5a75bd4447f4f79fcb6a9c579f45802f6b0ca",
    },
    {
      raw: 'if (\n    attention.length &&\n    threadId &&\n    run?.threadState === "open" &&\n    !run.stopRequested\n  )\n    primary = { ...records, label: `处理确认 (${attention.length})` };\n  else if (dependencies.length && onOpen)\n    primary = {\n      ...detail,\n      label: "查看前置事项",\n      onSelect: () => onOpen(dependencies[0]!.taskId),\n    };\n  else if (active)\n    primary = threadId\n      ? { ...records, label: "查看进度" }\n      : compact\n        ? detail\n        : undefined;\n  else if (run?.threadState === "failed") primary = start;\n  else if (task.resultIds.length && onOpen) primary = results;\n  else if (run?.threadState === "completed" && threadId) primary = records;\n  else if (status.state === "waiting")\n    primary = compact ? { ...detail, label: "查看原因" } : undefined;\n  else if (task.execution !== "cancelled" && task.execution !== "completed")\n    primary = start;',
      sha256:
        "71fd5a1c60b803852afe0dcc06dccf049410a3e0c1cc8f0b86f380c7e97cc670",
    },
    {
      raw: "const secondary: ComposerOption[] = [];",
      sha256:
        "85379a929f7ffcd902a1c1d66dbbd808e2ef4d6db9255c38643b6c0d4c659bac",
    },
    {
      raw: "if (!active && primary !== start) secondary.push(start);",
      sha256:
        "498b8faa4d3ca0fa4b5b6b46a539db9cc0e977c426939331f5f006ec4ee2b259",
    },
    {
      raw: "if (threadId && primary?.onSelect !== records.onSelect)\n    secondary.push(records);",
      sha256:
        "2e07e56e513ca80cc9ff6e02cf2c74f83cd4e6907ba192c6b88971eb548675e9",
    },
    {
      raw: "if (task.resultIds.length && onOpen && primary !== results)\n    secondary.push(results);",
      sha256:
        "4c4bbcbeeaafb8d1afc4d6530a427288fd427dc82264e24abed064525f60a4c0",
    },
    {
      raw: 'if (!active && !["cancelled", "completed"].includes(task.execution))\n    secondary.push({\n      label: "取消事项",\n      icon: <X />,\n      disabled: busy || !client.online,\n      onSelect: () =>\n        void perform(() =>\n          client.execute({\n            type: "cancel-task",\n            taskId: artifact.id,\n            expectedRevision: artifact.revision,\n          }),\n        ),\n    });',
      sha256:
        "6bba920b99b06603557b4a53f51947023bce68684d4213f68bf1bafcba812e21",
    },
  ],
  actions: [
    {
      raw: '() =>\n                  void perform(() =>\n                    client.taskRuntime(artifact.id, {\n                      run: run.run,\n                      revision: run.controlRevision,\n                      action: "stop",\n                    }),\n                  )',
      sha256:
        "ed1e1328af03ba17c53afe07017920df5515d26279aaa62590abaaec9593e904",
    },
    {
      raw: '() =>\n                  void perform(() =>\n                    client.taskRuntime(artifact.id, {\n                      run: task.runRequested,\n                      revision: 1,\n                      action: "stop",\n                    }),\n                  )',
      sha256:
        "425620cb5ce45a7a82d3409c11b66c19461476bb6ce2a8bc33bbace162737be0",
    },
    {
      raw: '() =>\n                      void perform(() =>\n                        client.taskRuntime(artifact.id, {\n                          run: run.run,\n                          revision: run.controlRevision,\n                          action: run.paused ? "resume" : "pause",\n                        }),\n                      )',
      sha256:
        "03e8a5c6a7d9dc746d531adec9bca3d5ea749a99a06751a2b2db3f1d6306f739",
    },
    {
      raw: "() => setInspect(false)",
      sha256:
        "9717f9d4608042c3fa11374331f1866c48118ba662e2dd724d51664e414b4847",
    },
    {
      raw: "(id) => {\n            setInspect(false);\n            onOpen?.(id);\n          }",
      sha256:
        "3a640a3a2f7470fe5abbe4261d4cbfff9d869c3788daafa97c8612b265f62ece",
    },
  ],
} as const;
