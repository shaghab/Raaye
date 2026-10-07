# Optional extra CA certificates

Place `*.crt` files here when your network intercepts TLS (corporate proxy, sandbox).
They are copied into the images at build time (`EXTRA_CA_DIR` build argument) and
ignored by git. Nothing is required here on an ordinary network.
