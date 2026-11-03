#!/bin/sh
# ForkPad launcher for macOS: double-click in Finder. Starts the helper and opens the app.
cd "$(dirname "$0")" || exit 1
exec node server/start.js
