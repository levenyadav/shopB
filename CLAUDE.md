# CLAUDE.md — Working rules for the Shop Management System

This file governs how to build this project. **`docs/SPEC.md` is the canonical
specification** — read it before implementing any module. This file captures the
rules that must never be violated and the conventions to keep code consistent.

## What this is

The **real production platform** (not a demo) for a small Indian card/gift/box
shop that also distributes to dealers. React + Vite frontend, Supabase backend.
A clickable HTML/CSS prototype was abandoned in favour of this real build.

## Golden rules (never break these)

These come from SPEC §16 and the data model. Violating one corrupts the books.

1. **Stock in only via Purchase Entry.** No other path increases `items.quantity`.
2. **Stock out only on owner approval.** Placing an order does NOT change stock.
   Stock decreases when the Sale record is created (on approval), via trigger.
3. **Every order needs owner approval** before it becomes a Sale. Owner is the
   only role that approves/rejects, sees profit, sees rates, and sees the ledger.
4. **Three-tier pricing:** `purchase_rate` (cost, internal only — never shown to
   buyers), `dealer_rate` (wholesale, shown to dealers), `rate` (retail, shown to
   customers/public).
5. **Rate is locked at order time** (`rate_at_order`). Later price changes never
   affect existing orders.
6. **Profit = (rate_charged − purchase_rate) × quantity.** Buyer type picks the
   rate: dealer → dealer_rate, customer → rate.
7. **Payment type chosen by owner at approval:** cash / upi / udhaar. Udhaar adds
   to the buyer's `balance_due`; cleared only by a Payment In entry.
8. **Payments are independent** of sales/purchases. Purchase raises a supplier's
   `balance_due`; Payment Out clears it.
9. **The `ledger` table is append-only.** Written ONLY by triggers. Never UPDATE,
   never DELETE, never INSERT manually from the app.
10. **Balances and stock are mutated by database triggers, not by client code.**
    The frontend inserts purchases/sales/payments; triggers do the rest. Do not
    duplicate trigger logic in React.

## Design philosophy (SPEC §3)

- **Simple on top, strong underneath.** Few buttons, big labels, plain language,
  photos over text, one clear primary action per screen.
- **Max two screens** for any owner task. Three screens = wrong design.
- **Every number has a label.** Show `Today's Sales ₹4,500`, never a bare `₹4,500`.
- **No dead ends.** Every screen says what to do next. Errors say what went wrong
  AND how to fix it.
- Language: English + Indian business terms (udhaar, rate, dealer).

## Tech & conventions

- **Frontend:** React + Vite, React Router, Tailwind CSS, Tabler Icons (outline).
  Files use `.jsx`. Follow the folder structure in SPEC §17.
- **State:** React Context (`AuthContext` for session/role, `ShopContext` for
  shop data) + Supabase Realtime for live order notifications.
- **Backend:** Supabase. SQL lives in `supabase/migrations/` (tables → triggers →
  RLS → seed, numbered). Edge Functions in `supabase/functions/`.
- **Secrets:** only `.env` (gitignored). Frontend reads `VITE_`-prefixed vars.
  Never hardcode keys; never commit `.env`. The Supabase project already exists.
- **Money:** integer-safe handling of `numeric` rupee values; format with the
  shop's currency symbol (default ₹).
- **RLS is enforced** server-side per SPEC §9 — but still write client queries
  scoped correctly; never rely on hiding UI as the only protection.

## Build order

Follow SPEC §15 phases in order. Currently: **foundation set up**, next is
**Phase 1** (Supabase schema, triggers, RLS, auth, Storage bucket, Vite+Tailwind
scaffold, login screen). Do not jump ahead to later modules before the schema and
triggers they depend on exist and are verified.

## Process rules

- **Commit often.** This work was lost twice before because there was no git.
  After each working increment, commit. Do not let uncommitted work pile up.
- Keep `docs/SPEC.md` as the source of truth; if a decision changes it, update the
  spec in the same change, don't let code and spec drift.
- Prefer verifying behaviour (run it / query it) over assuming triggers fired.
