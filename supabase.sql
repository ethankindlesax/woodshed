-- Woodshed sync tables. Paste into Supabase → SQL Editor → Run. Safe to run once on a new project.
-- Every row belongs to the signed-in user; row level security stops anyone seeing anyone else's rows.

create table if not exists public.habits (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  name       text not null,
  ord        int  not null default 0,
  retired    boolean not null default false,
  targets    jsonb not null default '[null,null,null,null,null,null,null]',
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.sessions (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  habit      text not null,
  date       date not null,
  minutes    int  not null,
  at         timestamptz,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.marks (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,          -- "YYYY-MM-DD|habitId"
  value      boolean,                -- null = no manual override
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- server sets updated_at on every write, so devices can ask "what changed since X"
create or replace function public.woodshed_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists touch on public.habits;
drop trigger if exists touch on public.sessions;
drop trigger if exists touch on public.marks;
create trigger touch before insert or update on public.habits   for each row execute function public.woodshed_touch();
create trigger touch before insert or update on public.sessions for each row execute function public.woodshed_touch();
create trigger touch before insert or update on public.marks    for each row execute function public.woodshed_touch();

create index if not exists habits_changed   on public.habits   (user_id, updated_at);
create index if not exists sessions_changed on public.sessions (user_id, updated_at);
create index if not exists marks_changed    on public.marks    (user_id, updated_at);

alter table public.habits   enable row level security;
alter table public.sessions enable row level security;
alter table public.marks    enable row level security;

drop policy if exists own on public.habits;
drop policy if exists own on public.sessions;
drop policy if exists own on public.marks;
create policy own on public.habits   for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own on public.sessions for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own on public.marks    for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.habits, public.sessions, public.marks from anon;
grant select, insert, update on public.habits, public.sessions, public.marks to authenticated;
