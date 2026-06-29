-- =============================================================================
-- 003_row_level_security.sql — RLS policies (SPEC §9)
-- Helper fns are SECURITY DEFINER so they read profiles without triggering the
-- profiles policies (avoids infinite recursion).
--
-- NOTE (documented limitation to harden later): SPEC §9.1 restricts STAFF to
-- updating only items.location/quantity. RLS is row-level, not column-level, so
-- that column restriction is enforced in the app for now; tighten with column
-- GRANTs in a later migration if needed.
-- =============================================================================

create or replace function public.auth_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.auth_shop_id()
returns uuid language sql stable security definer set search_path = public as $$
  select shop_id from public.profiles where id = auth.uid()
$$;

grant execute on function public.auth_role()    to anon, authenticated;
grant execute on function public.auth_shop_id() to anon, authenticated;

alter table public.shops      enable row level security;
alter table public.profiles   enable row level security;
alter table public.suppliers  enable row level security;
alter table public.categories enable row level security;
alter table public.items      enable row level security;
alter table public.purchases  enable row level security;
alter table public.orders     enable row level security;
alter table public.sales      enable row level security;
alter table public.payments   enable row level security;
alter table public.fulfilment enable row level security;
alter table public.ledger     enable row level security;

-- ---------------------------------------------------------------------------
-- shops — readable by all (shopfront shows shop name); owner updates.
-- ---------------------------------------------------------------------------
create policy shops_select on public.shops for select using (true);
create policy shops_update on public.shops for update
  using (auth_role() = 'owner' and id = auth_shop_id());

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create policy profiles_owner_all on public.profiles for select
  using (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy profiles_self_select on public.profiles for select
  using (id = auth.uid());
create policy profiles_owner_insert on public.profiles for insert
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy profiles_owner_update on public.profiles for update
  using (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy profiles_self_update on public.profiles for update
  using (id = auth.uid());

-- ---------------------------------------------------------------------------
-- suppliers — owner manages; staff read; buyers none.
-- ---------------------------------------------------------------------------
create policy suppliers_owner_all on public.suppliers for all
  using (auth_role() = 'owner' and shop_id = auth_shop_id())
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy suppliers_staff_read on public.suppliers for select
  using (auth_role() = 'staff' and shop_id = auth_shop_id());

-- ---------------------------------------------------------------------------
-- categories — owner manages; logged-in users + public read active.
-- ---------------------------------------------------------------------------
create policy categories_owner_all on public.categories for all
  using (auth_role() = 'owner' and shop_id = auth_shop_id())
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy categories_read_active on public.categories for select
  using (is_active = true);

-- ---------------------------------------------------------------------------
-- items
-- ---------------------------------------------------------------------------
create policy items_owner_select on public.items for select
  using (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy items_staff_select on public.items for select
  using (auth_role() = 'staff' and shop_id = auth_shop_id() and is_active);
-- buyers + public shopfront: active, in stock
create policy items_public_select on public.items for select
  using (is_active = true and quantity > 0);
create policy items_staffowner_insert on public.items for insert
  with check (auth_role() in ('owner','staff') and shop_id = auth_shop_id());
create policy items_owner_update on public.items for update
  using (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy items_staff_update on public.items for update
  using (auth_role() = 'staff' and shop_id = auth_shop_id());  -- cols limited in app

-- ---------------------------------------------------------------------------
-- purchases — owner full; staff insert + read.
-- ---------------------------------------------------------------------------
create policy purchases_owner_all on public.purchases for all
  using (auth_role() = 'owner' and shop_id = auth_shop_id())
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy purchases_staff_select on public.purchases for select
  using (auth_role() = 'staff' and shop_id = auth_shop_id());
create policy purchases_staff_insert on public.purchases for insert
  with check (auth_role() = 'staff' and shop_id = auth_shop_id());

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create policy orders_owner_select on public.orders for select
  using (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy orders_owner_update on public.orders for update
  using (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy orders_staff_select on public.orders for select
  using (auth_role() = 'staff' and shop_id = auth_shop_id()
         and status in ('approved','packed'));
create policy orders_staff_update on public.orders for update
  using (auth_role() = 'staff' and shop_id = auth_shop_id());
create policy orders_buyer_select on public.orders for select
  using (buyer_id = auth.uid());
create policy orders_buyer_insert on public.orders for insert
  with check (buyer_id = auth.uid()
              and auth_role() in ('customer','dealer')
              and shop_id = auth_shop_id());

-- ---------------------------------------------------------------------------
-- sales — owner inserts on approval (trigger does side-effects); buyers read own.
-- ---------------------------------------------------------------------------
create policy sales_owner_select on public.sales for select
  using (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy sales_owner_insert on public.sales for insert
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy sales_buyer_select on public.sales for select
  using (buyer_id = auth.uid());

-- ---------------------------------------------------------------------------
-- payments — owner full; buyers read own.
-- ---------------------------------------------------------------------------
create policy payments_owner_select on public.payments for select
  using (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy payments_owner_insert on public.payments for insert
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy payments_buyer_select on public.payments for select
  using (party_id = auth.uid() and party_type in ('customer','dealer'));

-- ---------------------------------------------------------------------------
-- fulfilment — owner + staff read & update; staff packs.
-- ---------------------------------------------------------------------------
create policy fulfilment_owner_all on public.fulfilment for all
  using (auth_role() = 'owner' and shop_id = auth_shop_id())
  with check (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy fulfilment_staff_select on public.fulfilment for select
  using (auth_role() = 'staff' and shop_id = auth_shop_id());
create policy fulfilment_staff_update on public.fulfilment for update
  using (auth_role() = 'staff' and shop_id = auth_shop_id());

-- ---------------------------------------------------------------------------
-- ledger — append-only; written only by SECURITY DEFINER triggers.
-- No insert/update/delete policies => blocked for everyone. Read only.
-- ---------------------------------------------------------------------------
create policy ledger_owner_select on public.ledger for select
  using (auth_role() = 'owner' and shop_id = auth_shop_id());
create policy ledger_party_select on public.ledger for select
  using (party_id = auth.uid() and party_type in ('customer','dealer'));
