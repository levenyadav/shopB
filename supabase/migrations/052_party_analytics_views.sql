-- =============================================================================
-- 052_party_analytics_views.sql — the read layer behind Parties & Ledger.
--
-- Parties and the per-party Ledger are built on four columns (name, phone,
-- role, balance_due) and a flat dump of every ledger row ever written. Nothing
-- tells the owner HOW OLD an udhaar is, WHICH bills are still open, or how much
-- business a party has actually done. This migration adds that, as READ-ONLY
-- views over the existing trigger-written data — no new writes, no duplicated
-- trigger logic, Golden Rules #9 and #10 untouched.
--
-- Two facts about the ledger shape everything here:
--
-- 1. debit/credit mean OPPOSITE things for buyers and suppliers.
--       supplier: purchase = debit (owe more), payment_out = credit (owe less)
--       buyer:    sale     = credit (owes more), payment_in  = debit (owes less)
--    Plus two adjustment rows that flip within their own side: a counter-sale
--    discount (051) is a DEBIT on a 'sale' entry, and purchase bill charges
--    (036) are a DEBIT on a 'purchase' entry. So no reading of entry_type alone
--    gets the sign right. The rule that always holds:
--       supplier -> debit - credit ;  buyer -> credit - debit
--    `signed_amount` below is exactly that, and it is the ONLY safe signed read.
--
-- 2. A ledger row does NOT imply a balance movement. on_sale_insert writes a
--    ledger row for EVERY sale — but only bumps balance_due when payment_type
--    is 'udhaar'. A cash bill therefore leaves a +amount-looking row behind a
--    completely unchanged running_balance. Receivables built on raw credits
--    would count every cash sale as money owed. `balance_delta` zeroes those
--    rows out; `moved_balance` says which is which so the UI can stop showing
--    a cash sale as "+₹500" against a balance that never moved.
--
-- Views, in dependency order:
--    ledger_entries   — every ledger row, sign-normalised and classified
--    party_bills      — those rows rolled up into real BILLS (charges and
--                       discounts netted into the bill they belong to)
--    party_open_bills — FIFO allocation of payments against bills: what is
--                       still open, how old, which ageing bucket
--    party_summary    — one row per party: lifetime business, money received,
--                       bill count, average bill, first/last activity,
--                       outstanding, oldest open bill, profit (owner only)
--
-- SECURITY. All four are security_invoker = true, so the caller's own RLS runs
-- exactly as it does on the base tables: owner sees the shop, staff see nothing
-- (they hold no policy on ledger/sales/payments — Golden Rule #3), a buyer sees
-- only their own rows. purchase_rate is never selected anywhere; `profit` is
-- reachable only through sales, which is owner-only, so a staff read of
-- party_summary returns no rows rather than a zeroed one.
-- =============================================================================

drop view if exists public.party_summary;
drop view if exists public.party_open_bills;
drop view if exists public.party_bills;
drop view if exists public.ledger_entries;

-- ---------------------------------------------------------------------------
-- 1. ledger_entries — the ledger, made safe to read.
--
-- Adds to every row: a correctly signed amount, the balance movement it really
-- caused, the bill it belongs to, that bill's number, and a `kind` finer than
-- entry_type (a discount is not a sale). Nothing is filtered out.
-- ---------------------------------------------------------------------------
create view public.ledger_entries
with (security_invoker = true) as
select
  l.id,
  l.shop_id,
  l.entry_type,
  l.party_id,
  l.party_type,
  l.reference_id,
  l.reference_table,
  l.debit,
  l.credit,
  l.running_balance,
  l.description,
  l.created_at,

  -- Sign, normalised per side. Positive = the party owes more after this row.
  case when l.party_type = 'supplier' then l.debit - l.credit
                                      else l.credit - l.debit end
    as signed_amount,

  -- What this row actually did to balance_due. A non-udhaar sale row (and its
  -- discount row) moved nothing, however large its credit column looks.
  case
    when l.reference_table = 'sales'
     and coalesce(s.payment_type, 'udhaar') <> 'udhaar' then 0::numeric
    else case when l.party_type = 'supplier' then l.debit - l.credit
                                             else l.credit - l.debit end
  end as balance_delta,

  (l.reference_table <> 'sales'
   or coalesce(s.payment_type, 'udhaar') = 'udhaar') as moved_balance,

  -- How the sale was settled at the counter: cash / upi / udhaar. NULL on
  -- purchase and payment rows (payments carry their own `method`, below).
  s.payment_type as sale_payment_type,
  pay.method     as payment_method,
  pay.reference_no as payment_reference_no,

  -- Finer type. A counter-sale discount (051) is a debit sitting on a 'sale'
  -- entry — a plain sale row never carries a debit, so this test is exact.
  -- Purchase bill charges (036) stay 'purchase': they are the same bill, and
  -- their description already reads "Bill charges: postage 50, CGST 20".
  case
    when l.entry_type = 'sale' and l.debit > 0 then 'sale_discount'
    else l.entry_type
  end as kind,

  -- The bill this row belongs to. Counter bills share bill_id (014), a cart
  -- shares order_group_id (018), a supplier bill shares purchase_group_id
  -- (033); anything older stands alone as a bill of one. Payment rows have no
  -- bill — a payment is independent of any invoice (Golden Rule #8).
  case
    when l.reference_table = 'sales'
      then coalesce(s.bill_id, o.order_group_id, s.order_id, l.reference_id)
    when l.reference_table = 'purchases'
      then coalesce(pu.purchase_group_id, l.reference_id)
    else null
  end as bill_key,

  coalesce(inv.invoice_no, pu.invoice_no) as invoice_no,
  pu.invoice_date as supplier_invoice_date

from public.ledger l
left join public.sales    s   on l.reference_table = 'sales'     and s.id  = l.reference_id
left join public.orders   o   on o.id = s.order_id
left join public.purchases pu on l.reference_table = 'purchases' and pu.id = l.reference_id
left join public.payments pay on l.reference_table = 'payments'  and pay.id = l.reference_id
left join public.invoices inv on (inv.sale_id = s.id)
                              or (s.bill_id is not null and inv.bill_id = s.bill_id);

comment on view public.ledger_entries is
  'Ledger rows with a correctly signed amount (signed_amount), the real balance movement (balance_delta / moved_balance), the bill they belong to (bill_key) and its number. Read-only; the ledger stays append-only and trigger-owned.';

grant select on public.ledger_entries to authenticated;

-- ---------------------------------------------------------------------------
-- 2. party_bills — one row per BILL, not per line.
--
-- on_sale_insert writes a ledger row per line, so a 6-item walk-in bill is 6
-- rows plus a discount row. Rolling up by bill_key nets the discount into its
-- own bill and the postage/GST into theirs, which is what a statement should
-- show.
--
--   bill_total    — the document's value to the shop (goods - discount,
--                   goods + charges), whatever way it was paid.
--   credit_amount — how much of that landed on balance_due. Zero for a cash or
--                   UPI bill. This, not bill_total, is what can be outstanding.
-- ---------------------------------------------------------------------------
create view public.party_bills
with (security_invoker = true) as
select
  e.shop_id,
  e.party_id,
  e.party_type,
  e.bill_key,
  case when e.reference_table = 'purchases' then 'purchase' else 'sale' end as bill_kind,
  min(e.created_at)                       as billed_at,
  sum(e.signed_amount)                    as bill_total,
  greatest(sum(e.balance_delta), 0)       as credit_amount,
  count(*)                                as entry_count,
  max(e.invoice_no)                       as invoice_no,
  max(e.supplier_invoice_date)            as supplier_invoice_date,
  bool_or(e.moved_balance)                as on_credit,
  -- Whatever the first row pointed at: /owner/sales/:id for a sale,
  -- /owner/purchases/:id for a purchase (that route wants the bill's FIRST
  -- purchases line, which is exactly what the earliest row carries).
  (array_agg(e.reference_id order by e.created_at, e.id))[1] as detail_ref,
  -- Cash / UPI / udhaar for a sale bill; NULL for a purchase.
  max(e.sale_payment_type)                as payment_type
from public.ledger_entries e
where e.bill_key is not null
group by e.shop_id, e.party_id, e.party_type, e.bill_key,
         case when e.reference_table = 'purchases' then 'purchase' else 'sale' end;

comment on view public.party_bills is
  'Ledger rolled up per bill (counter bill_id / cart order_group_id / supplier purchase_group_id). bill_total = document value; credit_amount = the part that hit balance_due.';

grant select on public.party_bills to authenticated;

-- ---------------------------------------------------------------------------
-- 3. party_open_bills — which bills are still unpaid, and how old.
--
-- Payments are independent of bills in this system (Golden Rule #8): a Payment
-- In just lowers balance_due, it is never tied to an invoice. So "which bills
-- are open" has to be DERIVED, and the trade convention is oldest-first (FIFO):
-- every rupee received pays down the oldest bill first.
--
-- Done without a loop. Per party, walk the credit bills oldest-first and keep a
-- running total of what has been billed. Against the party's total receipts:
--       outstanding = clamp(billed_so_far - total_paid, 0, this bill)
-- A bill entirely inside the paid window clamps to 0, the one straddling the
-- edge is part-paid, everything after it is fully open.
--
-- Settled bills are kept (outstanding = 0) so a statement can show them; filter
-- on outstanding > 0 for the chase list.
-- ---------------------------------------------------------------------------
create view public.party_open_bills
with (security_invoker = true) as
with paid as (
  -- Total ever received from a buyer / paid to a supplier. Payment rows only:
  -- a discount is not a receipt, and it was already netted into its bill.
  select party_id, party_type, sum(-balance_delta) as paid_total
    from public.ledger_entries
   where reference_table = 'payments'
   group by party_id, party_type
),
billed as (
  select
    b.*,
    sum(b.credit_amount) over (
      partition by b.party_id, b.party_type
      order by b.billed_at, b.bill_key
      rows between unbounded preceding and current row
    ) as billed_to_date
  from public.party_bills b
  where b.credit_amount > 0
)
select
  b.shop_id,
  b.party_id,
  b.party_type,
  b.bill_key,
  b.bill_kind,
  b.billed_at,
  b.invoice_no,
  b.supplier_invoice_date,
  b.detail_ref,
  b.entry_count,
  b.bill_total,
  b.credit_amount,
  round(least(b.credit_amount,
              greatest(b.billed_to_date - coalesce(p.paid_total, 0), 0)), 2)
    as outstanding,
  round(b.credit_amount
        - least(b.credit_amount,
                greatest(b.billed_to_date - coalesce(p.paid_total, 0), 0)), 2)
    as paid_amount,
  (current_date - b.billed_at::date) as age_days,
  case
    when (current_date - b.billed_at::date) <= 30 then '0-30'
    when (current_date - b.billed_at::date) <= 60 then '31-60'
    when (current_date - b.billed_at::date) <= 90 then '61-90'
    else '90+'
  end as age_bucket
from billed b
left join paid p
       on p.party_id = b.party_id and p.party_type = b.party_type;

comment on view public.party_open_bills is
  'Bill-wise outstanding. Payments are not linked to invoices in this system, so they are allocated oldest-bill-first (FIFO) to derive what is still open, with age_days / age_bucket for the ageing report.';

grant select on public.party_open_bills to authenticated;

-- ---------------------------------------------------------------------------
-- 4. party_summary — one row per party, whether or not they ever transacted.
--
-- Customers, dealers and suppliers are unified into one shape so the Parties
-- list and the party detail header read from a single place. Money columns are
-- named by MEANING, not by accounting side: business_total is what this party
-- has bought (buyer) or supplied (supplier); settled_total is what they have
-- paid us (buyer) or we have paid them (supplier).
--
-- balance_due is taken from the base table — it stays the authority, since the
-- triggers own it. computed_balance is the same figure rebuilt from the ledger;
-- the two agreeing is a live check that no trigger has drifted, and the UI can
-- warn when they don't.
-- ---------------------------------------------------------------------------
create view public.party_summary
with (security_invoker = true) as
with parties as (
  select p.id, p.shop_id, 'profile'::text as source,
         p.role as party_type, p.full_name as name, p.phone,
         p.is_active, p.created_at, p.balance_due,
         p.gstin, p.address, p.state_name, p.state_code,
         null::text as contact_person
    from public.profiles p
   where p.role in ('customer', 'dealer')
  union all
  select s.id, s.shop_id, 'supplier'::text,
         'supplier'::text, s.name, s.phone,
         s.is_active, s.created_at, s.balance_due,
         null, s.address, null, null,
         s.contact_person
    from public.suppliers s
),
activity as (
  select
    party_id, party_type,
    min(created_at)                                        as first_txn_at,
    max(created_at)                                        as last_txn_at,
    max(created_at) filter (where reference_table = 'payments')  as last_payment_at,
    max(created_at) filter (where reference_table <> 'payments') as last_bill_at,
    sum(-balance_delta) filter (where reference_table = 'payments') as settled_total,
    sum(balance_delta) filter (where balance_delta > 0)    as credit_total,
    sum(signed_amount) filter (where reference_table <> 'payments') as business_total,
    count(*)                                               as entry_count,
    sum(balance_delta)                                     as computed_balance
  from public.ledger_entries
  group by party_id, party_type
),
bills as (
  select party_id, party_type,
         count(*)              as bill_count,
         avg(bill_total)       as avg_bill_value,
         max(bill_total)       as largest_bill
    from public.party_bills
   group by party_id, party_type
),
open_bills as (
  select party_id, party_type,
         sum(outstanding)                                as outstanding_total,
         count(*) filter (where outstanding > 0)         as open_bill_count,
         min(billed_at) filter (where outstanding > 0)   as oldest_open_at,
         max(age_days)  filter (where outstanding > 0)   as oldest_open_days,
         sum(outstanding) filter (where age_bucket = '0-30')  as due_0_30,
         sum(outstanding) filter (where age_bucket = '31-60') as due_31_60,
         sum(outstanding) filter (where age_bucket = '61-90') as due_61_90,
         sum(outstanding) filter (where age_bucket = '90+')   as due_90_plus
    from public.party_open_bills
   group by party_id, party_type
),
-- Owner-only by construction: sales carries no policy for staff or buyers, so
-- this CTE is simply empty for them and profit_total comes back NULL.
profit as (
  select buyer_id as party_id, buyer_type as party_type,
         sum(profit) as profit_total
    from public.sales
   group by buyer_id, buyer_type
)
select
  pa.id            as party_id,
  pa.party_type,
  pa.shop_id,
  pa.name,
  pa.phone,
  pa.is_active,
  pa.created_at    as party_since,
  pa.gstin,
  pa.address,
  pa.state_name,
  pa.state_code,
  pa.contact_person,

  pa.balance_due,
  coalesce(ac.computed_balance, 0)  as computed_balance,
  round(pa.balance_due - coalesce(ac.computed_balance, 0), 2) as balance_drift,

  coalesce(ac.business_total, 0)    as business_total,
  coalesce(ac.settled_total, 0)     as settled_total,
  coalesce(ac.credit_total, 0)      as credit_total,
  coalesce(bi.bill_count, 0)        as bill_count,
  round(coalesce(bi.avg_bill_value, 0), 2) as avg_bill_value,
  coalesce(bi.largest_bill, 0)      as largest_bill,
  coalesce(ac.entry_count, 0)       as entry_count,
  pr.profit_total,

  ac.first_txn_at,
  ac.last_txn_at,
  ac.last_bill_at,
  ac.last_payment_at,
  case when ac.last_txn_at is null then null
       else (current_date - ac.last_txn_at::date) end as days_since_last_txn,

  coalesce(ob.outstanding_total, 0) as outstanding_total,
  coalesce(ob.open_bill_count, 0)   as open_bill_count,
  ob.oldest_open_at,
  ob.oldest_open_days,
  coalesce(ob.due_0_30, 0)          as due_0_30,
  coalesce(ob.due_31_60, 0)         as due_31_60,
  coalesce(ob.due_61_90, 0)         as due_61_90,
  coalesce(ob.due_90_plus, 0)       as due_90_plus
from parties pa
left join activity   ac on ac.party_id = pa.id and ac.party_type = pa.party_type
left join bills      bi on bi.party_id = pa.id and bi.party_type = pa.party_type
left join open_bills ob on ob.party_id = pa.id and ob.party_type = pa.party_type
left join profit     pr on pr.party_id = pa.id and pr.party_type = pa.party_type;

comment on view public.party_summary is
  'One row per customer/dealer/supplier: lifetime business, money settled, bill count, average bill, first/last activity, outstanding + ageing, and owner-only profit. balance_due is the trigger-owned authority; balance_drift flags any disagreement with the ledger.';

grant select on public.party_summary to authenticated;
