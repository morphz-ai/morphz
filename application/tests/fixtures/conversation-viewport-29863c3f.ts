// Independently captured from actual Git 29863c3f; finite original viewport
// registrations/actions/effects only. CI needs neither Git history nor /tmp.
export const fixedViewportMetadata = {
  git: "29863c3f227edd6267826e423f764b17779024f1",
  path: "application/apps/web/src/Conversation.tsx",
  sourceSHA256:
    "13dcd2ff49330cd1e19ef065934ec61633fcae943111cb1022f46522cf738d7f",
  bytes: 49917,
  spans: {
    scroller: {
      sha256:
        "1e60dcce899640bb355e1252aa300fb068617896be8a9ed84039eb883fd32e84",
      bytes: 43,
    },
    prependPosition: {
      sha256:
        "cbbbad1d32e881642b2e40a44288b1ffad929dc06983f9c80b016dab90254c9e",
      bytes: 105,
    },
    loadingEarlier: {
      sha256:
        "afec8568bd4c728dae7029e802f5d04c9b6247498f5a3329387b719f394c72d1",
      bytes: 60,
    },
    earlierError: {
      sha256:
        "2bafac72ce05d6a495854e4b344c1cfe92d3935b2defe1563217a173d4b4926c",
      bytes: 53,
    },
    revealedQuote: {
      sha256:
        "98989eecd52532c37e193accdd207cafc632ef1d51165f2b5712061a10e4affe",
      bytes: 50,
    },
    loadingQuote: {
      sha256:
        "4650c5a1c89f12cf27b79dea5f1f88530fa404687ed1ce4e57b5f91f26327ed9",
      bytes: 49,
    },
    latestButton: {
      sha256:
        "2cbafe97622105c0422b62947d21babd989e39b8aa2c0f04eab727f1ffd27320",
      bytes: 53,
    },
    positionKey: {
      sha256:
        "e6c3473df5d4feff20d00e061688496969a106cb06195c3f4ada8358ab848dca",
      bytes: 134,
    },
    saved: {
      sha256:
        "c05fb9e379c23c17ee127f23a91dcc2d215e58aaeb8a2be92d34c29e6446fb21",
      bytes: 41,
    },
    previousPositionKey: {
      sha256:
        "620497eca012f7263fa6132498778285649659a4fec0aba5d83be3191ccf205d",
      bytes: 48,
    },
    following: {
      sha256:
        "685baed592eaadcc0c1df8a99c89c485ddc5efc47ed2aa5c92fd871068a0deba",
      bytes: 51,
    },
    initialized: {
      sha256:
        "88af708d2dccb658b8f1e7b8ebe2e58fb59804fce0a81220dc0032148f12007c",
      bytes: 34,
    },
    revealed: {
      sha256:
        "360b62d70acad7d985a38ea0cf53014a9a1b32b7fc0e20437309395f61f94120",
      bytes: 58,
    },
    awayFromLatest: {
      sha256:
        "ca4c6ac0cab50355f31bd1dc2bd363e88c751cfa959c01b91f8cb1afd8922f1d",
      bytes: 73,
    },
    loadEarlier: {
      sha256:
        "ac52e589cb58a3181659f212e5761e540d7eebedfb7b38fd22f286fbf7d28397",
      bytes: 606,
    },
    acknowledgeVisibleReplies: {
      sha256:
        "e8fdf4a22e8e14104fa3f5ac615a4fc7db6505ca253cfd0d6988e4765fe86351",
      bytes: 231,
    },
    updateLatestIndicator: {
      sha256:
        "3dca85ff98822d4506b0165493e945e79beb79ad6431f12c25c2c12394480847",
      bytes: 593,
    },
    effect0: {
      sha256:
        "c415a3edf9a70b893d68f5588378bac0d3a48489253a24ecd36ee58b3a2fd571",
      bytes: 872,
    },
    effect1: {
      sha256:
        "bcd280432dd0dc90491203a8a4a3969218a185f479e42c963c9eb36e5bb9f948",
      bytes: 503,
    },
    effect2: {
      sha256:
        "a40eb2d41b5bf6555f1ed52b0e23412a48893beaf29a88d43c822fb3bee0b240",
      bytes: 450,
    },
    effect3: {
      sha256:
        "344d35b393ec5c03946def2e88918a8eda52f3d314a993a39aca7dc6ea994400",
      bytes: 270,
    },
    effect4: {
      sha256:
        "3bda6647b1f597014f12811e66e84fbf85545b681e940469f8e4bda802e70fbe",
      bytes: 2318,
    },
    onScroll: {
      sha256:
        "2ce71f2d70dd8cda5a0a7e5aaa8a33745212508f73ede236dab2b96e3045e5d5",
      bytes: 379,
    },
    returnLatest: {
      sha256:
        "01ad4b5ccb9da2079261444b6139f24f3f5d220ec01678a81b0213465e48433b",
      bytes: 212,
    },
    ExchangePosition: {
      sha256:
        "4d501be9a776d74e5b0c85ac26e0fd793b15bbb8403f3a49cd04689fe4b91bf5",
      bytes: 99,
    },
  },
} as const;
export const fixedViewportSpans = {
  scroller: "const scroller = useRef<HTMLElement>(null);",
  prependPosition:
    "const prependPosition = useRef<{\n    key: string;\n    height: number;\n    top: number;\n  } | null>(null);",
  loadingEarlier:
    "const [loadingEarlier, setLoadingEarlier] = useState(false);",
  earlierError: 'const [earlierError, setEarlierError] = useState("");',
  revealedQuote: "const revealedQuote = useRef<string | null>(null);",
  loadingQuote: "const loadingQuote = useRef<string | null>(null);",
  latestButton: "const latestButton = useRef<HTMLButtonElement>(null);",
  positionKey:
    'const positionKey =\n    conversationId +\n    (focused\n      ? ":focus:" + (focusedArtifactId ?? focusedApplicationId)\n      : ":all");',
  saved: "const saved = positions.get(positionKey);",
  previousPositionKey: "const previousPositionKey = useRef(positionKey);",
  following: "const following = useRef(saved?.following ?? true);",
  initialized: "const initialized = useRef(false);",
  revealed: "const revealed = useRef(saved?.revealed ?? revealInputId);",
  awayFromLatest:
    "const [awayFromLatest, setAwayFromLatest] = useState(!following.current);",
  loadEarlier:
    'async function loadEarlier() {\n    if (!onLoadEarlierHistory || loadingEarlier) return;\n    const el = scroller.current;\n    if (el)\n      prependPosition.current = {\n        key: positionKey,\n        height: el.scrollHeight,\n        top: el.scrollTop,\n      };\n    setLoadingEarlier(true);\n    setEarlierError("");\n    try {\n      await onLoadEarlierHistory();\n    } catch (error) {\n      prependPosition.current = null;\n      setEarlierError(\n        error instanceof Error ? error.message : "旧消息暂时无法读取，请重试。",\n      );\n    } finally {\n      setLoadingEarlier(false);\n    }\n  }',
  acknowledgeVisibleReplies:
    'function acknowledgeVisibleReplies() {\n    if (\n      following.current &&\n      document.visibilityState === "visible" &&\n      document.hasFocus() &&\n      !document.querySelector("dialog[open]")\n    )\n      onRead(receipts);\n  }',
  updateLatestIndicator:
    "function updateLatestIndicator() {\n    if (following.current) {\n      // Move focus before removing its button. A detached focused control\n      // otherwise looks like leaving the unpinned exchange. Do not steal\n      // focus when ordinary scrolling or new content reaches the bottom.\n      if (latestButton.current === document.activeElement) {\n        onFocusComposer?.();\n        if (latestButton.current === document.activeElement)\n          scroller.current?.focus({ preventScroll: true });\n      }\n      acknowledgeVisibleReplies();\n    }\n    setAwayFromLatest(!following.current);\n  }",
  effect0:
    "useLayoutEffect(() => {\n    const el = scroller.current;\n    if (!el) return;\n    if (previousPositionKey.current !== positionKey) {\n      initialized.current = false;\n      following.current = saved?.following ?? true;\n      revealed.current = saved?.revealed ?? revealInputId;\n      previousPositionKey.current = positionKey;\n    }\n    if (!initialized.current && saved) el.scrollTop = saved.top;\n    if (revealInputId && revealed.current !== revealInputId)\n      following.current = true;\n    if (following.current) {\n      el.scrollTop = el.scrollHeight;\n    }\n    revealed.current = revealInputId;\n    initialized.current = true;\n    updateLatestIndicator();\n    positions.set(positionKey, {\n      top: el.scrollTop,\n      following: following.current,\n      revealed: revealed.current,\n    });\n  }, [contentVersion, readVersion, revealInputId, positionKey, onRead]);",
  effect1:
    "useLayoutEffect(() => {\n    const el = scroller.current;\n    const old = prependPosition.current;\n    if (!el || !old || old.key !== positionKey || loadingEarlier) return;\n    following.current = false;\n    el.scrollTop = old.top + el.scrollHeight - old.height;\n    positions.set(positionKey, {\n      top: el.scrollTop,\n      following: false,\n      revealed: revealed.current,\n    });\n    setAwayFromLatest(true);\n    prependPosition.current = null;\n  }, [contentVersion, loadingEarlier, positionKey]);",
  effect2:
    'useEffect(() => {\n    const read = () => acknowledgeVisibleReplies();\n    document.addEventListener("visibilitychange", read);\n    window.addEventListener("focus", read);\n    document.addEventListener("focusin", read);\n    return () => {\n      document.removeEventListener("visibilitychange", read);\n      window.removeEventListener("focus", read);\n      document.removeEventListener("focusin", read);\n    };\n  }, [readVersion, positionKey, onRead]);',
  effect3:
    "useLayoutEffect(() => {\n    const el = scroller.current;\n    if (!el) return;\n    const observer = new ResizeObserver(() => {\n      if (following.current) el.scrollTop = el.scrollHeight;\n    });\n    observer.observe(el);\n    return () => observer.disconnect();\n  }, []);",
  effect4:
    'useLayoutEffect(() => {\n    if (!quoteReveal || revealedQuote.current === quoteReveal.token) return;\n    const quote = quoteReveal.quote.source;\n    if (quote.kind !== "message") return;\n    const el = scroller.current;\n    const message = el?.querySelector<HTMLElement>(\n      `[data-message-id="${CSS.escape(quote.messageId)}"]`,\n    );\n    if (!message) {\n      if (\n        focused &&\n        (allInputs.some((item) => item.id === quote.messageId) ||\n          messages.some((item) => item.id === quote.messageId))\n      ) {\n        setAllHistory(true);\n      } else if (\n        hasEarlierHistory &&\n        loadingQuote.current !== quoteReveal.token\n      ) {\n        loadingQuote.current = quoteReveal.token;\n        void client.loadHistoryUntil(quote.messageId).then(\n          (found) => {\n            if (!found) {\n              revealedQuote.current = quoteReveal.token;\n              onQuoteUnavailable?.();\n            }\n          },\n          (error: unknown) => {\n            revealedQuote.current = quoteReveal.token;\n            onQuoteUnavailable?.(\n              error instanceof Error ? error.message : undefined,\n            );\n          },\n        );\n      } else {\n        if (loadingQuote.current !== quoteReveal.token) {\n          revealedQuote.current = quoteReveal.token;\n          onQuoteUnavailable?.();\n        }\n      }\n      return;\n    }\n    revealedQuote.current = quoteReveal.token;\n    // A source jump is explicit navigation, not a request to follow new output.\n    following.current = false;\n    el!.scrollTop +=\n      message.getBoundingClientRect().top -\n      el!.getBoundingClientRect().top -\n      24;\n    setAwayFromLatest(true);\n    positions.set(positionKey, {\n      top: el!.scrollTop,\n      following: false,\n      revealed: revealed.current,\n    });\n    const range = locateTextQuote(quoteReveal.quote);\n    if (range) {\n      window.getSelection()?.removeAllRanges();\n      window.getSelection()?.addRange(range);\n    }\n    message.setAttribute("data-quote-revealed", "true");\n    const timeout = window.setTimeout(\n      () => message.removeAttribute("data-quote-revealed"),\n      2200,\n    );\n    return () => {\n      clearTimeout(timeout);\n      message.removeAttribute("data-quote-revealed");\n    };\n  }, [quoteReveal, focused, contentVersion, hasEarlierHistory]);',
  onScroll:
    "() => {\n        const el = scroller.current;\n        if (!el) return;\n        following.current = shouldFollow(\n          el.scrollHeight - el.clientHeight - el.scrollTop,\n        );\n        updateLatestIndicator();\n        positions.set(positionKey, {\n          top: el.scrollTop,\n          following: following.current,\n          revealed: revealed.current,\n        });\n      }",
  returnLatest:
    "() => {\n              following.current = true;\n              if (scroller.current)\n                scroller.current.scrollTop = scroller.current.scrollHeight;\n              updateLatestIndicator();\n            }",
  ExchangePosition:
    "export type ExchangePosition = {\n  top: number;\n  following: boolean;\n  revealed: string | null;\n};",
} as const;
