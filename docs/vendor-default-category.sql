-- Additive only: preserve all existing vendors, amounts and expense categories.
-- NULL = existing/unconfigured; per_entry = choose category for each purchase.
alter table public.vendors add column if not exists default_category text;
alter table public.vendors add constraint vendors_default_category_allowed
  check (default_category is null or default_category in ('food','beverage','supplies','other','per_entry'));
-- Existing authenticated grants and store-scoped RLS remain unchanged.
notify pgrst, 'reload schema';
