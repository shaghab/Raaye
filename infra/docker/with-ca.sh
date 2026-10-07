#!/bin/sh
# Runs a command with NODE_EXTRA_CA_CERTS pointing at the optional extra CA bundle when one was provided.
BUNDLE=/usr/local/share/ca-certificates/extra-bundle.crt
if [ -s "$BUNDLE" ]; then
  NODE_EXTRA_CA_CERTS="$BUNDLE" exec "$@"
fi
exec "$@"
