#!/usr/bin/env python3
"""Count one canonical Harness request with the frozen DEMO-001 tokenizer."""

from __future__ import annotations

import json
import sys

import tiktoken


def main() -> None:
    value = json.load(sys.stdin)
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    encoding = tiktoken.get_encoding("o200k_base")
    print(len(encoding.encode(text)))


if __name__ == "__main__":
    main()
