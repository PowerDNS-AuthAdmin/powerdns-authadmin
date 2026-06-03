## lib/provisioning

First-boot YAML provisioning: schema validation, application logic, and demo
zone generation.

Provisioning is an install-time source of desired state. Runtime UI actions and
API routes should not depend on this directory for normal CRUD behavior.
