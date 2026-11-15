#!/usr/bin/env bash
# Install what the backup tooling needs on a GitHub-hosted Ubuntu 24.04 runner:
# the PostgreSQL 17 client tools (pg_dump must be at least the server's major
# version, and the runner image ships 16) and age. Three tries, because an apt
# mirror can refuse a request for a moment.
#
# On a Mac: brew install libpq age, and put libpq's bin on PATH.
set -euo pipefail

for attempt in 1 2 3; do
  if sudo apt-get install -y -q postgresql-common >/dev/null \
    && sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null \
    && sudo apt-get install -y -q postgresql-client-17 age >/dev/null; then
    break
  fi
  [ "$attempt" = 3 ] && { echo "install failed"; exit 1; }
  echo "install failed (attempt $attempt of 3)"
  sleep 20
done

# The runner's PATH puts the distribution's pg_dump first; point at 17.
echo "/usr/lib/postgresql/17/bin" >> "${GITHUB_PATH:-/dev/null}"
/usr/lib/postgresql/17/bin/pg_dump --version
age --version
