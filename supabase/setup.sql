-- 在自己的 Supabase 项目 SQL Editor 执行。账号由 Supabase Auth 管理。
begin;
create table if not exists public.fw_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (length(key) between 1 and 256),
  data jsonb,
  modified_at timestamptz not null,
  deleted boolean not null default false,
  primary key (user_id, key)
);
alter table public.fw_records enable row level security;
alter table public.fw_records force row level security;
revoke all on public.fw_records from anon;
grant select, insert, update, delete on public.fw_records to authenticated;
drop policy if exists fw_owner on public.fw_records;
create policy fw_owner on public.fw_records to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 一次事务按记录合并并返回自己的数据；不接受客户端传来的 user_id。
create or replace function public.fw_merge_records(incoming jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  result jsonb;
begin
  if owner_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if incoming is null or jsonb_typeof(incoming) <> 'object' then
    raise exception 'Invalid records' using errcode = '22023';
  end if;
  if octet_length(incoming::text) > 5242880 then raise exception 'Payload too large'; end if;
  if exists (select 1 from jsonb_each(incoming) e where
      length(e.key) not between 1 and 256 or jsonb_typeof(e.value) <> 'object'
      or jsonb_typeof(e.value->'x') is distinct from 'boolean'
      or jsonb_typeof(e.value->'t') is distinct from 'string'
      or not (e.value ? 'd')) then raise exception 'Invalid record'; end if;

  -- 同一账号的并发请求串行合并，避免读写交错丢改动。
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text, 0));
  insert into public.fw_records as old (user_id, key, data, modified_at, deleted)
  select owner_id, e.key, e.value->'d',
    coalesce(nullif(e.value->>'t', '')::timestamptz, '1970-01-01 UTC'::timestamptz),
    (e.value->>'x')::boolean
  from jsonb_each(incoming) e
  on conflict (user_id, key) do update set
    data = excluded.data, modified_at = excluded.modified_at, deleted = excluded.deleted
  where excluded.modified_at > old.modified_at
     or (excluded.modified_at = old.modified_at and excluded.deleted and not old.deleted);

  select coalesce(jsonb_object_agg(key, jsonb_build_object(
    'd', data, 't', to_char(modified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'x', deleted)), '{}'::jsonb) into result
  from public.fw_records where user_id = owner_id;
  return jsonb_build_object('schema', 1, 'records', result);
end;
$$;
revoke all on function public.fw_merge_records(jsonb) from public, anon;
grant execute on function public.fw_merge_records(jsonb) to authenticated;
commit;
