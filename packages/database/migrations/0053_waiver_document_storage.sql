-- 0053 signed waiver PDFs in private object storage (W3-OPS-4)
--
-- Under the owner's go of 2026-11-15 on W3-OPS-4, security hardening before
-- real data (code only, synthetic data, no live resources). Tenancy follows
-- packages/database/README.md.
--
-- Until now the signed PDF lived in the evidence row (document bytea). Before
-- real evidence it moves to a private R2 bucket with object lock: the API
-- writes the PDF under a content-addressed key before the signing
-- transaction commits, and the row keeps the key, the size, and the SHA-256.
-- The database can no longer hash the bytes itself, so every read hashes them
-- again (loadEvidenceDocument) and never serves bytes that do not match.
--
-- A row holds its PDF in exactly one place: the old bytea column (rows
-- written before this migration, and the demo's preview and local
-- environments without a bucket), or the bucket key. The key is fixed by
-- the tenant and the hash, so a writer cannot point a row at another
-- tenant's object or at bytes other than the ones it recorded. Evidence stays
-- append-only for every role (0010's triggers), so neither place changes
-- after the insert.

ALTER TABLE public.waiver_evidence
  ALTER COLUMN document DROP NOT NULL,
  ADD COLUMN document_key text,
  ADD COLUMN document_size integer;

-- coalesce, because a CHECK that evaluates to NULL passes: a row with no
-- key and no bytes must fail, not slip through on a NULL comparison.
ALTER TABLE public.waiver_evidence
  ADD CONSTRAINT waiver_evidence_document_place CHECK (coalesce(
    (document IS NOT NULL AND document_key IS NULL AND document_size IS NULL)
    OR (
      document IS NULL
      AND document_key IS NOT NULL
      AND document_size IS NOT NULL
      AND document_sha256 ~ '^[0-9a-f]{64}$'
      AND document_key = 'waivers/' || tenant_id::text || '/' || document_sha256 || '.pdf'
      AND document_size BETWEEN 64 AND 2000000
    ), false)
  );
