-- The Spy Monster: cross-game archive.
-- Live games run in Terse actors (one per game). When a game ends, the game server writes one
-- row here, so questions across all games (leaderboard, stats) never wake thousands of actors.
-- Paste this whole file into Supabase > SQL Editor and press Run. Safe to run more than once.

create table if not exists public.games (
    session_id            text primary key,
    started_at            timestamptz not null,
    ended_at              timestamptz not null,
    outcome               text not null check (outcome in ('won', 'lost', 'expired')),
    spy                   text not null,
    accused               text,
    duration_seconds      integer not null,
    player_messages       integer not null default 0,
    whispers              integer not null default 0,
    spy_reports           integer not null default 0,
    fake_reports_blocked  integer not null default 0,
    clues_revealed        integer not null default 0,
    relay_mode            text not null default 'hosted',
    archived_at           timestamptz not null default now()
);

create index if not exists games_ended_at_idx on public.games (ended_at desc);
create index if not exists games_spy_idx on public.games (spy);

-- Only the game server (service role key) reads or writes. No public access.
-- Explicit grants: projects created without "Automatically expose new tables" grant nothing by default.
alter table public.games enable row level security;
grant select, insert, update on public.games to service_role;

-- Headline numbers, computed in Postgres so they stay cheap as games pile up.
create or replace view public.game_totals as
select
    count(*)::int                                                         as games,
    count(*) filter (where outcome = 'won')::int                          as players_escaped,
    round(100.0 * count(*) filter (where outcome = 'won') / nullif(count(*), 0))::int as escape_rate_pct,
    min(duration_seconds) filter (where outcome = 'won')::int             as fastest_catch_seconds,
    coalesce(sum(whispers), 0)::int                                       as total_whispers,
    coalesce(sum(fake_reports_blocked), 0)::int                           as total_fakes_blocked
from public.games;

-- Which monster gets away with it most often.
create or replace view public.monster_stats as
select
    spy                                                                   as monster,
    count(*)::int                                                         as times_spy,
    count(*) filter (where outcome <> 'won')::int                         as times_got_away,
    round(100.0 * count(*) filter (where outcome <> 'won') / nullif(count(*), 0))::int as got_away_pct
from public.games
group by spy;

-- Views run with the caller's rights, so RLS on games still applies to them.
alter view public.game_totals set (security_invoker = true);
alter view public.monster_stats set (security_invoker = true);
grant select on public.game_totals, public.monster_stats to service_role;
