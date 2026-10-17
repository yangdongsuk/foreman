#!/usr/bin/env bash
# Installs the TTS engine locally (scripts/video/.venv). Nothing global is touched. Safe to re-run.
# edge-tts < 7.3 gets "403 Invalid response status" from Microsoft since Oct 2026, so require >= 7.3.1.
set -euo pipefail
cd "$(dirname "$0")"
if command -v uv >/dev/null 2>&1; then
  [ -x .venv/bin/python ] || { uv venv .venv --python 3.11 --quiet 2>/dev/null || uv venv .venv --quiet; }
  uv pip install --quiet --python .venv/bin/python --upgrade "edge-tts>=7.3.1"
else
  [ -x .venv/bin/python ] || python3 -m venv .venv
  .venv/bin/python -m pip install --quiet --upgrade "edge-tts>=7.3.1"
fi
.venv/bin/edge-tts --version
