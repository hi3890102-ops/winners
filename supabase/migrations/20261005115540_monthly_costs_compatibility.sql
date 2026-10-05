-- Staging predates the existing expense memo field; production already has it.
alter table public.expense_entries add column if not exists memo text;
-- Electricity/water/gas already recur as monthly checks. Do not create a second variable prompt.
do $$declare definition text;begin
 definition:=pg_get_functiondef('private.manee_cost_review(uuid,text,text,jsonb)'::regprocedure);
 if position('if v_mode<>''none'' then' in definition)=0 then raise exception 'Cost source changed; review required';end if;
 definition:=replace(definition,'if v_mode<>''none'' then','if v_mode<>''none'' and not (v_mode=''variable'' and coalesce(key in (''electricity'',''water'',''gas''),false)) then');
 execute definition;
end $$;
notify pgrst,'reload schema';
