#!/bin/bash

echo "Starting BB Browser Trace Studio..."
echo ""

cd "$(dirname "$0")"

echo "[1/2] Starting daemon..."
node ../cli/dist/index.js daemon stop 2>/dev/null
node ../cli/dist/index.js daemon start
if [ $? -ne 0 ]; then
    echo "ERROR: Daemon failed to start"
    exit 1
fi
echo "Daemon started successfully"
echo ""

echo "[2/2] Starting frontend at http://localhost:3003/"
pnpm exec vite --port 3003

echo ""
echo "Stopping daemon..."
node ../cli/dist/index.js daemon stop
