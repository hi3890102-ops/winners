-- Applied directly to production and staging on 2026-09-17, found and fixed during
-- live testing of the franchise portal (immediately after building it).
--
-- Root cause: every public.X(...) wrapper this session that used the plain
-- `language sql ... as $$ select private.X(...); $$` pattern (no explicit
-- `security definer`) defaults to SECURITY INVOKER. When an invoker-mode
-- function calls another function, the CALLING ROLE (authenticated) must
-- itself hold EXECUTE on the callee -- SECURITY DEFINER on the callee only
-- elevates privileges *inside that function's body*, it does not grant
-- permission to invoke it in the first place. Every private.X these
-- wrappers delegate to had been `revoke all ... from public, anon` with no
-- explicit re-grant to authenticated, so every real client call failed with
-- 42501 "permission denied for function X" (PostgREST maps this to HTTP 403).
--
-- This was invisible in `security/*.test.mjs` (those test client-side JS
-- logic against a mocked db, never a live RPC permission check) and in the
-- earlier SQL-level "select private.X(...)" smoke tests done via
-- execute_sql (which runs as postgres, bypassing this check entirely).
-- Only caught by testing the real REST call end-to-end through the browser.
--
-- Affected: set_crew_manager_flag (from earlier this session -- the
-- manager-role-sync feature was very likely non-functional in production
-- since it shipped), franchise_submit_claim, franchise_reply_claim,
-- hq_reply_claim, request_franchise_join, review_franchise_join_request,
-- search_unaffiliated_stores.
--
-- record_subscription_snapshot was NOT affected -- its public wrapper is
-- itself `security definer`, so the inner call to private.record_subscription_snapshot
-- runs as the wrapper's owner (postgres), sidestepping the issue entirely.
--
-- Fix: grant EXECUTE on the private implementation to authenticated too,
-- matching the pattern already used (whether by original intent or luck)
-- by every pre-existing private/public pair in this codebase, e.g.
-- private.get_store_crew_directory.
grant execute on function private.franchise_submit_claim(text,text) to authenticated;
grant execute on function private.franchise_reply_claim(uuid,text) to authenticated;
grant execute on function private.hq_reply_claim(uuid,text,boolean) to authenticated;
grant execute on function private.request_franchise_join(uuid) to authenticated;
grant execute on function private.review_franchise_join_request(uuid,boolean) to authenticated;
grant execute on function private.search_unaffiliated_stores(text) to authenticated;
grant execute on function private.set_crew_manager_flag(uuid,boolean) to authenticated;

-- Second bug found in the same test pass: claim_messages.sender_type only
-- allowed ('store','hq'), so franchise_submit_claim/franchise_reply_claim's
-- insert of sender_type='franchise' always violated the check constraint
-- (visible only after the grant fix above stopped masking it behind a 403).
alter table public.claim_messages drop constraint claim_messages_sender_type_check;
alter table public.claim_messages add constraint claim_messages_sender_type_check check (sender_type = any (array['store','hq','franchise']));
