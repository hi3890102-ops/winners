-- Adds an operating-cost category to expense_entries (식자재/주류·음료/소모품/기타).
-- Additive only: nullable column, no existing rows touched, no RLS policy change needed
-- (the existing expense_entries_update_v2 policy already covers all columns via private.can_manage_store).
--
-- NOT a tax/VAT classification - never use this column to decide taxable/exempt or
-- VAT-deductible status. It exists purely for operating-cost tracking (식자재비율 etc).
--
-- Backward compatible: old client code that doesn't send `category` keeps inserting/updating
-- rows with category = NULL (미분류), which is exactly today's behavior for every existing row.

alter table public.expense_entries
  add column if not exists category text null;

alter table public.expense_entries
  drop constraint if exists expense_entries_category_check;

alter table public.expense_entries
  add constraint expense_entries_category_check
  check (category is null or category in ('food','beverage','supplies','other'));

comment on column public.expense_entries.category is
  '식자재/주류·음료/소모품/기타 운영비 분류. NULL = 미분류 (기존 기록 보존, 거래처명으로 자동 분류하지 않음). 부가세/세금 분류가 아님 - VAT 계산에 사용 금지.';
