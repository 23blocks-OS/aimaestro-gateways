#!/usr/bin/env bash
# Start Google Chat Gateway
# To use a custom env file, create a wrapper script that sources it before this one.
# Example: source .env.mydeployment && exec npx tsx src/server.ts
set -euo pipefail

cd "$(dirname "$0")"

# Load environment from .env (if present)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

echo "Starting Google Chat Gateway..."
exec npx tsx src/server.ts
