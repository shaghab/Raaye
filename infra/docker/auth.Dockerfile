# Firebase Authentication emulator (no Java required for the Auth emulator alone).
FROM node:22.22.0-bookworm-slim
ARG EXTRA_CA_DIR=infra/certs
# Optional extra CA certificates for intercepting proxies (see infra/certs/README.md).
COPY ${EXTRA_CA_DIR}/ /usr/local/share/ca-certificates/extra/
COPY infra/docker/with-ca.sh /usr/local/bin/with-ca
RUN chmod +x /usr/local/bin/with-ca \
  && (cat /usr/local/share/ca-certificates/extra/*.crt > /usr/local/share/ca-certificates/extra-bundle.crt 2>/dev/null || true) \
  && with-ca npm install -g firebase-tools@15.32.1 && npm cache clean --force
WORKDIR /srv/firebase
COPY infra/firebase/firebase.json infra/firebase/.firebaserc ./
EXPOSE 9099
HEALTHCHECK --interval=5s --timeout=3s --retries=30 CMD node -e "fetch('http://127.0.0.1:9099/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["with-ca", "firebase", "emulators:start", "--only", "auth", "--project", "demo-raaye"]
