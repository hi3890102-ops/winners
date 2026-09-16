-- New, empty MANEE STAGING project only. Schema definitions, no production rows.

begin;

set local lock_timeout = '5s';

set local statement_timeout = '60s';

set local check_function_bodies = off;

do $guard$ begin if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) then raise exception 'staging bootstrap requires an empty public schema'; end if; end $guard$;

create schema if not exists private;

create table "public"."announcement_reads" (
  "announcement_id" uuid not null,
  "crew_id" uuid not null,
  "read_at" timestamp with time zone default now()
);

alter table "public"."announcement_reads" enable row level security;

create table "public"."announcements" (
  "id" uuid default gen_random_uuid() not null,
  "store_id" uuid,
  "title" text not null,
  "body" text,
  "author_name" text,
  "created_at" timestamp with time zone default now()
);

alter table "public"."announcements" enable row level security;

create table "public"."app_settings" (
  "key" text not null,
  "value" text
);

alter table "public"."app_settings" enable row level security;

create table "public"."attendance" (
  "id" uuid default gen_random_uuid() not null,
  "store_id" uuid,
  "crew_id" uuid,
  "date" date not null,
  "check_in" time without time zone not null,
  "check_out" time without time zone,
  "confirmed" boolean default false not null,
  "created_at" timestamp with time zone default now(),
  "staff_confirmed" boolean default false,
  "time_edited" boolean default false,
  "staff_ack_edit" boolean default false
);

alter table "public"."attendance" enable row level security;

create table "public"."attendance_edit_requests" (
  "id" uuid default gen_random_uuid() not null,
  "attendance_id" uuid not null,
  "store_id" uuid not null,
  "crew_id" uuid not null,
  "requested_check_in" time without time zone,
  "requested_check_out" time without time zone,
  "reason" text default ''::text not null,
  "status" text default 'pending'::text not null,
  "requested_at" timestamp with time zone default now() not null,
  "reviewed_at" timestamp with time zone,
  "reviewed_by" uuid,
  "review_note" text default ''::text not null
);

alter table "public"."attendance_edit_requests" enable row level security;

create table "public"."auth_rate_limits" (
  "action" text not null,
  "key_hash" text not null,
  "window_start" timestamp with time zone not null,
  "attempt_count" integer default 0 not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table "public"."auth_rate_limits" enable row level security;

create table "public"."checklist_checks" (
  "store_id" uuid not null,
  "date" date not null,
  "item_id" text not null,
  "checked" boolean default true not null
);

alter table "public"."checklist_checks" enable row level security;

create table "public"."checklist_log" (
  "store_id" uuid not null,
  "date" date not null,
  "done" integer default 0 not null,
  "total" integer default 0 not null,
  "closed_at" timestamp with time zone
);

alter table "public"."checklist_log" enable row level security;

create table "public"."checklist_templates" (
  "store_id" uuid not null,
  "tab" text not null,
  "data" jsonb default '[]'::jsonb not null
);

alter table "public"."checklist_templates" enable row level security;

create table "public"."crew" (
  "id" uuid default gen_random_uuid() not null,
  "store_id" uuid,
  "name" text not null,
  "wage" integer default 0 not null,
  "wage_type" text default 'hourly'::text not null,
  "phone" text,
  "position" text default '홀'::text not null,
  "is_manager" boolean default false not null,
  "join_code" text,
  "tax33" boolean default false not null,
  "weekly_allowance" boolean default false not null,
  "insurance4" boolean default false not null,
  "insurance2" boolean default false not null,
  "probation" boolean default false not null,
  "hire_date" date,
  "resign_date" date,
  "created_at" timestamp with time zone default now(),
  "work_condition" text default ''::text,
  "resident_number" text default ''::text,
  "bank_account" text default ''::text,
  "health_cert_expiry" date,
  "contract_signed" boolean default false,
  "notes" text default ''::text,
  "sales_access" boolean default false
);

alter table "public"."crew" enable row level security;

create table "public"."expense_entries" (
  "id" uuid default gen_random_uuid() not null,
  "store_id" uuid,
  "date" date not null,
  "description" text not null,
  "amount" integer default 0 not null,
  "created_at" timestamp with time zone default now()
);

alter table "public"."expense_entries" enable row level security;

create table "public"."fixed_expenses" (
  "id" uuid default gen_random_uuid() not null,
  "store_id" uuid,
  "name" text not null,
  "amount" integer default 0 not null,
  "created_at" timestamp with time zone default now(),
  "month_key" text not null
);

alter table "public"."fixed_expenses" enable row level security;

create table "public"."fixed_schedules" (
  "id" uuid default gen_random_uuid() not null,
  "store_id" uuid,
  "crew_id" uuid,
  "days" integer[] not null,
  "start_time" time without time zone not null,
  "end_time" time without time zone not null,
  "created_at" timestamp with time zone default now()
);

alter table "public"."fixed_schedules" enable row level security;

create table "public"."franchise_memberships" (
  "id" uuid default gen_random_uuid() not null,
  "user_id" uuid not null,
  "franchise_id" uuid not null,
  "role" text default 'admin'::text not null,
  "status" text default 'active'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "revoked_at" timestamp with time zone
);

alter table "public"."franchise_memberships" enable row level security;

create table "public"."franchises" (
  "id" uuid default gen_random_uuid() not null,
  "name" text not null,
  "username" text not null,
  "password_hash" text not null,
  "created_at" timestamp with time zone default now() not null
);

alter table "public"."franchises" enable row level security;

create table "public"."owner_requests" (
  "id" uuid default gen_random_uuid() not null,
  "name" text not null,
  "store_name" text not null,
  "username" text not null,
  "password_hash" text not null,
  "status" text default 'pending'::text not null,
  "requested_at" timestamp with time zone default now(),
  "reviewed_at" timestamp with time zone,
  "reset_requested" boolean default false not null,
  "reset_requested_at" timestamp with time zone,
  "auth_user_id" uuid,
  "auth_migrated_at" timestamp with time zone
);

alter table "public"."owner_requests" enable row level security;

create table "public"."platform_admins" (
  "user_id" uuid not null,
  "role" text default 'admin'::text not null,
  "status" text default 'active'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "revoked_at" timestamp with time zone
);

alter table "public"."platform_admins" enable row level security;

create table "public"."profiles" (
  "user_id" uuid not null,
  "username" text not null,
  "display_name" text,
  "phone_e164" text,
  "phone_verified_at" timestamp with time zone,
  "status" text default 'active'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

alter table "public"."profiles" enable row level security;

create table "public"."push_subscriptions" (
  "id" bigint generated always as identity (start with 1 increment by 1 minvalue 1 maxvalue 9223372036854775807 cache 1 no cycle) not null,
  "store_id" uuid not null,
  "crew_id" uuid,
  "role" text,
  "endpoint" text not null,
  "p256dh" text not null,
  "auth" text not null,
  "created_at" timestamp with time zone default now(),
  "is_manager" boolean default false
);

alter table "public"."push_subscriptions" enable row level security;

create table "public"."reservations" (
  "id" bigint generated always as identity (start with 1 increment by 1 minvalue 1 maxvalue 9223372036854775807 cache 1 no cycle) not null,
  "store_id" uuid not null,
  "date" date not null,
  "time" text,
  "customer_name" text,
  "phone" text,
  "party_size" integer,
  "memo" text,
  "created_by" text,
  "created_at" timestamp with time zone default now(),
  "notified" boolean default false
);

alter table "public"."reservations" enable row level security;

create table "public"."sales_report_photos" (
  "id" uuid default gen_random_uuid() not null,
  "sales_report_id" uuid,
  "kind" text not null,
  "storage_path" text not null,
  "created_at" timestamp with time zone default now()
);

alter table "public"."sales_report_photos" enable row level security;

create table "public"."sales_reports" (
  "id" uuid default gen_random_uuid() not null,
  "store_id" uuid,
  "crew_id" uuid,
  "manager_name" text,
  "date" date not null,
  "total_sales" integer default 0,
  "discount" integer default 0,
  "refund" integer default 0,
  "refund_reason" text,
  "net_sales" integer default 0,
  "cash_sales" integer default 0,
  "actual_cash" integer default 0,
  "card_sales" integer default 0,
  "expense" integer default 0,
  "till" integer default 0,
  "note" text,
  "submitted_at" timestamp with time zone default now(),
  "settlement_photos" jsonb default '[]'::jsonb,
  "receipt_photos" jsonb default '[]'::jsonb,
  "note_photos" jsonb default '[]'::jsonb,
  "delivery_baemin" integer default 0,
  "delivery_coupang" integer default 0,
  "delivery_yogiyo" integer default 0,
  "card_expense" integer default 0,
  "card_expense_note" text default ''::text,
  "cash_expense_note" text default ''::text,
  "bank_transfer" integer default 0,
  "bank_transfer_note" text default ''::text,
  "cash_expense_items" jsonb default '[]'::jsonb,
  "bank_transfer_items" jsonb default '[]'::jsonb,
  "card_expense_items" jsonb default '[]'::jsonb,
  "emoney_sales" integer default 0
);

alter table "public"."sales_reports" enable row level security;

create table "public"."shifts" (
  "id" uuid default gen_random_uuid() not null,
  "store_id" uuid,
  "crew_id" uuid,
  "date" date not null,
  "start_time" time without time zone not null,
  "end_time" time without time zone not null,
  "created_at" timestamp with time zone default now()
);

alter table "public"."shifts" enable row level security;

create table "public"."store_memberships" (
  "id" uuid default gen_random_uuid() not null,
  "user_id" uuid not null,
  "store_id" uuid not null,
  "role" text not null,
  "status" text default 'active'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "revoked_at" timestamp with time zone,
  "crew_id" uuid
);

alter table "public"."store_memberships" enable row level security;

create table "public"."stores" (
  "id" uuid default gen_random_uuid() not null,
  "name" text not null,
  "created_at" timestamp with time zone default now(),
  "lat" double precision,
  "lng" double precision,
  "onboarding_done" boolean default false,
  "manager_dashboard_enabled" boolean default false,
  "business_day_cutoff_hour" integer default 6,
  "owner_username" text,
  "franchise_id" uuid,
  "archived_at" timestamp with time zone
);

alter table "public"."stores" enable row level security;

create table "public"."vendors" (
  "id" uuid default gen_random_uuid() not null,
  "store_id" uuid,
  "name" text not null,
  "created_at" timestamp with time zone default now()
);

alter table "public"."vendors" enable row level security;

alter table "public"."announcement_reads" add constraint "announcement_reads_pkey" PRIMARY KEY (announcement_id, crew_id);

alter table "public"."announcements" add constraint "announcements_pkey" PRIMARY KEY (id);

alter table "public"."app_settings" add constraint "app_settings_pkey" PRIMARY KEY (key);

alter table "public"."attendance" add constraint "attendance_pkey" PRIMARY KEY (id);

alter table "public"."attendance_edit_requests" add constraint "attendance_edit_requests_pkey" PRIMARY KEY (id);

alter table "public"."attendance_edit_requests" add constraint "attendance_edit_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])));

alter table "public"."auth_rate_limits" add constraint "auth_rate_limits_pkey" PRIMARY KEY (action, key_hash, window_start);

alter table "public"."checklist_checks" add constraint "checklist_checks_pkey" PRIMARY KEY (store_id, date, item_id);

alter table "public"."checklist_log" add constraint "checklist_log_pkey" PRIMARY KEY (store_id, date);

alter table "public"."checklist_templates" add constraint "checklist_templates_pkey" PRIMARY KEY (store_id, tab);

alter table "public"."crew" add constraint "crew_join_code_key" UNIQUE (join_code);

alter table "public"."crew" add constraint "crew_pkey" PRIMARY KEY (id);

alter table "public"."expense_entries" add constraint "expense_entries_pkey" PRIMARY KEY (id);

alter table "public"."fixed_expenses" add constraint "fixed_expenses_pkey" PRIMARY KEY (id);

alter table "public"."fixed_schedules" add constraint "fixed_schedules_pkey" PRIMARY KEY (id);

alter table "public"."franchise_memberships" add constraint "franchise_memberships_pkey" PRIMARY KEY (id);

alter table "public"."franchise_memberships" add constraint "franchise_memberships_role_check" CHECK ((role = ANY (ARRAY['admin'::text, 'operator'::text, 'viewer'::text])));

alter table "public"."franchise_memberships" add constraint "franchise_memberships_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])));

alter table "public"."franchise_memberships" add constraint "franchise_memberships_user_id_franchise_id_key" UNIQUE (user_id, franchise_id);

alter table "public"."franchises" add constraint "franchises_pkey" PRIMARY KEY (id);

alter table "public"."franchises" add constraint "franchises_username_key" UNIQUE (username);

alter table "public"."owner_requests" add constraint "owner_requests_pkey" PRIMARY KEY (id);

alter table "public"."owner_requests" add constraint "owner_requests_username_store_name_key" UNIQUE (username, store_name);

alter table "public"."platform_admins" add constraint "platform_admins_pkey" PRIMARY KEY (user_id);

alter table "public"."platform_admins" add constraint "platform_admins_role_check" CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'support'::text, 'read_only'::text])));

