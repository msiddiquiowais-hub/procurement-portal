-- pgcrypto provides digest() for the real sha256 hashes used by
-- proc.quotations.sealed_hash and proc.approved_packs.pack_hash.
-- Migration 001 installs the extensions; this is a safety net for databases
-- seeded before pgcrypto was present.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
