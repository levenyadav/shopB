-- =============================================================================
-- 001_create_tables.sql — Shop Management System schema (SPEC §7)
-- Single shop, multi-role. All money is numeric(14,2). UUID PKs.
-- =============================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- shops
-- ---------------------------------------------------------------------------
create table if not exists public.shops (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  address         text,
  phone           text,
  currency_symbol text not null default '₹',
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- profiles  (id mirrors auth.users.id; auto-created on signup via trigger)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  shop_id     uuid references public.shops(id),
  full_name   text not null default '',
  phone       text,
  role        text not null default 'customer'
              check (role in ('owner','staff','customer','dealer')),
  balance_due numeric(14,2) not null default 0,   -- udhaar for customers/dealers
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_profiles_shop on public.profiles(shop_id);

-- ---------------------------------------------------------------------------
-- suppliers
-- ---------------------------------------------------------------------------
create table if not exists public.suppliers (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id),
  name           text not null,
  contact_person text,
  phone          text,
  address        text,
  balance_due    numeric(14,2) not null default 0,  -- amount shop owes supplier
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_suppliers_shop on public.suppliers(shop_id);

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id),
  name       text not null,
  type       text check (type in ('finished_good','raw_material','resale')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_categories_shop on public.categories(shop_id);

-- ---------------------------------------------------------------------------
-- items  (master catalog — one row per product)
-- ---------------------------------------------------------------------------
create table if not exists public.items (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops(id),
  item_no             text not null,                      -- auto-generated SHOP-0001
  name                text not null,
  supplier_id         uuid not null references public.suppliers(id),
  category_id         uuid not null references public.categories(id),
  location            text,                               -- rack label, display only
  quantity            numeric(14,2) not null default 0,
  purchase_rate       numeric(14,2) not null,             -- cost price (internal)
  dealer_rate         numeric(14,2) not null,             -- wholesale
  rate                numeric(14,2) not null,             -- retail
  photo_url           text,
  barcode             text,
  low_stock_threshold numeric(14,2) not null default 10,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (shop_id, item_no)
);
create index if not exists idx_items_shop on public.items(shop_id);
create index if not exists idx_items_category on public.items(category_id);
create index if not exists idx_items_supplier on public.items(supplier_id);

-- ---------------------------------------------------------------------------
-- purchases  (every stock-in event)
-- ---------------------------------------------------------------------------
create table if not exists public.purchases (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id),
  item_id       uuid not null references public.items(id),
  supplier_id   uuid not null references public.suppliers(id),
  quantity      numeric(14,2) not null,
  purchase_rate numeric(14,2) not null,
  total_cost    numeric(14,2) not null,         -- quantity * purchase_rate
  entered_by    uuid not null references public.profiles(id),
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_purchases_shop on public.purchases(shop_id);
create index if not exists idx_purchases_item on public.purchases(item_id);
create index if not exists idx_purchases_supplier on public.purchases(supplier_id);

-- ---------------------------------------------------------------------------
-- orders  (shopfront orders, pending before approval)
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id),
  item_id          uuid not null references public.items(id),
  buyer_id         uuid not null references public.profiles(id),
  buyer_type       text not null check (buyer_type in ('customer','dealer')),
  quantity         numeric(14,2) not null,
  rate_at_order    numeric(14,2) not null,        -- locked Rate or Dealer Rate
  amount           numeric(14,2) not null,        -- quantity * rate_at_order
  notes            text,
  status           text not null default 'pending'
                   check (status in ('pending','approved','rejected',
                                     'packed','delivered','picked_up')),
  rejection_reason text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_orders_shop on public.orders(shop_id);
create index if not exists idx_orders_buyer on public.orders(buyer_id);
create index if not exists idx_orders_status on public.orders(status);

-- ---------------------------------------------------------------------------
-- sales  (created by trigger on order approval)
-- ---------------------------------------------------------------------------
create table if not exists public.sales (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id),
  order_id      uuid not null references public.orders(id),
  item_id       uuid not null references public.items(id),
  category_id   uuid not null references public.categories(id),
  buyer_id      uuid not null references public.profiles(id),
  buyer_type    text not null check (buyer_type in ('customer','dealer')),
  quantity      numeric(14,2) not null,
  rate_charged  numeric(14,2) not null,
  amount        numeric(14,2) not null,           -- quantity * rate_charged
  purchase_rate numeric(14,2) not null,           -- copied from item for profit
  profit        numeric(14,2) not null,           -- (rate_charged - purchase_rate) * qty
  payment_type  text not null check (payment_type in ('cash','upi','udhaar')),
  approved_by   uuid not null references public.profiles(id),
  created_at    timestamptz not null default now()
);
create index if not exists idx_sales_shop on public.sales(shop_id);
create index if not exists idx_sales_buyer on public.sales(buyer_id);
create index if not exists idx_sales_order on public.sales(order_id);

-- ---------------------------------------------------------------------------
-- payments  (money in/out, independent of sales & purchases)
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops(id),
  direction          text not null check (direction in ('in','out')),
  party_id           uuid not null,                 -- profiles.id or suppliers.id
  party_type         text not null check (party_type in ('customer','dealer','supplier')),
  amount             numeric(14,2) not null,
  method             text not null check (method in ('cash','upi','bank')),
  reference_no       text,
  linked_sale_id     uuid references public.sales(id),
  linked_purchase_id uuid references public.purchases(id),
  recorded_by        uuid not null references public.profiles(id),
  notes              text,
  created_at         timestamptz not null default now()
);
create index if not exists idx_payments_shop on public.payments(shop_id);
create index if not exists idx_payments_party on public.payments(party_id);

-- ---------------------------------------------------------------------------
-- fulfilment  (packing & delivery status per approved order)
-- ---------------------------------------------------------------------------
create table if not exists public.fulfilment (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id),
  order_id      uuid not null references public.orders(id),
  sale_id       uuid not null references public.sales(id),
  status        text not null default 'pending_pack'
                check (status in ('pending_pack','packed','delivered','picked_up')),
  packed_by     uuid references public.profiles(id),
  packed_at     timestamptz,
  completed_by  uuid references public.profiles(id),
  completed_at  timestamptz,
  delivery_note text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_fulfilment_shop on public.fulfilment(shop_id);
create index if not exists idx_fulfilment_order on public.fulfilment(order_id);
create index if not exists idx_fulfilment_status on public.fulfilment(status);

-- ---------------------------------------------------------------------------
-- ledger  (append-only; written ONLY by triggers — never manually)
-- ---------------------------------------------------------------------------
create table if not exists public.ledger (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id),
  entry_type      text not null check (entry_type in ('purchase','sale','payment_in','payment_out')),
  party_id        uuid not null,
  party_type      text not null check (party_type in ('customer','dealer','supplier')),
  reference_id    uuid not null,
  reference_table text not null check (reference_table in ('sales','purchases','payments')),
  debit           numeric(14,2) not null default 0,
  credit          numeric(14,2) not null default 0,
  running_balance numeric(14,2) not null,    -- party balance_due after this entry
  description     text not null,
  created_at      timestamptz not null default now()
);
create index if not exists idx_ledger_shop on public.ledger(shop_id);
create index if not exists idx_ledger_party on public.ledger(party_id, party_type);