alter table "public"."platform_admins" add constraint "platform_admins_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])));

alter table "public"."profiles" add constraint "profiles_pkey" PRIMARY KEY (user_id);

alter table "public"."profiles" add constraint "profiles_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'deleted'::text])));

alter table "public"."push_subscriptions" add constraint "push_subscriptions_endpoint_key" UNIQUE (endpoint);

alter table "public"."push_subscriptions" add constraint "push_subscriptions_pkey" PRIMARY KEY (id);

alter table "public"."reservations" add constraint "reservations_pkey" PRIMARY KEY (id);

alter table "public"."sales_report_photos" add constraint "sales_report_photos_pkey" PRIMARY KEY (id);

alter table "public"."sales_reports" add constraint "sales_reports_pkey" PRIMARY KEY (id);

alter table "public"."sales_reports" add constraint "sales_reports_store_id_date_key" UNIQUE (store_id, date);

alter table "public"."shifts" add constraint "shifts_pkey" PRIMARY KEY (id);

alter table "public"."store_memberships" add constraint "store_memberships_pkey" PRIMARY KEY (id);

alter table "public"."store_memberships" add constraint "store_memberships_role_check" CHECK ((role = ANY (ARRAY['owner'::text, 'manager'::text, 'staff'::text])));

alter table "public"."store_memberships" add constraint "store_memberships_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])));

alter table "public"."store_memberships" add constraint "store_memberships_user_id_store_id_key" UNIQUE (user_id, store_id);

alter table "public"."stores" add constraint "stores_name_key" UNIQUE (name);

alter table "public"."stores" add constraint "stores_pkey" PRIMARY KEY (id);

alter table "public"."vendors" add constraint "vendors_pkey" PRIMARY KEY (id);

alter table "public"."announcement_reads" add constraint "announcement_reads_announcement_id_fkey" FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE;

alter table "public"."announcement_reads" add constraint "announcement_reads_crew_id_fkey" FOREIGN KEY (crew_id) REFERENCES crew(id) ON DELETE CASCADE;

alter table "public"."announcements" add constraint "announcements_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."attendance" add constraint "attendance_crew_id_fkey" FOREIGN KEY (crew_id) REFERENCES crew(id) ON DELETE CASCADE;

alter table "public"."attendance" add constraint "attendance_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."attendance_edit_requests" add constraint "attendance_edit_requests_attendance_id_fkey" FOREIGN KEY (attendance_id) REFERENCES attendance(id) ON DELETE CASCADE;

alter table "public"."attendance_edit_requests" add constraint "attendance_edit_requests_crew_id_fkey" FOREIGN KEY (crew_id) REFERENCES crew(id) ON DELETE CASCADE;

alter table "public"."attendance_edit_requests" add constraint "attendance_edit_requests_reviewed_by_fkey" FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

alter table "public"."attendance_edit_requests" add constraint "attendance_edit_requests_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."checklist_checks" add constraint "checklist_checks_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."checklist_log" add constraint "checklist_log_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."checklist_templates" add constraint "checklist_templates_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."crew" add constraint "crew_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."expense_entries" add constraint "expense_entries_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."fixed_expenses" add constraint "fixed_expenses_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."fixed_schedules" add constraint "fixed_schedules_crew_id_fkey" FOREIGN KEY (crew_id) REFERENCES crew(id) ON DELETE CASCADE;

alter table "public"."fixed_schedules" add constraint "fixed_schedules_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."franchise_memberships" add constraint "franchise_memberships_franchise_id_fkey" FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;

alter table "public"."franchise_memberships" add constraint "franchise_memberships_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table "public"."owner_requests" add constraint "owner_requests_auth_user_id_fkey" FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

alter table "public"."platform_admins" add constraint "platform_admins_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table "public"."profiles" add constraint "profiles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table "public"."sales_report_photos" add constraint "sales_report_photos_sales_report_id_fkey" FOREIGN KEY (sales_report_id) REFERENCES sales_reports(id) ON DELETE CASCADE;

alter table "public"."sales_reports" add constraint "sales_reports_crew_id_fkey" FOREIGN KEY (crew_id) REFERENCES crew(id) ON DELETE SET NULL;

alter table "public"."sales_reports" add constraint "sales_reports_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."shifts" add constraint "shifts_crew_id_fkey" FOREIGN KEY (crew_id) REFERENCES crew(id) ON DELETE SET NULL;

alter table "public"."shifts" add constraint "shifts_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."store_memberships" add constraint "store_memberships_crew_id_fkey" FOREIGN KEY (crew_id) REFERENCES crew(id) ON DELETE SET NULL;

alter table "public"."store_memberships" add constraint "store_memberships_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

alter table "public"."store_memberships" add constraint "store_memberships_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table "public"."stores" add constraint "stores_franchise_id_fkey" FOREIGN KEY (franchise_id) REFERENCES franchises(id);

alter table "public"."vendors" add constraint "vendors_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;

CREATE INDEX idx_fixed_expenses_store_month ON public.fixed_expenses USING btree (store_id, month_key);

CREATE INDEX idx_announcements_store ON public.announcements USING btree (store_id);

CREATE INDEX auth_rate_limits_updated_at_idx ON public.auth_rate_limits USING btree (updated_at);

CREATE INDEX stores_active_owner_idx ON public.stores USING btree (owner_username) WHERE (archived_at IS NULL);

CREATE INDEX store_memberships_store_idx ON public.store_memberships USING btree (store_id);

CREATE INDEX idx_expense_entries_store_date ON public.expense_entries USING btree (store_id, date);

CREATE INDEX store_memberships_store_active_idx ON public.store_memberships USING btree (store_id, status);

CREATE INDEX idx_owner_requests_username ON public.owner_requests USING btree (username);

CREATE UNIQUE INDEX profiles_username_lower_uidx ON public.profiles USING btree (lower(username));

CREATE INDEX idx_attendance_store_date ON public.attendance USING btree (store_id, date);

CREATE INDEX owner_requests_auth_user_id_idx ON public.owner_requests USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);

CREATE UNIQUE INDEX attendance_no_exact_duplicate_closed_uidx ON public.attendance USING btree (store_id, crew_id, date, check_in, check_out) WHERE (check_out IS NOT NULL);

CREATE UNIQUE INDEX idx_stores_name_owner_unique ON public.stores USING btree (name, owner_username);

CREATE UNIQUE INDEX attendance_edit_requests_one_pending_uidx ON public.attendance_edit_requests USING btree (attendance_id, crew_id) WHERE (status = 'pending'::text);

CREATE INDEX idx_crew_store ON public.crew USING btree (store_id);

CREATE UNIQUE INDEX attendance_no_duplicate_open_uidx ON public.attendance USING btree (store_id, crew_id, date, check_in) WHERE (check_out IS NULL);

CREATE INDEX idx_stores_owner_username ON public.stores USING btree (owner_username);

CREATE INDEX franchise_memberships_user_status_role_idx ON public.franchise_memberships USING btree (user_id, status, role);

CREATE INDEX franchise_memberships_user_idx ON public.franchise_memberships USING btree (user_id);

CREATE INDEX franchise_memberships_franchise_active_idx ON public.franchise_memberships USING btree (franchise_id, status);

CREATE INDEX store_memberships_user_status_role_idx ON public.store_memberships USING btree (user_id, status, role);

CREATE INDEX idx_vendors_store ON public.vendors USING btree (store_id);

CREATE INDEX idx_shifts_store_date ON public.shifts USING btree (store_id, date);

CREATE INDEX franchise_memberships_franchise_idx ON public.franchise_memberships USING btree (franchise_id);

CREATE INDEX store_memberships_user_idx ON public.store_memberships USING btree (user_id);

CREATE INDEX idx_sales_reports_store_date ON public.sales_reports USING btree (store_id, date);

CREATE INDEX stores_active_franchise_idx ON public.stores USING btree (franchise_id) WHERE (archived_at IS NULL);

CREATE UNIQUE INDEX store_memberships_crew_uidx ON public.store_memberships USING btree (crew_id) WHERE (crew_id IS NOT NULL);

