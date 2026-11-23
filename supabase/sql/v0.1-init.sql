-- Chord Book v0.1 schema for the shared House Index Supabase project.
-- Uses `cb_` table prefixes (`cb_songs`, `cb_setlists`, `cb_setlist_items`,
-- `cb_song_shares`, `cb_song_revisions`) so it coexists cleanly alongside
-- House Index (`recipes`, `bottles`, `inventory_items`, etc.) while sharing
-- `auth.users`, `profiles`, `ai_usage`, and `ai_calls`.
-- Safe to run multiple times (idempotent).

create extension if not exists pg_trgm with schema extensions;
create schema if not exists private;
grant usage on schema private to authenticated;

-- 1. Extend profiles with chord_prefs (without touching House Index columns)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);
alter table public.profiles
  add column if not exists chord_prefs jsonb not null default '{}'::jsonb;
alter table public.profiles enable row level security;

-- 2. Main songs table: cb_songs
create table if not exists public.cb_songs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  artist text,
  chordpro text not null,
  key text,
  capo int not null default 0 check (capo between 0 and 12),
  preferred_transpose int not null default 0 check (preferred_transpose between -11 and 11),
  tempo int check (tempo between 20 and 300),
  time_signature text,
  tuning text not null default 'E A D G B E',
  duration_sec int,
  tags text[] not null default '{}',
  source text,
  notes text,
  is_favorite boolean not null default false,
  vocal_rating int check (vocal_rating between 1 and 5),
  vocal_comfort text check (vocal_comfort in ('too_low', 'sweet_spot', 'high_stretch')),
  layout_prefs jsonb not null default '{"page_mode":"1-sheet","columns":"auto","compact_chorus":false,"show_diagrams":false,"font_offset":0,"accidental_pref":"auto","sidebar_notes":{}}'::jsonb,
  last_played_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cb_songs_user_title_idx on public.cb_songs (user_id, title);
create index if not exists cb_songs_title_trgm_idx on public.cb_songs using gin (title extensions.gin_trgm_ops);

create or replace function public.cb_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cb_songs_updated_at on public.cb_songs;
create trigger cb_songs_updated_at
  before update on public.cb_songs
  for each row execute function public.cb_set_updated_at();

-- 3. Set lists & set list items: cb_setlists, cb_setlist_items
create table if not exists public.cb_setlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  event_date date,
  notes text,
  offline boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.cb_setlist_items (
  id uuid primary key default gen_random_uuid(),
  setlist_id uuid not null references public.cb_setlists(id) on delete cascade,
  song_id uuid not null references public.cb_songs(id) on delete cascade,
  position int not null,
  transpose int not null default 0 check (transpose between -11 and 11),
  capo int check (capo between 0 and 12),
  notes text,
  unique (setlist_id, position)
);

create index if not exists cb_setlist_items_order_idx on public.cb_setlist_items (setlist_id, position);

-- 4. Song shares (bandmates) & revisions
create table if not exists public.cb_song_shares (
  song_id uuid not null references public.cb_songs(id) on delete cascade,
  shared_with_user_id uuid not null references auth.users(id) on delete cascade,
  shared_by_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (song_id, shared_with_user_id)
);

create table if not exists public.cb_song_revisions (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references public.cb_songs(id) on delete cascade,
  chordpro text not null,
  created_at timestamptz not null default now()
);

create index if not exists cb_song_revisions_song_idx on public.cb_song_revisions (song_id, created_at desc);

-- 5. Security-definer helpers in `private` schema to prevent RLS recursion
create or replace function private.cb_owns_song(p_song_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.cb_songs s
    where s.id = p_song_id and s.user_id = auth.uid()
  );
$$;

create or replace function private.cb_song_shared_with_me(p_song_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.cb_song_shares sh
    where sh.song_id = p_song_id and sh.shared_with_user_id = auth.uid()
  );
$$;

create or replace function private.cb_owns_setlist(p_setlist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.cb_setlists sl
    where sl.id = p_setlist_id and sl.user_id = auth.uid()
  );
$$;

-- 6. Row-Level Security Policies
alter table public.cb_songs enable row level security;
drop policy if exists "cb_songs_owner_all" on public.cb_songs;
create policy "cb_songs_owner_all" on public.cb_songs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "cb_songs_shared_select" on public.cb_songs;
create policy "cb_songs_shared_select" on public.cb_songs
  for select to authenticated
  using (private.cb_song_shared_with_me(id));

alter table public.cb_song_shares enable row level security;
drop policy if exists "cb_song_shares_owner_all" on public.cb_song_shares;
create policy "cb_song_shares_owner_all" on public.cb_song_shares
  for all to authenticated
  using (shared_by_user_id = auth.uid() or private.cb_owns_song(song_id))
  with check (shared_by_user_id = auth.uid() and private.cb_owns_song(song_id));

drop policy if exists "cb_song_shares_recipient_select" on public.cb_song_shares;
create policy "cb_song_shares_recipient_select" on public.cb_song_shares
  for select to authenticated
  using (shared_with_user_id = auth.uid());

alter table public.cb_setlists enable row level security;
drop policy if exists "cb_setlists_owner_all" on public.cb_setlists;
create policy "cb_setlists_owner_all" on public.cb_setlists
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.cb_setlist_items enable row level security;
drop policy if exists "cb_setlist_items_owner_all" on public.cb_setlist_items;
create policy "cb_setlist_items_owner_all" on public.cb_setlist_items
  for all to authenticated
  using (private.cb_owns_setlist(setlist_id))
  with check (private.cb_owns_setlist(setlist_id));

alter table public.cb_song_revisions enable row level security;
drop policy if exists "cb_song_revisions_owner_all" on public.cb_song_revisions;
create policy "cb_song_revisions_owner_all" on public.cb_song_revisions
  for all to authenticated
  using (private.cb_owns_song(song_id))
  with check (private.cb_owns_song(song_id));

-- 7. Bandmate people lookup (analogous to House Index my_people, plus union with cb_song_shares)
create or replace function public.cb_my_people()
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.display_name
  from public.profiles p
  where p.id = auth.uid()
     or p.id in (select s.shared_with_user_id from public.cb_song_shares s where s.shared_by_user_id = auth.uid())
     or p.id in (select s.shared_by_user_id from public.cb_song_shares s where s.shared_with_user_id = auth.uid());
$$;
revoke execute on function public.cb_my_people() from public, anon;
grant execute on function public.cb_my_people() to authenticated;

-- 8. Ensure AI usage & call logging exist (already in House Index v1.9, included idempotently)
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  kind text not null,
  count int not null default 0,
  primary key (user_id, usage_date, kind)
);
alter table public.ai_usage enable row level security;

create table if not exists public.ai_calls (
  user_id uuid not null references auth.users(id) on delete cascade,
  task text not null,
  model text not null,
  valid boolean not null,
  latency_ms int,
  escalated boolean not null default false,
  input_tokens int,
  output_tokens int,
  cache_read_tokens int,
  web_searches int,
  created_at timestamptz not null default now()
);
alter table public.ai_calls enable row level security;

notify pgrst, 'reload schema';
