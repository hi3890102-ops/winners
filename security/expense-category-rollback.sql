-- Rollback for expense-category.sql. Non-destructive to every OTHER column (amount, date, description,
-- store_id): only removes the category column and its check constraint. Any category data entered by
-- owners/managers before rollback is lost - only run this if the feature must be fully reverted.

alter table public.expense_entries
  drop constraint if exists expense_entries_category_check;

alter table public.expense_entries
  drop column if exists category;
