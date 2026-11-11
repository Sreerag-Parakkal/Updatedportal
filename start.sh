#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; exit 1; }
echo "Starting SCM SERVICE PORTAL on http://localhost:3000"
node server.js
