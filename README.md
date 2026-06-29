# Shop Management System

A complete business operating system for a small Indian retail/distribution shop
(card, gift & box shop that also acts as a dealer/distributor).

> **Design principle: Simple on top, strong underneath.**
> The owner sees few buttons and plain language; underneath runs a proper data
> model, three-tier pricing, profit tracking, and an audit-ready ledger.

**Core loop:** Buy Stock → List on Shopfront → Take Orders → Approve → Pack → Deliver → Record Money

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React + Vite, React Router, Tailwind CSS, Tabler Icons |
| State | React Context + Supabase Realtime |
| Backend | Supabase (Postgres, Auth, Storage, Realtime, Edge Functions) |
| Security | Supabase Row Level Security (RLS) |
| Hosting | Vercel (frontend) + Supabase Cloud (backend) |

There is **no separate backend service** — Supabase + Edge Functions cover it.

## Documentation

- **[docs/SPEC.md](docs/SPEC.md)** — the complete, canonical specification (data model, triggers, RLS, screens, pricing, build phases). This is the source of truth.
- **[CLAUDE.md](CLAUDE.md)** — working rules and conventions for development.

## Getting Started

> The React app is not scaffolded yet — see Build Phases in `docs/SPEC.md` (Phase 1).

```bash
# 1. Install dependencies (after scaffolding)
npm install

# 2. Configure environment
cp .env.example .env   # then fill in your Supabase URL + anon key

# 3. Run the dev server
npm run dev
```

## Roles

- **Owner** — full access; only role that approves orders and sees profit/ledger
- **Staff** — purchases, inventory (read), fulfilment; no profit/rates/ledger
- **Customer** — browses shopfront at retail Rate, places & tracks orders
- **Dealer** — like customer, sees wholesale Dealer Rate
- **Supplier** — record only, no login (Phase 1)

## Project Status

Foundation setup. Building per the 7 phases in `docs/SPEC.md`, starting with
Phase 1 (Supabase schema, triggers, RLS, auth) → Phase 2 (Purchase + Inventory) → ...
