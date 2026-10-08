#!/bin/sh
# Deploys one branch of the demo shop as its own container, tied to one Switchly environment.
#
#   ./deploy.sh <branch> <environment> <port>
#   ./deploy.sh feature/new-checkout staging 4002
#
# With no arguments, deploys the standard three instances.
set -eu
cd "$(dirname "$0")"

if [ $# -eq 0 ]; then
  ./deploy.sh main production 4001
  ./deploy.sh feature/new-checkout staging 4002
  ./deploy.sh feature/recommendations development 4003
  exit 0
fi

branch=$1 environment=$2 port=$3
. ./instances.env
eval "key=\${SDK_KEY_$environment:?no SDK key for environment $environment in instances.env}"

# Build from the branch as committed, not from the working copy.
image="demo-shop:$(echo "$branch" | tr '/' '-')"
git -C shop archive "$branch" | docker build -q -t "$image" - >/dev/null

# Replace the instance for this environment, if one is running.
docker rm -f "shop-$environment" >/dev/null 2>&1 || true
docker run -d --name "shop-$environment" -p "$port:8080" \
  -e SWITCHLY_SDK_KEY="$key" \
  -e SWITCHLY_URL="${SWITCHLY_URL:-http://localhost:3000}" \
  -e ENVIRONMENT="$environment" \
  -e BRANCH="$branch" \
  "$image" >/dev/null

echo "$branch -> $environment: http://localhost:$port"
