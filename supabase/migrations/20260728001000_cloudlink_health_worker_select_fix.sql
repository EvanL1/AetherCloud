-- Forward fix for a defect in 20260728000800_cloudlink_health_worker_role.sql
-- that has already been corrected in that file's source, but Supabase
-- records applied migrations by version prefix: editing 000800 in place is
-- a no-op for any database that already ran that version, and nothing
-- re-applies old migrations. This statement is required so already-deployed
-- databases actually receive the fix; freshly provisioned databases get the
-- same grant twice (harmlessly, since GRANT is idempotent) once from the
-- corrected 000800 and once from here. Do not delete this file: it is not a
-- redundant duplicate of 000800, it is the only thing that reaches a
-- database that ran the old 000800 before the fix landed.
--
-- aethercloud_cloudlink_health_worker had UPDATE but not SELECT on
-- cloudlink_session_heads. complete() calls clearClosedHeadSql, an UPDATE
-- whose WHERE clause reads existing tenant_id, project_id, gateway_id, and
-- current_session_id columns on that table, and PostgreSQL requires SELECT
-- on any existing-row column an UPDATE's WHERE clause reads, not only on
-- columns it writes. Verified against a disposable PostgreSQL 17 instance:
-- 42501 permission denied before this grant, a clean UPDATE after it.
GRANT SELECT ON aethercloud.cloudlink_session_heads
  TO aethercloud_cloudlink_health_worker;