CREATE OR REPLACE FUNCTION private.can_delete_financials(target_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    private.has_platform_role(array['super_admin','admin']::text[])
    or private.has_store_membership(target_store_id, array['owner']::text[]);
$function$;

revoke all on function "private"."can_delete_financials"(target_store_id uuid) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.can_manage_store(target_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    private.has_platform_role(array['super_admin','admin']::text[])
    or private.has_store_membership(target_store_id, array['owner','manager']::text[]);
$function$;

revoke all on function "private"."can_manage_store"(target_store_id uuid) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.can_view_financials(target_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    private.has_platform_role(array['super_admin','admin','support','read_only']::text[])
    or private.has_sales_access(target_store_id)
    or exists (
      select 1
      from public.stores s
      where s.id = target_store_id
        and s.archived_at is null
        and s.franchise_id is not null
        and private.has_franchise_membership(s.franchise_id, array['admin','operator','viewer']::text[])
    );
$function$;

revoke all on function "private"."can_view_financials"(target_store_id uuid) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.can_view_store(target_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    private.has_platform_role(array['super_admin','admin','support','read_only']::text[])
    or private.has_store_membership(target_store_id, null)
    or exists (
      select 1
      from public.stores s
      where s.id = target_store_id
        and s.archived_at is null
        and s.franchise_id is not null
        and private.has_franchise_membership(s.franchise_id, array['admin','operator','viewer']::text[])
    );
$function$;

revoke all on function "private"."can_view_store"(target_store_id uuid) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.can_write_financials(target_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    private.has_platform_role(array['super_admin','admin']::text[])
    or private.has_sales_access(target_store_id);
$function$;

revoke all on function "private"."can_write_financials"(target_store_id uuid) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.current_crew_id(target_store_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select sm.crew_id
  from public.store_memberships sm
  where sm.user_id = (select auth.uid())
    and sm.store_id = target_store_id
    and sm.status = 'active'
    and sm.crew_id is not null
  limit 1;
$function$;

revoke all on function "private"."current_crew_id"(target_store_id uuid) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.distance_meters(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
 RETURNS double precision
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select 6371000.0 * 2.0 * asin(
    sqrt(
      power(sin(radians((lat2-lat1)/2.0)),2) +
      cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians((lng2-lng1)/2.0)),2)
    )
  );
$function$;

revoke all on function "private"."distance_meters"(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.has_franchise_membership(target_franchise_id uuid, allowed_roles text[] DEFAULT NULL::text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.franchise_memberships fm
    where fm.user_id = (select auth.uid())
      and fm.franchise_id = target_franchise_id
      and fm.status = 'active'
      and (allowed_roles is null or fm.role = any(allowed_roles))
  );
$function$;

revoke all on function "private"."has_franchise_membership"(target_franchise_id uuid, allowed_roles text[]) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.has_platform_role(allowed_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = (select auth.uid())
      and pa.status = 'active'
      and pa.role = any(allowed_roles)
  );
$function$;

revoke all on function "private"."has_platform_role"(allowed_roles text[]) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.has_sales_access(target_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    private.has_store_membership(target_store_id, array['owner','manager']::text[])
    or exists (
      select 1
      from public.store_memberships sm
      join public.crew c on c.id = sm.crew_id
      where sm.user_id = (select auth.uid())
        and sm.store_id = target_store_id
        and sm.status = 'active'
        and sm.role = 'staff'
        and c.sales_access = true
    );
$function$;

revoke all on function "private"."has_sales_access"(target_store_id uuid) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.has_store_membership(target_store_id uuid, allowed_roles text[] DEFAULT NULL::text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.store_memberships sm
    where sm.user_id = (select auth.uid())
      and sm.store_id = target_store_id
      and sm.status = 'active'
      and (allowed_roles is null or sm.role = any(allowed_roles))
  );
$function$;

revoke all on function "private"."has_store_membership"(target_store_id uuid, allowed_roles text[]) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.is_platform_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = (select auth.uid())
      and pa.status = 'active'
  );
$function$;

revoke all on function "private"."is_platform_admin"() from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.is_store_owner(target_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    private.has_platform_role(array['super_admin','admin']::text[])
    or private.has_store_membership(target_store_id, array['owner']::text[]);
$function$;

revoke all on function "private"."is_store_owner"(target_store_id uuid) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.protect_owner_request_auth_metadata()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
begin
  if coalesce(auth.role(), '') in ('anon','authenticated') then
    if tg_op = 'INSERT' then
      new.auth_user_id := null;
      new.auth_migrated_at := null;
    elsif tg_op = 'UPDATE' then
      new.auth_user_id := old.auth_user_id;
      new.auth_migrated_at := old.auth_migrated_at;
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function "private"."protect_owner_request_auth_metadata"() from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.approve_attendance_edit_request(target_request_id uuid, note text DEFAULT ''::text)
 RETURNS attendance_edit_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  req public.attendance_edit_requests%rowtype;
  att public.attendance%rowtype;
  new_in time;
  new_out time;
  result public.attendance_edit_requests%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;

  select * into req
  from public.attendance_edit_requests
  where id = target_request_id
  for update;

  if not found then
    raise exception 'Edit request not found';
  end if;

  if req.status <> 'pending' then
    raise exception 'Edit request is not pending';
  end if;

  if not private.can_manage_store(req.store_id) then
    raise exception 'Not authorized to review this request' using errcode='42501';
  end if;

  select * into att
  from public.attendance
  where id = req.attendance_id
  for update;

  if not found then
    raise exception 'Attendance not found';
  end if;

  if att.store_id <> req.store_id or att.crew_id <> req.crew_id then
    raise exception 'Attendance/request mismatch';
  end if;

  new_in := coalesce(req.requested_check_in, att.check_in);
  new_out := coalesce(req.requested_check_out, att.check_out);

  if new_in is null then
    raise exception 'Check-in time is required';
  end if;

  begin
    update public.attendance
    set check_in = new_in,
        check_out = new_out,
        confirmed = true,
        staff_confirmed = false,
        time_edited = true,
        staff_ack_edit = false
    where id = att.id;
  exception
    when unique_violation then
      raise exception 'The approved time would duplicate another attendance record';
  end;

  update public.attendance_edit_requests
  set status = 'approved',
      reviewed_at = now(),
      reviewed_by = (select auth.uid()),
      review_note = coalesce(note,'')
  where id = target_request_id
  returning * into result;

  return result;
end;
$function$;

revoke all on function "public"."approve_attendance_edit_request"(target_request_id uuid, note text) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bootstrap_legacy_owner_account(p_user_id uuid, p_username text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_username text := lower(trim(p_username));
  v_display_name text;
  v_store_count integer := 0;
begin
  if p_user_id is null or v_username = '' then
    raise exception 'invalid migration input';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'auth user does not exist';
  end if;

  select nullif(trim(r.name), '')
    into v_display_name
  from public.owner_requests r
  where r.status = 'approved'
    and lower(trim(r.username)) = v_username
  order by r.requested_at nulls last, r.id
  limit 1;

  if not found then
    raise exception 'approved legacy owner not found';
  end if;

  if exists (
    select 1
    from public.profiles p
    where lower(trim(p.username)) = v_username
      and p.user_id <> p_user_id
  ) then
    raise exception 'username already mapped to another auth user';
  end if;

  insert into public.profiles(user_id, username, display_name, status)
  values (p_user_id, v_username, v_display_name, 'active')
  on conflict (user_id) do update
    set username = excluded.username,
        display_name = coalesce(public.profiles.display_name, excluded.display_name),
        status = 'active',
        updated_at = now();

  insert into public.store_memberships(user_id, store_id, role, status)
  select distinct p_user_id, s.id, 'owner', 'active'
  from public.owner_requests r
  join public.stores s
    on s.name = r.store_name
   and lower(trim(coalesce(s.owner_username, ''))) = v_username
  where r.status = 'approved'
    and lower(trim(r.username)) = v_username
    and s.archived_at is null
  on conflict (user_id, store_id) do update
    set role = 'owner',
        status = 'active',
        revoked_at = null;

  get diagnostics v_store_count = row_count;

  if v_store_count = 0 then
    raise exception 'no approved stores linked to legacy owner';
  end if;

  return v_store_count;
end;
$function$;

revoke all on function "public"."bootstrap_legacy_owner_account"(p_user_id uuid, p_username text) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bootstrap_owner_account(p_user_id uuid, p_username text, p_display_name text, p_store_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  new_store_id uuid;
  normalized_username text := lower(btrim(normalize(coalesce(p_username, ''), NFKC)));
  clean_store_name text := trim(p_store_name);
begin
  if p_user_id is null then
    raise exception 'user_id is required';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'auth user not found';
  end if;
  if normalized_username = '' then
    raise exception 'username is required';
  end if;
  if clean_store_name is null or clean_store_name = '' or char_length(clean_store_name) > 80 then
    raise exception 'invalid store name';
  end if;

  -- Check again in the bootstrap transaction; old Edge versions also call here.
  -- The existing profiles username unique index arbitrates simultaneous new signups.
  -- Legacy-table writes remain an independent migration/RLS prerequisite.
  if public.is_manee_username_reserved(normalized_username) then
    raise exception using errcode = '23505', message = 'username_taken';
  end if;

  insert into public.profiles(user_id, username, display_name, status)
  values(p_user_id, normalized_username, nullif(trim(p_display_name), ''), 'active');

  insert into public.stores(name, owner_username, onboarding_done)
  values(clean_store_name, normalized_username, false)
  returning id into new_store_id;

  insert into public.store_memberships(user_id, store_id, role, status)
  values(p_user_id, new_store_id, 'owner', 'active');
  return new_store_id;
end;
$function$;

revoke all on function "public"."bootstrap_owner_account"(p_user_id uuid, p_username text, p_display_name text, p_store_name text) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cancel_my_attendance_edit_request(target_request_id uuid)
 RETURNS attendance_edit_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  req public.attendance_edit_requests%rowtype;
  cid uuid;
  result public.attendance_edit_requests%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;

  select * into req
  from public.attendance_edit_requests
  where id = target_request_id
  for update;

  if not found then
    raise exception 'Edit request not found';
  end if;

  if req.status <> 'pending' then
    raise exception 'Only pending requests can be cancelled';
  end if;

  cid := private.current_crew_id(req.store_id);
  if cid is null or cid <> req.crew_id then
    raise exception 'Not authorized' using errcode='42501';
  end if;

  update public.attendance_edit_requests
  set status = 'cancelled',
      reviewed_at = now(),
      reviewed_by = (select auth.uid()),
      review_note = 'cancelled by requester'
  where id = target_request_id
  returning * into result;

  return result;
end;
$function$;

revoke all on function "public"."cancel_my_attendance_edit_request"(target_request_id uuid) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.clock_in(target_store_id uuid, current_lat double precision, current_lng double precision)
 RETURNS attendance
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  cid uuid;
  st public.stores%rowtype;
  local_now timestamp;
  business_date date;
  cutoff int;
  dist double precision;
  result public.attendance%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;

  cid := private.current_crew_id(target_store_id);
  if cid is null then
    raise exception 'No crew membership for this store' using errcode='42501';
  end if;

  select * into st from public.stores where id=target_store_id and archived_at is null;
  if not found then raise exception 'Store not found'; end if;
  if st.lat is null or st.lng is null then raise exception 'Store location is not configured'; end if;
  if current_lat is null or current_lng is null then raise exception 'Current location is required'; end if;

  dist := private.distance_meters(st.lat, st.lng, current_lat, current_lng);
  if dist > 100.0 then raise exception 'Outside attendance radius (%.1f m)', dist; end if;

  if exists(select 1 from public.attendance a where a.store_id=target_store_id and a.crew_id=cid and a.check_out is null) then
    raise exception 'Already clocked in';
  end if;

  local_now := timezone('Asia/Seoul', now());
  cutoff := coalesce(st.business_day_cutoff_hour,6);
  business_date := local_now::date;
  if extract(hour from local_now)::int < cutoff then business_date := business_date - 1; end if;

  insert into public.attendance(store_id,crew_id,date,check_in,confirmed,staff_confirmed,time_edited,staff_ack_edit)
  values(target_store_id,cid,business_date,local_now::time,false,false,false,false)
  returning * into result;

  return result;
end;
$function$;

revoke all on function "public"."clock_in"(target_store_id uuid, current_lat double precision, current_lng double precision) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.clock_out(target_attendance_id uuid, current_lat double precision, current_lng double precision)
 RETURNS attendance
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a public.attendance%rowtype;
  st public.stores%rowtype;
  cid uuid;
  local_now timestamp;
  dist double precision;
  result public.attendance%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode='42501'; end if;

  select * into a from public.attendance where id=target_attendance_id;
  if not found then raise exception 'Attendance not found'; end if;

  cid := private.current_crew_id(a.store_id);
  if cid is null or cid <> a.crew_id then raise exception 'Not authorized for this attendance' using errcode='42501'; end if;
  if a.check_out is not null then raise exception 'Already clocked out'; end if;

  select * into st from public.stores where id=a.store_id and archived_at is null;
  if not found then raise exception 'Store not found'; end if;
  if st.lat is null or st.lng is null then raise exception 'Store location is not configured'; end if;
  if current_lat is null or current_lng is null then raise exception 'Current location is required'; end if;

  dist := private.distance_meters(st.lat, st.lng, current_lat, current_lng);
  if dist > 100.0 then raise exception 'Outside attendance radius (%.1f m)', dist; end if;

  local_now := timezone('Asia/Seoul', now());
  update public.attendance
  set check_out=local_now::time,
      staff_confirmed=false
  where id=target_attendance_id
  returning * into result;

  return result;
end;
$function$;

revoke all on function "public"."clock_out"(target_attendance_id uuid, current_lat double precision, current_lng double precision) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.confirm_my_attendance(target_attendance_id uuid)
 RETURNS attendance
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a public.attendance%rowtype;
  cid uuid;
  result public.attendance%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into a from public.attendance where id=target_attendance_id;
  if not found then raise exception 'Attendance not found'; end if;
  cid := private.current_crew_id(a.store_id);
  if cid is null or cid<>a.crew_id then raise exception 'Not authorized' using errcode='42501'; end if;

  update public.attendance
  set staff_confirmed=true,
      staff_ack_edit=case when time_edited then true else staff_ack_edit end
  where id=target_attendance_id
  returning * into result;
  return result;
end;
$function$;

revoke all on function "public"."confirm_my_attendance"(target_attendance_id uuid) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.consume_auth_rate_limit(p_action text, p_key_hash text, p_window_seconds integer, p_max_attempts integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  bucket_start timestamptz;
  new_count integer;
begin
  if p_window_seconds <= 0 or p_max_attempts <= 0 then
    raise exception 'Invalid rate limit configuration';
  end if;

  bucket_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.auth_rate_limits(action, key_hash, window_start, attempt_count, updated_at)
  values(p_action, p_key_hash, bucket_start, 1, now())
  on conflict(action, key_hash, window_start)
  do update set
    attempt_count = public.auth_rate_limits.attempt_count + 1,
    updated_at = now()
  returning attempt_count into new_count;

  return new_count <= p_max_attempts;
end;
$function$;

revoke all on function "public"."consume_auth_rate_limit"(p_action text, p_key_hash text, p_window_seconds integer, p_max_attempts integer) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_franchise_store_overview(target_franchise_id uuid, target_month date DEFAULT CURRENT_DATE)
 RETURNS TABLE(store_id uuid, store_name text, month_key text, net_sales bigint, expense_total bigint, active_crew_count bigint, report_days bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  month_start date := date_trunc('month', target_month)::date;
  month_end date := (date_trunc('month', target_month) + interval '1 month')::date;
begin
  if not (
    private.has_platform_role(array['super_admin','admin','support','read_only']::text[])
    or private.has_franchise_membership(target_franchise_id, array['admin','operator','viewer']::text[])
  ) then
    raise exception 'Not authorized for this franchise' using errcode='42501';
  end if;

  return query
  select
    s.id,
    s.name,
    to_char(month_start, 'YYYY-MM'),
    coalesce((select sum(sr.net_sales)::bigint from public.sales_reports sr where sr.store_id=s.id and sr.date>=month_start and sr.date<month_end),0),
    coalesce((select sum(e.amount)::bigint from public.expense_entries e where e.store_id=s.id and e.date>=month_start and e.date<month_end),0),
    coalesce((select count(*)::bigint from public.crew c where c.store_id=s.id and (c.resign_date is null or c.resign_date>=current_date)),0),
    coalesce((select count(distinct sr2.date)::bigint from public.sales_reports sr2 where sr2.store_id=s.id and sr2.date>=month_start and sr2.date<month_end),0)
  from public.stores s
  where s.franchise_id=target_franchise_id
    and s.archived_at is null
  order by s.name;
end;
$function$;

revoke all on function "public"."get_franchise_store_overview"(target_franchise_id uuid, target_month date) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_store_crew_directory(target_store_id uuid)
 RETURNS TABLE(crew_id uuid, store_id uuid, crew_name text, crew_position text, is_manager boolean, resign_date date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not private.can_view_store(target_store_id) then
    raise exception 'Not authorized for this store' using errcode='42501';
  end if;

  return query
  select c.id, c.store_id, c.name, c.position, c.is_manager, c.resign_date
  from public.crew c
  where c.store_id = target_store_id
  order by (c.resign_date is not null), c.name;
end;
$function$;

revoke all on function "public"."get_store_crew_directory"(target_store_id uuid) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_manee_username_reserved(p_username text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with target as (
    select lower(btrim(normalize(coalesce(p_username, ''), NFKC))) as username
  )
  select exists (
    select 1 from public.profiles p, target t
    where lower(btrim(normalize(p.username, NFKC))) = t.username
  ) or exists (
    select 1 from public.owner_requests r, target t
    where lower(btrim(normalize(r.username, NFKC))) = t.username
      and r.status in ('approved', 'pending', 'revoked')
  ) or exists (
    -- Archived stores also retain their owner's identifier.
    select 1 from public.stores s, target t
    where lower(btrim(normalize(s.owner_username, NFKC))) = t.username
  );
$function$;

revoke all on function "public"."is_manee_username_reserved"(p_username text) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prevent_store_hard_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.stores
     set archived_at = coalesce(archived_at, now())
   where id = old.id;
  return null;
end;
$function$;

revoke all on function "public"."prevent_store_hard_delete"() from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reject_attendance_edit_request(target_request_id uuid, note text DEFAULT ''::text)
 RETURNS attendance_edit_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  req public.attendance_edit_requests%rowtype;
  result public.attendance_edit_requests%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;

  select * into req
  from public.attendance_edit_requests
  where id = target_request_id
  for update;

  if not found then
    raise exception 'Edit request not found';
  end if;

  if req.status <> 'pending' then
    raise exception 'Edit request is not pending';
  end if;

  if not private.can_manage_store(req.store_id) then
    raise exception 'Not authorized to review this request' using errcode='42501';
  end if;

  update public.attendance_edit_requests
  set status = 'rejected',
      reviewed_at = now(),
      reviewed_by = (select auth.uid()),
      review_note = coalesce(note,'')
  where id = target_request_id
  returning * into result;

  return result;
end;
$function$;

revoke all on function "public"."reject_attendance_edit_request"(target_request_id uuid, note text) from PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.request_attendance_edit(target_attendance_id uuid, new_check_in time without time zone, new_check_out time without time zone, request_reason text DEFAULT ''::text)
 RETURNS attendance_edit_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a public.attendance%rowtype;
  cid uuid;
  result public.attendance_edit_requests%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into a from public.attendance where id=target_attendance_id;
  if not found then raise exception 'Attendance not found'; end if;
  cid := private.current_crew_id(a.store_id);
  if cid is null or cid<>a.crew_id then raise exception 'Not authorized' using errcode='42501'; end if;
  if new_check_in is null and new_check_out is null then raise exception 'Requested time is required'; end if;
  if exists(select 1 from public.attendance_edit_requests r where r.attendance_id=a.id and r.crew_id=cid and r.status='pending') then
    raise exception 'Pending edit request already exists';
  end if;

  insert into public.attendance_edit_requests(attendance_id,store_id,crew_id,requested_check_in,requested_check_out,reason)
  values(a.id,a.store_id,cid,new_check_in,new_check_out,left(coalesce(request_reason,''),500))
  returning * into result;
  return result;
end;
$function$;

revoke all on function "public"."request_attendance_edit"(target_attendance_id uuid, new_check_in time without time zone, new_check_out time without time zone, request_reason text) from PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER protect_owner_request_auth_metadata_trg BEFORE INSERT OR UPDATE ON public.owner_requests FOR EACH ROW EXECUTE FUNCTION private.protect_owner_request_auth_metadata();

CREATE RULE stores_soft_delete AS
    ON DELETE TO public.stores DO INSTEAD  UPDATE stores SET archived_at = COALESCE(stores.archived_at, now())
  WHERE (stores.id = old.id);

create policy "allow all - announcement_reads" on "public"."announcement_reads" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "allow all - announcements" on "public"."announcements" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "allow all - app_settings" on "public"."app_settings" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "allow all - attendance" on "public"."attendance" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "attendance_edit_requests_select" on "public"."attendance_edit_requests" as PERMISSIVE for SELECT to "authenticated" using (((crew_id = private.current_crew_id(store_id)) OR private.can_manage_store(store_id)));

create policy "allow all - checklist_checks" on "public"."checklist_checks" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "allow all - checklist_log" on "public"."checklist_log" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "allow all - checklist_templates" on "public"."checklist_templates" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "allow all - crew" on "public"."crew" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "allow all - expense_entries" on "public"."expense_entries" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "expense_entries_delete_v2" on "public"."expense_entries" as PERMISSIVE for DELETE to "authenticated" using (( SELECT private.can_delete_financials(expense_entries.store_id) AS can_delete_financials));

create policy "expense_entries_insert_v2" on "public"."expense_entries" as PERMISSIVE for INSERT to "authenticated" with check (( SELECT private.can_write_financials(expense_entries.store_id) AS can_write_financials));

create policy "expense_entries_select_v2" on "public"."expense_entries" as PERMISSIVE for SELECT to "authenticated" using (( SELECT private.can_view_financials(expense_entries.store_id) AS can_view_financials));

create policy "expense_entries_update_v2" on "public"."expense_entries" as PERMISSIVE for UPDATE to "authenticated" using (( SELECT private.can_manage_store(expense_entries.store_id) AS can_manage_store)) with check (( SELECT private.can_manage_store(expense_entries.store_id) AS can_manage_store));

create policy "allow all - fixed_expenses" on "public"."fixed_expenses" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "allow all - fixed_schedules" on "public"."fixed_schedules" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "franchise_memberships_select_self" on "public"."franchise_memberships" as PERMISSIVE for SELECT to "authenticated" using ((( SELECT auth.uid() AS uid) = user_id));

create policy "allow all - owner_requests" on "public"."owner_requests" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "platform_admins_select_self" on "public"."platform_admins" as PERMISSIVE for SELECT to "authenticated" using ((( SELECT auth.uid() AS uid) = user_id));

create policy "profiles_select_self" on "public"."profiles" as PERMISSIVE for SELECT to "authenticated" using ((( SELECT auth.uid() AS uid) = user_id));

create policy "allow all - sales_report_photos" on "public"."sales_report_photos" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "allow all - sales_reports" on "public"."sales_reports" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "sales_reports_delete_v2" on "public"."sales_reports" as PERMISSIVE for DELETE to "authenticated" using (( SELECT private.can_delete_financials(sales_reports.store_id) AS can_delete_financials));

create policy "sales_reports_insert_v2" on "public"."sales_reports" as PERMISSIVE for INSERT to "authenticated" with check (( SELECT private.can_write_financials(sales_reports.store_id) AS can_write_financials));

create policy "sales_reports_select_v2" on "public"."sales_reports" as PERMISSIVE for SELECT to "authenticated" using (( SELECT private.can_view_financials(sales_reports.store_id) AS can_view_financials));

create policy "sales_reports_update_v2" on "public"."sales_reports" as PERMISSIVE for UPDATE to "authenticated" using (( SELECT private.can_write_financials(sales_reports.store_id) AS can_write_financials)) with check (( SELECT private.can_write_financials(sales_reports.store_id) AS can_write_financials));

create policy "allow all - shifts" on "public"."shifts" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "store_memberships_select_self" on "public"."store_memberships" as PERMISSIVE for SELECT to "authenticated" using ((( SELECT auth.uid() AS uid) = user_id));

create policy "allow all - stores" on "public"."stores" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

create policy "hide archived stores" on "public"."stores" as RESTRICTIVE for SELECT to PUBLIC using ((archived_at IS NULL));

create policy "allow all - vendors" on "public"."vendors" as PERMISSIVE for ALL to PUBLIC using (true) with check (true);

revoke all on table "public"."announcement_reads" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."announcements" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."app_settings" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."attendance" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."attendance_edit_requests" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."auth_rate_limits" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."checklist_checks" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."checklist_log" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."checklist_templates" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."crew" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."expense_entries" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."fixed_expenses" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."fixed_schedules" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."franchise_memberships" from PUBLIC, anon, authenticated, service_role;

create policy staging_legacy_compatibility on "public"."franchises" for all to PUBLIC using (true) with check (true);

revoke all on table "public"."franchises" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."owner_requests" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."platform_admins" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."profiles" from PUBLIC, anon, authenticated, service_role;

create policy staging_legacy_compatibility on "public"."push_subscriptions" for all to PUBLIC using (true) with check (true);

revoke all on table "public"."push_subscriptions" from PUBLIC, anon, authenticated, service_role;

create policy staging_legacy_compatibility on "public"."reservations" for all to PUBLIC using (true) with check (true);

revoke all on table "public"."reservations" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."sales_report_photos" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."sales_reports" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."shifts" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."store_memberships" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."stores" from PUBLIC, anon, authenticated, service_role;

revoke all on table "public"."vendors" from PUBLIC, anon, authenticated, service_role;

revoke all on sequence "public"."push_subscriptions_id_seq" from PUBLIC, anon, authenticated, service_role;

revoke all on sequence "public"."reservations_id_seq" from PUBLIC, anon, authenticated, service_role;

grant INSERT on table "public"."franchises" to "anon";

grant SELECT on table "public"."franchises" to "anon";

grant UPDATE on table "public"."franchises" to "anon";

grant DELETE on table "public"."franchises" to "anon";

grant TRUNCATE on table "public"."franchises" to "anon";

grant REFERENCES on table "public"."franchises" to "anon";

grant TRIGGER on table "public"."franchises" to "anon";

grant MAINTAIN on table "public"."franchises" to "anon";

grant INSERT on table "public"."franchises" to "authenticated";

grant SELECT on table "public"."franchises" to "authenticated";

grant UPDATE on table "public"."franchises" to "authenticated";

grant DELETE on table "public"."franchises" to "authenticated";

grant TRUNCATE on table "public"."franchises" to "authenticated";

grant REFERENCES on table "public"."franchises" to "authenticated";

grant TRIGGER on table "public"."franchises" to "authenticated";

grant MAINTAIN on table "public"."franchises" to "authenticated";

grant INSERT on table "public"."franchises" to "service_role";

grant SELECT on table "public"."franchises" to "service_role";

grant UPDATE on table "public"."franchises" to "service_role";

grant DELETE on table "public"."franchises" to "service_role";

grant TRUNCATE on table "public"."franchises" to "service_role";

grant REFERENCES on table "public"."franchises" to "service_role";

grant TRIGGER on table "public"."franchises" to "service_role";

grant MAINTAIN on table "public"."franchises" to "service_role";

grant INSERT on table "public"."profiles" to "service_role";

grant SELECT on table "public"."profiles" to "service_role";

grant UPDATE on table "public"."profiles" to "service_role";

grant DELETE on table "public"."profiles" to "service_role";

grant TRUNCATE on table "public"."profiles" to "service_role";

grant REFERENCES on table "public"."profiles" to "service_role";

grant TRIGGER on table "public"."profiles" to "service_role";

grant MAINTAIN on table "public"."profiles" to "service_role";

grant SELECT on table "public"."profiles" to "authenticated";

grant INSERT on table "public"."store_memberships" to "service_role";

grant SELECT on table "public"."store_memberships" to "service_role";

grant UPDATE on table "public"."store_memberships" to "service_role";

grant DELETE on table "public"."store_memberships" to "service_role";

grant TRUNCATE on table "public"."store_memberships" to "service_role";

grant REFERENCES on table "public"."store_memberships" to "service_role";

grant TRIGGER on table "public"."store_memberships" to "service_role";

grant MAINTAIN on table "public"."store_memberships" to "service_role";

grant SELECT on table "public"."store_memberships" to "authenticated";

grant INSERT on table "public"."franchise_memberships" to "service_role";

grant SELECT on table "public"."franchise_memberships" to "service_role";

grant UPDATE on table "public"."franchise_memberships" to "service_role";

grant DELETE on table "public"."franchise_memberships" to "service_role";

grant TRUNCATE on table "public"."franchise_memberships" to "service_role";

grant REFERENCES on table "public"."franchise_memberships" to "service_role";

grant TRIGGER on table "public"."franchise_memberships" to "service_role";

grant MAINTAIN on table "public"."franchise_memberships" to "service_role";

grant SELECT on table "public"."franchise_memberships" to "authenticated";

grant INSERT on table "public"."platform_admins" to "service_role";

grant SELECT on table "public"."platform_admins" to "service_role";

grant UPDATE on table "public"."platform_admins" to "service_role";

grant DELETE on table "public"."platform_admins" to "service_role";

grant TRUNCATE on table "public"."platform_admins" to "service_role";

grant REFERENCES on table "public"."platform_admins" to "service_role";

grant TRIGGER on table "public"."platform_admins" to "service_role";

grant MAINTAIN on table "public"."platform_admins" to "service_role";

grant SELECT on table "public"."platform_admins" to "authenticated";

grant INSERT on table "public"."attendance_edit_requests" to "service_role";

grant SELECT on table "public"."attendance_edit_requests" to "service_role";

grant UPDATE on table "public"."attendance_edit_requests" to "service_role";

grant DELETE on table "public"."attendance_edit_requests" to "service_role";

grant TRUNCATE on table "public"."attendance_edit_requests" to "service_role";

grant REFERENCES on table "public"."attendance_edit_requests" to "service_role";

grant TRIGGER on table "public"."attendance_edit_requests" to "service_role";

grant MAINTAIN on table "public"."attendance_edit_requests" to "service_role";

grant SELECT on table "public"."attendance_edit_requests" to "authenticated";

grant INSERT on table "public"."stores" to "anon";

grant SELECT on table "public"."stores" to "anon";

grant UPDATE on table "public"."stores" to "anon";

grant DELETE on table "public"."stores" to "anon";

grant TRUNCATE on table "public"."stores" to "anon";

grant REFERENCES on table "public"."stores" to "anon";

grant TRIGGER on table "public"."stores" to "anon";

grant MAINTAIN on table "public"."stores" to "anon";

grant INSERT on table "public"."stores" to "authenticated";

grant SELECT on table "public"."stores" to "authenticated";

grant UPDATE on table "public"."stores" to "authenticated";

grant DELETE on table "public"."stores" to "authenticated";

grant TRUNCATE on table "public"."stores" to "authenticated";

grant REFERENCES on table "public"."stores" to "authenticated";

grant TRIGGER on table "public"."stores" to "authenticated";

grant MAINTAIN on table "public"."stores" to "authenticated";

grant INSERT on table "public"."stores" to "service_role";

grant SELECT on table "public"."stores" to "service_role";

grant UPDATE on table "public"."stores" to "service_role";

grant DELETE on table "public"."stores" to "service_role";

grant TRUNCATE on table "public"."stores" to "service_role";

grant REFERENCES on table "public"."stores" to "service_role";

grant TRIGGER on table "public"."stores" to "service_role";

grant MAINTAIN on table "public"."stores" to "service_role";

grant INSERT on table "public"."app_settings" to "anon";

grant SELECT on table "public"."app_settings" to "anon";

grant UPDATE on table "public"."app_settings" to "anon";

grant DELETE on table "public"."app_settings" to "anon";

grant TRUNCATE on table "public"."app_settings" to "anon";

grant REFERENCES on table "public"."app_settings" to "anon";

grant TRIGGER on table "public"."app_settings" to "anon";

grant MAINTAIN on table "public"."app_settings" to "anon";

grant INSERT on table "public"."app_settings" to "authenticated";

grant SELECT on table "public"."app_settings" to "authenticated";

grant UPDATE on table "public"."app_settings" to "authenticated";

grant DELETE on table "public"."app_settings" to "authenticated";

grant TRUNCATE on table "public"."app_settings" to "authenticated";

grant REFERENCES on table "public"."app_settings" to "authenticated";

grant TRIGGER on table "public"."app_settings" to "authenticated";

grant MAINTAIN on table "public"."app_settings" to "authenticated";

grant INSERT on table "public"."app_settings" to "service_role";

grant SELECT on table "public"."app_settings" to "service_role";

grant UPDATE on table "public"."app_settings" to "service_role";

grant DELETE on table "public"."app_settings" to "service_role";

grant TRUNCATE on table "public"."app_settings" to "service_role";

grant REFERENCES on table "public"."app_settings" to "service_role";

grant TRIGGER on table "public"."app_settings" to "service_role";

grant MAINTAIN on table "public"."app_settings" to "service_role";

grant INSERT on table "public"."checklist_templates" to "anon";

grant SELECT on table "public"."checklist_templates" to "anon";

grant UPDATE on table "public"."checklist_templates" to "anon";

grant DELETE on table "public"."checklist_templates" to "anon";

grant TRUNCATE on table "public"."checklist_templates" to "anon";

grant REFERENCES on table "public"."checklist_templates" to "anon";

grant TRIGGER on table "public"."checklist_templates" to "anon";

grant MAINTAIN on table "public"."checklist_templates" to "anon";

grant INSERT on table "public"."checklist_templates" to "authenticated";

grant SELECT on table "public"."checklist_templates" to "authenticated";

grant UPDATE on table "public"."checklist_templates" to "authenticated";

grant DELETE on table "public"."checklist_templates" to "authenticated";

grant TRUNCATE on table "public"."checklist_templates" to "authenticated";

grant REFERENCES on table "public"."checklist_templates" to "authenticated";

grant TRIGGER on table "public"."checklist_templates" to "authenticated";

grant MAINTAIN on table "public"."checklist_templates" to "authenticated";

grant INSERT on table "public"."checklist_templates" to "service_role";

grant SELECT on table "public"."checklist_templates" to "service_role";

grant UPDATE on table "public"."checklist_templates" to "service_role";

grant DELETE on table "public"."checklist_templates" to "service_role";

grant TRUNCATE on table "public"."checklist_templates" to "service_role";

grant REFERENCES on table "public"."checklist_templates" to "service_role";

grant TRIGGER on table "public"."checklist_templates" to "service_role";

grant MAINTAIN on table "public"."checklist_templates" to "service_role";

grant INSERT on table "public"."checklist_checks" to "anon";

grant SELECT on table "public"."checklist_checks" to "anon";

grant UPDATE on table "public"."checklist_checks" to "anon";

grant DELETE on table "public"."checklist_checks" to "anon";

grant TRUNCATE on table "public"."checklist_checks" to "anon";

grant REFERENCES on table "public"."checklist_checks" to "anon";

grant TRIGGER on table "public"."checklist_checks" to "anon";

grant MAINTAIN on table "public"."checklist_checks" to "anon";

grant INSERT on table "public"."checklist_checks" to "authenticated";

grant SELECT on table "public"."checklist_checks" to "authenticated";

grant UPDATE on table "public"."checklist_checks" to "authenticated";

grant DELETE on table "public"."checklist_checks" to "authenticated";

grant TRUNCATE on table "public"."checklist_checks" to "authenticated";

grant REFERENCES on table "public"."checklist_checks" to "authenticated";

grant TRIGGER on table "public"."checklist_checks" to "authenticated";

grant MAINTAIN on table "public"."checklist_checks" to "authenticated";

grant INSERT on table "public"."checklist_checks" to "service_role";

grant SELECT on table "public"."checklist_checks" to "service_role";

grant UPDATE on table "public"."checklist_checks" to "service_role";

grant DELETE on table "public"."checklist_checks" to "service_role";

grant TRUNCATE on table "public"."checklist_checks" to "service_role";

grant REFERENCES on table "public"."checklist_checks" to "service_role";

grant TRIGGER on table "public"."checklist_checks" to "service_role";

grant MAINTAIN on table "public"."checklist_checks" to "service_role";

grant INSERT on table "public"."checklist_log" to "anon";

grant SELECT on table "public"."checklist_log" to "anon";

grant UPDATE on table "public"."checklist_log" to "anon";

grant DELETE on table "public"."checklist_log" to "anon";

grant TRUNCATE on table "public"."checklist_log" to "anon";

grant REFERENCES on table "public"."checklist_log" to "anon";

grant TRIGGER on table "public"."checklist_log" to "anon";

grant MAINTAIN on table "public"."checklist_log" to "anon";

grant INSERT on table "public"."checklist_log" to "authenticated";

grant SELECT on table "public"."checklist_log" to "authenticated";

grant UPDATE on table "public"."checklist_log" to "authenticated";

grant DELETE on table "public"."checklist_log" to "authenticated";

grant TRUNCATE on table "public"."checklist_log" to "authenticated";

grant REFERENCES on table "public"."checklist_log" to "authenticated";

grant TRIGGER on table "public"."checklist_log" to "authenticated";

grant MAINTAIN on table "public"."checklist_log" to "authenticated";

grant INSERT on table "public"."checklist_log" to "service_role";

grant SELECT on table "public"."checklist_log" to "service_role";

grant UPDATE on table "public"."checklist_log" to "service_role";

grant DELETE on table "public"."checklist_log" to "service_role";

grant TRUNCATE on table "public"."checklist_log" to "service_role";

grant REFERENCES on table "public"."checklist_log" to "service_role";

grant TRIGGER on table "public"."checklist_log" to "service_role";

grant MAINTAIN on table "public"."checklist_log" to "service_role";

grant INSERT on table "public"."shifts" to "anon";

grant SELECT on table "public"."shifts" to "anon";

grant UPDATE on table "public"."shifts" to "anon";

grant DELETE on table "public"."shifts" to "anon";

grant TRUNCATE on table "public"."shifts" to "anon";

grant REFERENCES on table "public"."shifts" to "anon";

grant TRIGGER on table "public"."shifts" to "anon";

grant MAINTAIN on table "public"."shifts" to "anon";

grant INSERT on table "public"."shifts" to "authenticated";

grant SELECT on table "public"."shifts" to "authenticated";

grant UPDATE on table "public"."shifts" to "authenticated";

grant DELETE on table "public"."shifts" to "authenticated";

grant TRUNCATE on table "public"."shifts" to "authenticated";

grant REFERENCES on table "public"."shifts" to "authenticated";

grant TRIGGER on table "public"."shifts" to "authenticated";

grant MAINTAIN on table "public"."shifts" to "authenticated";

grant INSERT on table "public"."shifts" to "service_role";

grant SELECT on table "public"."shifts" to "service_role";

grant UPDATE on table "public"."shifts" to "service_role";

grant DELETE on table "public"."shifts" to "service_role";

grant TRUNCATE on table "public"."shifts" to "service_role";

grant REFERENCES on table "public"."shifts" to "service_role";

grant TRIGGER on table "public"."shifts" to "service_role";

grant MAINTAIN on table "public"."shifts" to "service_role";

grant INSERT on table "public"."fixed_schedules" to "anon";

grant SELECT on table "public"."fixed_schedules" to "anon";

grant UPDATE on table "public"."fixed_schedules" to "anon";

grant DELETE on table "public"."fixed_schedules" to "anon";

grant TRUNCATE on table "public"."fixed_schedules" to "anon";

grant REFERENCES on table "public"."fixed_schedules" to "anon";

grant TRIGGER on table "public"."fixed_schedules" to "anon";

grant MAINTAIN on table "public"."fixed_schedules" to "anon";

grant INSERT on table "public"."fixed_schedules" to "authenticated";

grant SELECT on table "public"."fixed_schedules" to "authenticated";

grant UPDATE on table "public"."fixed_schedules" to "authenticated";

grant DELETE on table "public"."fixed_schedules" to "authenticated";

grant TRUNCATE on table "public"."fixed_schedules" to "authenticated";

grant REFERENCES on table "public"."fixed_schedules" to "authenticated";

grant TRIGGER on table "public"."fixed_schedules" to "authenticated";

grant MAINTAIN on table "public"."fixed_schedules" to "authenticated";

grant INSERT on table "public"."fixed_schedules" to "service_role";

grant SELECT on table "public"."fixed_schedules" to "service_role";

grant UPDATE on table "public"."fixed_schedules" to "service_role";

grant DELETE on table "public"."fixed_schedules" to "service_role";

grant TRUNCATE on table "public"."fixed_schedules" to "service_role";

grant REFERENCES on table "public"."fixed_schedules" to "service_role";

grant TRIGGER on table "public"."fixed_schedules" to "service_role";

grant MAINTAIN on table "public"."fixed_schedules" to "service_role";

grant INSERT on table "public"."sales_report_photos" to "anon";

grant SELECT on table "public"."sales_report_photos" to "anon";

grant UPDATE on table "public"."sales_report_photos" to "anon";

grant DELETE on table "public"."sales_report_photos" to "anon";

grant TRUNCATE on table "public"."sales_report_photos" to "anon";

grant REFERENCES on table "public"."sales_report_photos" to "anon";

grant TRIGGER on table "public"."sales_report_photos" to "anon";

grant MAINTAIN on table "public"."sales_report_photos" to "anon";

grant INSERT on table "public"."sales_report_photos" to "authenticated";

grant SELECT on table "public"."sales_report_photos" to "authenticated";

grant UPDATE on table "public"."sales_report_photos" to "authenticated";

grant DELETE on table "public"."sales_report_photos" to "authenticated";

grant TRUNCATE on table "public"."sales_report_photos" to "authenticated";

grant REFERENCES on table "public"."sales_report_photos" to "authenticated";

grant TRIGGER on table "public"."sales_report_photos" to "authenticated";

grant MAINTAIN on table "public"."sales_report_photos" to "authenticated";

grant INSERT on table "public"."sales_report_photos" to "service_role";

grant SELECT on table "public"."sales_report_photos" to "service_role";

grant UPDATE on table "public"."sales_report_photos" to "service_role";

grant DELETE on table "public"."sales_report_photos" to "service_role";

grant TRUNCATE on table "public"."sales_report_photos" to "service_role";

grant REFERENCES on table "public"."sales_report_photos" to "service_role";

grant TRIGGER on table "public"."sales_report_photos" to "service_role";

grant MAINTAIN on table "public"."sales_report_photos" to "service_role";

grant INSERT on table "public"."announcements" to "anon";

grant SELECT on table "public"."announcements" to "anon";

grant UPDATE on table "public"."announcements" to "anon";

grant DELETE on table "public"."announcements" to "anon";

grant TRUNCATE on table "public"."announcements" to "anon";

grant REFERENCES on table "public"."announcements" to "anon";

grant TRIGGER on table "public"."announcements" to "anon";

grant MAINTAIN on table "public"."announcements" to "anon";

grant INSERT on table "public"."announcements" to "authenticated";

grant SELECT on table "public"."announcements" to "authenticated";

grant UPDATE on table "public"."announcements" to "authenticated";

grant DELETE on table "public"."announcements" to "authenticated";

grant TRUNCATE on table "public"."announcements" to "authenticated";

grant REFERENCES on table "public"."announcements" to "authenticated";

grant TRIGGER on table "public"."announcements" to "authenticated";

grant MAINTAIN on table "public"."announcements" to "authenticated";

grant INSERT on table "public"."announcements" to "service_role";

grant SELECT on table "public"."announcements" to "service_role";

grant UPDATE on table "public"."announcements" to "service_role";

grant DELETE on table "public"."announcements" to "service_role";

grant TRUNCATE on table "public"."announcements" to "service_role";

grant REFERENCES on table "public"."announcements" to "service_role";

grant TRIGGER on table "public"."announcements" to "service_role";

grant MAINTAIN on table "public"."announcements" to "service_role";

grant INSERT on table "public"."announcement_reads" to "anon";

grant SELECT on table "public"."announcement_reads" to "anon";

grant UPDATE on table "public"."announcement_reads" to "anon";

grant DELETE on table "public"."announcement_reads" to "anon";

grant TRUNCATE on table "public"."announcement_reads" to "anon";

grant REFERENCES on table "public"."announcement_reads" to "anon";

grant TRIGGER on table "public"."announcement_reads" to "anon";

grant MAINTAIN on table "public"."announcement_reads" to "anon";

grant INSERT on table "public"."announcement_reads" to "authenticated";

grant SELECT on table "public"."announcement_reads" to "authenticated";

grant UPDATE on table "public"."announcement_reads" to "authenticated";

grant DELETE on table "public"."announcement_reads" to "authenticated";

grant TRUNCATE on table "public"."announcement_reads" to "authenticated";

grant REFERENCES on table "public"."announcement_reads" to "authenticated";

grant TRIGGER on table "public"."announcement_reads" to "authenticated";

grant MAINTAIN on table "public"."announcement_reads" to "authenticated";

grant INSERT on table "public"."announcement_reads" to "service_role";

grant SELECT on table "public"."announcement_reads" to "service_role";

grant UPDATE on table "public"."announcement_reads" to "service_role";

grant DELETE on table "public"."announcement_reads" to "service_role";

grant TRUNCATE on table "public"."announcement_reads" to "service_role";

grant REFERENCES on table "public"."announcement_reads" to "service_role";

grant TRIGGER on table "public"."announcement_reads" to "service_role";

grant MAINTAIN on table "public"."announcement_reads" to "service_role";

grant INSERT on table "public"."vendors" to "anon";

grant SELECT on table "public"."vendors" to "anon";

grant UPDATE on table "public"."vendors" to "anon";

grant DELETE on table "public"."vendors" to "anon";

grant TRUNCATE on table "public"."vendors" to "anon";

grant REFERENCES on table "public"."vendors" to "anon";

grant TRIGGER on table "public"."vendors" to "anon";

grant MAINTAIN on table "public"."vendors" to "anon";

grant INSERT on table "public"."vendors" to "authenticated";

grant SELECT on table "public"."vendors" to "authenticated";

grant UPDATE on table "public"."vendors" to "authenticated";

grant DELETE on table "public"."vendors" to "authenticated";

grant TRUNCATE on table "public"."vendors" to "authenticated";

grant REFERENCES on table "public"."vendors" to "authenticated";

grant TRIGGER on table "public"."vendors" to "authenticated";

grant MAINTAIN on table "public"."vendors" to "authenticated";

grant INSERT on table "public"."vendors" to "service_role";

grant SELECT on table "public"."vendors" to "service_role";

grant UPDATE on table "public"."vendors" to "service_role";

grant DELETE on table "public"."vendors" to "service_role";

grant TRUNCATE on table "public"."vendors" to "service_role";

grant REFERENCES on table "public"."vendors" to "service_role";

grant TRIGGER on table "public"."vendors" to "service_role";

grant MAINTAIN on table "public"."vendors" to "service_role";

grant INSERT on table "public"."attendance" to "anon";

grant SELECT on table "public"."attendance" to "anon";

grant UPDATE on table "public"."attendance" to "anon";

grant DELETE on table "public"."attendance" to "anon";

grant TRUNCATE on table "public"."attendance" to "anon";

grant REFERENCES on table "public"."attendance" to "anon";

grant TRIGGER on table "public"."attendance" to "anon";

grant MAINTAIN on table "public"."attendance" to "anon";

grant INSERT on table "public"."attendance" to "authenticated";

grant SELECT on table "public"."attendance" to "authenticated";

grant UPDATE on table "public"."attendance" to "authenticated";

grant DELETE on table "public"."attendance" to "authenticated";

grant TRUNCATE on table "public"."attendance" to "authenticated";

grant REFERENCES on table "public"."attendance" to "authenticated";

grant TRIGGER on table "public"."attendance" to "authenticated";

grant MAINTAIN on table "public"."attendance" to "authenticated";

grant INSERT on table "public"."attendance" to "service_role";

grant SELECT on table "public"."attendance" to "service_role";

grant UPDATE on table "public"."attendance" to "service_role";

grant DELETE on table "public"."attendance" to "service_role";

grant TRUNCATE on table "public"."attendance" to "service_role";

grant REFERENCES on table "public"."attendance" to "service_role";

grant TRIGGER on table "public"."attendance" to "service_role";

grant MAINTAIN on table "public"."attendance" to "service_role";

grant INSERT on table "public"."owner_requests" to "anon";

grant SELECT on table "public"."owner_requests" to "anon";

grant UPDATE on table "public"."owner_requests" to "anon";

grant DELETE on table "public"."owner_requests" to "anon";

grant TRUNCATE on table "public"."owner_requests" to "anon";

grant REFERENCES on table "public"."owner_requests" to "anon";

grant TRIGGER on table "public"."owner_requests" to "anon";

grant MAINTAIN on table "public"."owner_requests" to "anon";

grant INSERT on table "public"."owner_requests" to "authenticated";

grant SELECT on table "public"."owner_requests" to "authenticated";

grant UPDATE on table "public"."owner_requests" to "authenticated";

grant DELETE on table "public"."owner_requests" to "authenticated";

grant TRUNCATE on table "public"."owner_requests" to "authenticated";

grant REFERENCES on table "public"."owner_requests" to "authenticated";

grant TRIGGER on table "public"."owner_requests" to "authenticated";

grant MAINTAIN on table "public"."owner_requests" to "authenticated";

grant INSERT on table "public"."owner_requests" to "service_role";

grant SELECT on table "public"."owner_requests" to "service_role";

grant UPDATE on table "public"."owner_requests" to "service_role";

grant DELETE on table "public"."owner_requests" to "service_role";

grant TRUNCATE on table "public"."owner_requests" to "service_role";

grant REFERENCES on table "public"."owner_requests" to "service_role";

grant TRIGGER on table "public"."owner_requests" to "service_role";

grant MAINTAIN on table "public"."owner_requests" to "service_role";

grant INSERT on table "public"."sales_reports" to "anon";

grant SELECT on table "public"."sales_reports" to "anon";

grant UPDATE on table "public"."sales_reports" to "anon";

grant DELETE on table "public"."sales_reports" to "anon";

grant MAINTAIN on table "public"."sales_reports" to "anon";

grant INSERT on table "public"."sales_reports" to "authenticated";

grant SELECT on table "public"."sales_reports" to "authenticated";

grant UPDATE on table "public"."sales_reports" to "authenticated";

grant DELETE on table "public"."sales_reports" to "authenticated";

grant MAINTAIN on table "public"."sales_reports" to "authenticated";

grant INSERT on table "public"."sales_reports" to "service_role";

grant SELECT on table "public"."sales_reports" to "service_role";

grant UPDATE on table "public"."sales_reports" to "service_role";

grant DELETE on table "public"."sales_reports" to "service_role";

grant TRUNCATE on table "public"."sales_reports" to "service_role";

grant REFERENCES on table "public"."sales_reports" to "service_role";

grant TRIGGER on table "public"."sales_reports" to "service_role";

grant MAINTAIN on table "public"."sales_reports" to "service_role";

grant INSERT on table "public"."expense_entries" to "anon";

grant SELECT on table "public"."expense_entries" to "anon";

grant UPDATE on table "public"."expense_entries" to "anon";

grant DELETE on table "public"."expense_entries" to "anon";

grant MAINTAIN on table "public"."expense_entries" to "anon";

grant INSERT on table "public"."expense_entries" to "authenticated";

grant SELECT on table "public"."expense_entries" to "authenticated";

grant UPDATE on table "public"."expense_entries" to "authenticated";

grant DELETE on table "public"."expense_entries" to "authenticated";

grant MAINTAIN on table "public"."expense_entries" to "authenticated";

grant INSERT on table "public"."expense_entries" to "service_role";

grant SELECT on table "public"."expense_entries" to "service_role";

grant UPDATE on table "public"."expense_entries" to "service_role";

grant DELETE on table "public"."expense_entries" to "service_role";

grant TRUNCATE on table "public"."expense_entries" to "service_role";

grant REFERENCES on table "public"."expense_entries" to "service_role";

grant TRIGGER on table "public"."expense_entries" to "service_role";

grant MAINTAIN on table "public"."expense_entries" to "service_role";

grant INSERT on table "public"."crew" to "anon";

grant SELECT on table "public"."crew" to "anon";

grant UPDATE on table "public"."crew" to "anon";

grant DELETE on table "public"."crew" to "anon";

grant TRUNCATE on table "public"."crew" to "anon";

grant REFERENCES on table "public"."crew" to "anon";

grant TRIGGER on table "public"."crew" to "anon";

grant MAINTAIN on table "public"."crew" to "anon";

grant INSERT on table "public"."crew" to "authenticated";

grant SELECT on table "public"."crew" to "authenticated";

grant UPDATE on table "public"."crew" to "authenticated";

grant DELETE on table "public"."crew" to "authenticated";

grant TRUNCATE on table "public"."crew" to "authenticated";

grant REFERENCES on table "public"."crew" to "authenticated";

grant TRIGGER on table "public"."crew" to "authenticated";

grant MAINTAIN on table "public"."crew" to "authenticated";

grant INSERT on table "public"."crew" to "service_role";

grant SELECT on table "public"."crew" to "service_role";

grant UPDATE on table "public"."crew" to "service_role";

grant DELETE on table "public"."crew" to "service_role";

grant TRUNCATE on table "public"."crew" to "service_role";

grant REFERENCES on table "public"."crew" to "service_role";

grant TRIGGER on table "public"."crew" to "service_role";

grant MAINTAIN on table "public"."crew" to "service_role";

grant INSERT on table "public"."fixed_expenses" to "anon";

grant SELECT on table "public"."fixed_expenses" to "anon";

grant UPDATE on table "public"."fixed_expenses" to "anon";

grant DELETE on table "public"."fixed_expenses" to "anon";

grant TRUNCATE on table "public"."fixed_expenses" to "anon";

grant REFERENCES on table "public"."fixed_expenses" to "anon";

grant TRIGGER on table "public"."fixed_expenses" to "anon";

grant MAINTAIN on table "public"."fixed_expenses" to "anon";

grant INSERT on table "public"."fixed_expenses" to "authenticated";

grant SELECT on table "public"."fixed_expenses" to "authenticated";

grant UPDATE on table "public"."fixed_expenses" to "authenticated";

grant DELETE on table "public"."fixed_expenses" to "authenticated";

grant TRUNCATE on table "public"."fixed_expenses" to "authenticated";

grant REFERENCES on table "public"."fixed_expenses" to "authenticated";

grant TRIGGER on table "public"."fixed_expenses" to "authenticated";

grant MAINTAIN on table "public"."fixed_expenses" to "authenticated";

grant INSERT on table "public"."fixed_expenses" to "service_role";

grant SELECT on table "public"."fixed_expenses" to "service_role";

grant UPDATE on table "public"."fixed_expenses" to "service_role";

grant DELETE on table "public"."fixed_expenses" to "service_role";

grant TRUNCATE on table "public"."fixed_expenses" to "service_role";

grant REFERENCES on table "public"."fixed_expenses" to "service_role";

grant TRIGGER on table "public"."fixed_expenses" to "service_role";

grant MAINTAIN on table "public"."fixed_expenses" to "service_role";

grant SELECT on sequence "public"."push_subscriptions_id_seq" to "anon";

grant UPDATE on sequence "public"."push_subscriptions_id_seq" to "anon";

grant USAGE on sequence "public"."push_subscriptions_id_seq" to "anon";

grant SELECT on sequence "public"."push_subscriptions_id_seq" to "authenticated";

grant UPDATE on sequence "public"."push_subscriptions_id_seq" to "authenticated";

grant USAGE on sequence "public"."push_subscriptions_id_seq" to "authenticated";

grant SELECT on sequence "public"."push_subscriptions_id_seq" to "service_role";

grant UPDATE on sequence "public"."push_subscriptions_id_seq" to "service_role";

grant USAGE on sequence "public"."push_subscriptions_id_seq" to "service_role";

grant INSERT on table "public"."auth_rate_limits" to "service_role";

grant SELECT on table "public"."auth_rate_limits" to "service_role";

grant UPDATE on table "public"."auth_rate_limits" to "service_role";

grant DELETE on table "public"."auth_rate_limits" to "service_role";

grant TRUNCATE on table "public"."auth_rate_limits" to "service_role";

grant REFERENCES on table "public"."auth_rate_limits" to "service_role";

grant TRIGGER on table "public"."auth_rate_limits" to "service_role";

grant MAINTAIN on table "public"."auth_rate_limits" to "service_role";

grant SELECT on sequence "public"."reservations_id_seq" to "anon";

grant UPDATE on sequence "public"."reservations_id_seq" to "anon";

grant USAGE on sequence "public"."reservations_id_seq" to "anon";

grant SELECT on sequence "public"."reservations_id_seq" to "authenticated";

grant UPDATE on sequence "public"."reservations_id_seq" to "authenticated";

grant USAGE on sequence "public"."reservations_id_seq" to "authenticated";

grant SELECT on sequence "public"."reservations_id_seq" to "service_role";

grant UPDATE on sequence "public"."reservations_id_seq" to "service_role";

grant USAGE on sequence "public"."reservations_id_seq" to "service_role";

grant INSERT on table "public"."reservations" to "anon";

grant SELECT on table "public"."reservations" to "anon";

grant UPDATE on table "public"."reservations" to "anon";

grant DELETE on table "public"."reservations" to "anon";

grant TRUNCATE on table "public"."reservations" to "anon";

grant REFERENCES on table "public"."reservations" to "anon";

grant TRIGGER on table "public"."reservations" to "anon";

grant MAINTAIN on table "public"."reservations" to "anon";

grant INSERT on table "public"."reservations" to "authenticated";

grant SELECT on table "public"."reservations" to "authenticated";

grant UPDATE on table "public"."reservations" to "authenticated";

grant DELETE on table "public"."reservations" to "authenticated";

grant TRUNCATE on table "public"."reservations" to "authenticated";

grant REFERENCES on table "public"."reservations" to "authenticated";

grant TRIGGER on table "public"."reservations" to "authenticated";

grant MAINTAIN on table "public"."reservations" to "authenticated";

grant INSERT on table "public"."reservations" to "service_role";

grant SELECT on table "public"."reservations" to "service_role";

grant UPDATE on table "public"."reservations" to "service_role";

grant DELETE on table "public"."reservations" to "service_role";

grant TRUNCATE on table "public"."reservations" to "service_role";

grant REFERENCES on table "public"."reservations" to "service_role";

grant TRIGGER on table "public"."reservations" to "service_role";

grant MAINTAIN on table "public"."reservations" to "service_role";

grant INSERT on table "public"."push_subscriptions" to "anon";

grant SELECT on table "public"."push_subscriptions" to "anon";

grant UPDATE on table "public"."push_subscriptions" to "anon";

grant DELETE on table "public"."push_subscriptions" to "anon";

grant TRUNCATE on table "public"."push_subscriptions" to "anon";

grant REFERENCES on table "public"."push_subscriptions" to "anon";

grant TRIGGER on table "public"."push_subscriptions" to "anon";

grant MAINTAIN on table "public"."push_subscriptions" to "anon";

grant INSERT on table "public"."push_subscriptions" to "authenticated";

grant SELECT on table "public"."push_subscriptions" to "authenticated";

grant UPDATE on table "public"."push_subscriptions" to "authenticated";

grant DELETE on table "public"."push_subscriptions" to "authenticated";

grant TRUNCATE on table "public"."push_subscriptions" to "authenticated";

grant REFERENCES on table "public"."push_subscriptions" to "authenticated";

grant TRIGGER on table "public"."push_subscriptions" to "authenticated";

grant MAINTAIN on table "public"."push_subscriptions" to "authenticated";

grant INSERT on table "public"."push_subscriptions" to "service_role";

grant SELECT on table "public"."push_subscriptions" to "service_role";

grant UPDATE on table "public"."push_subscriptions" to "service_role";

grant DELETE on table "public"."push_subscriptions" to "service_role";

grant TRUNCATE on table "public"."push_subscriptions" to "service_role";

grant REFERENCES on table "public"."push_subscriptions" to "service_role";

grant TRIGGER on table "public"."push_subscriptions" to "service_role";

grant MAINTAIN on table "public"."push_subscriptions" to "service_role";

grant EXECUTE on function "private"."is_platform_admin"() to "authenticated";

grant EXECUTE on function "public"."prevent_store_hard_delete"() to "service_role";

grant EXECUTE on function "private"."has_store_membership"(target_store_id uuid, allowed_roles text[]) to "authenticated";

grant EXECUTE on function "private"."has_franchise_membership"(target_franchise_id uuid, allowed_roles text[]) to "authenticated";

grant EXECUTE on function "private"."current_crew_id"(target_store_id uuid) to "authenticated";

grant EXECUTE on function "private"."can_view_store"(target_store_id uuid) to "authenticated";

grant EXECUTE on function "private"."can_manage_store"(target_store_id uuid) to "authenticated";

grant EXECUTE on function "private"."is_store_owner"(target_store_id uuid) to "authenticated";

grant EXECUTE on function "private"."distance_meters"(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision) to "authenticated";

grant EXECUTE on function "private"."has_platform_role"(allowed_roles text[]) to "authenticated";

grant EXECUTE on function "private"."has_sales_access"(target_store_id uuid) to "authenticated";

grant EXECUTE on function "private"."can_view_financials"(target_store_id uuid) to "authenticated";

grant EXECUTE on function "private"."can_write_financials"(target_store_id uuid) to "authenticated";

grant EXECUTE on function "private"."can_delete_financials"(target_store_id uuid) to "authenticated";

grant EXECUTE on function "public"."get_store_crew_directory"(target_store_id uuid) to "authenticated";

grant EXECUTE on function "public"."get_store_crew_directory"(target_store_id uuid) to "service_role";

grant EXECUTE on function "public"."get_franchise_store_overview"(target_franchise_id uuid, target_month date) to "authenticated";

grant EXECUTE on function "public"."get_franchise_store_overview"(target_franchise_id uuid, target_month date) to "service_role";

grant EXECUTE on function "public"."clock_in"(target_store_id uuid, current_lat double precision, current_lng double precision) to "authenticated";

grant EXECUTE on function "public"."clock_in"(target_store_id uuid, current_lat double precision, current_lng double precision) to "service_role";

grant EXECUTE on function "public"."clock_out"(target_attendance_id uuid, current_lat double precision, current_lng double precision) to "authenticated";

grant EXECUTE on function "public"."clock_out"(target_attendance_id uuid, current_lat double precision, current_lng double precision) to "service_role";

grant EXECUTE on function "public"."confirm_my_attendance"(target_attendance_id uuid) to "authenticated";

grant EXECUTE on function "public"."confirm_my_attendance"(target_attendance_id uuid) to "service_role";

grant EXECUTE on function "public"."request_attendance_edit"(target_attendance_id uuid, new_check_in time without time zone, new_check_out time without time zone, request_reason text) to "authenticated";

grant EXECUTE on function "public"."request_attendance_edit"(target_attendance_id uuid, new_check_in time without time zone, new_check_out time without time zone, request_reason text) to "service_role";

grant EXECUTE on function "public"."approve_attendance_edit_request"(target_request_id uuid, note text) to "authenticated";

grant EXECUTE on function "public"."approve_attendance_edit_request"(target_request_id uuid, note text) to "service_role";

grant EXECUTE on function "public"."reject_attendance_edit_request"(target_request_id uuid, note text) to "authenticated";

grant EXECUTE on function "public"."reject_attendance_edit_request"(target_request_id uuid, note text) to "service_role";

grant EXECUTE on function "public"."cancel_my_attendance_edit_request"(target_request_id uuid) to "authenticated";

grant EXECUTE on function "public"."cancel_my_attendance_edit_request"(target_request_id uuid) to "service_role";

grant EXECUTE on function "public"."consume_auth_rate_limit"(p_action text, p_key_hash text, p_window_seconds integer, p_max_attempts integer) to "service_role";

grant EXECUTE on function "private"."protect_owner_request_auth_metadata"() to PUBLIC;

grant EXECUTE on function "public"."is_manee_username_reserved"(p_username text) to "service_role";

grant EXECUTE on function "public"."bootstrap_legacy_owner_account"(p_user_id uuid, p_username text) to "service_role";

grant EXECUTE on function "public"."bootstrap_owner_account"(p_user_id uuid, p_username text, p_display_name text, p_store_name text) to "service_role";

revoke all on schema "public" from PUBLIC, anon, authenticated, service_role;

revoke all on schema "private" from PUBLIC, anon, authenticated, service_role;

grant USAGE on schema "public" to PUBLIC;

grant USAGE on schema "public" to "anon";

grant USAGE on schema "public" to "authenticated";

grant USAGE on schema "public" to "service_role";

grant USAGE on schema "private" to "authenticated";

commit;
