-- Optional per-entry note; existing expense rows, amounts and RLS remain unchanged.
ALTER TABLE public.expense_entries ADD COLUMN IF NOT EXISTS memo text;
COMMENT ON COLUMN public.expense_entries.memo IS 'Optional note for a single expense entry';
