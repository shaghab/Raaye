#!/bin/sh
# api | worker | bootstrap (migrate + seed) | any node command
set -e
case "$1" in
  api)
    exec node dist/apps/api/main.js
    ;;
  worker)
    exec node dist/apps/worker/main.js worker
    ;;
  bootstrap)
    echo "Applying migrations"
    node node_modules/prisma/build/index.js migrate deploy
    echo "Seeding synthetic demo data (idempotent)"
    node dist/apps/worker/main.js seed
    ;;
  *)
    exec "$@"
    ;;
esac
