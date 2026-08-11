\set ON_ERROR_STOP on

do $$
begin
  if (select count(*) from public.learning_circles) <> 2 then
    raise exception 'Expected two backfilled learning circles';
  end if;

  if not exists (
    select 1 from public.learning_circles
    where id = '40000000-0000-0000-0000-000000000001'
      and circle_type = 'quran'
      and legacy_halaqa_id = id
  ) then
    raise exception 'Quran circle was not backfilled with its legacy UUID';
  end if;

  if not exists (
    select 1 from public.learning_circles
    where id = '40000000-0000-0000-0000-000000000002'
      and circle_type = 'educational'
      and legacy_classroom_id = id
  ) then
    raise exception 'Educational circle was not backfilled with its legacy UUID';
  end if;

  if (select count(*) from public.learning_circle_staff where staff_role = 'lead' and status = 'active') <> 2 then
    raise exception 'Expected a lead teacher for every backfilled circle';
  end if;

  if (select count(*) from public.learning_circle_memberships where status = 'active') <> 2 then
    raise exception 'Expected both legacy student memberships to be backfilled';
  end if;

  if (select count(*) from public.learning_circle_subjects) <> 1 then
    raise exception 'Expected the legacy classroom subject to be linked';
  end if;

  if (select count(*) from public.learning_circle_settings) <> 2 then
    raise exception 'Expected settings for every backfilled circle';
  end if;
end;
$$;

select 'legacy circle backfill passed' as result;
