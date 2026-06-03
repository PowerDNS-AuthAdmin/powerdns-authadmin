## lib/crypto

Cryptographic primitives owned by the app, including envelope encryption and
key derivation for persisted secrets.

Callers should pass already-validated configuration from `lib/env`; this
directory should not grow ad hoc secret parsing or persistence logic.
