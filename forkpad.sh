#!/bin/sh
# ForkPad launcher for Linux: starts the helper and opens the app.
cd "$(dirname "$0")" || exit 1
exec node server/start.js
