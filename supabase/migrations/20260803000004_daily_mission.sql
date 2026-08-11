-- Daily mission: watch a (simulated) rewarded ad once per calendar day for
-- free coins. One row per user per day — the primary key itself is what
-- prevents double-claiming, same spirit as unlock_episode_with_coins()'s
-- idempotency in 20260802000004_functions.sql.
create table public.daily_mission_claims (
  user_id uuid not null references auth.users (id) on delete cascade,
  claim_date date not null default current_date,
  coins_awarded integer not null,
  created_at timestamptz not null default now(),
  primary key (user_id, claim_date)
);

alter table public.daily_mission_claims enable row level security;

create policy "users can manage their own daily mission claims"
  on public.daily_mission_claims for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Returns the number of coins awarded, or 0 if today's mission was already
-- claimed. SECURITY INVOKER — relies on the RLS policies above (own row)
-- and on wallets/transactions' existing owner policies for its writes.
create or replace function public.claim_daily_mission()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_reward integer := 20;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  if exists (
    select 1 from public.daily_mission_claims
    where user_id = v_user_id and claim_date = current_date
  ) then
    return 0;
  end if;

  insert into public.daily_mission_claims (user_id, claim_date, coins_awarded)
  values (v_user_id, current_date, v_reward);

  update public.wallets
  set balance = balance + v_reward, updated_at = now()
  where user_id = v_user_id;

  insert into public.transactions (user_id, type, label, amount)
  values (v_user_id, 'reward', 'Daily mission: watched a rewarded ad', v_reward);

  return v_reward;
end;
$$;
