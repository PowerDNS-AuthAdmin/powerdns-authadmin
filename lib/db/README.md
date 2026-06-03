## lib/db

Database schema selection, Drizzle setup, migrations support, and repository
functions for Postgres and SQLite.

This layer persists and retrieves data. It must not import RBAC or UI code;
authorization happens above repositories, and React components receive data
through pages, route handlers, or domain orchestration.
