# Shop Management System — Complete Project Specification

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Business Context](#2-business-context)
3. [Design Philosophy](#3-design-philosophy)
4. [User Roles & Access](#4-user-roles--access)
5. [Technology Stack](#5-technology-stack)
6. [Complete Feature List](#6-complete-feature-list)
7. [Database Model](#7-database-model)
8. [Database Triggers & Automation](#8-database-triggers--automation)
9. [Row Level Security](#9-row-level-security)
10. [React Screen Structure](#10-react-screen-structure)
11. [Stock & Money Flow](#11-stock--money-flow)
12. [Pricing Logic](#12-pricing-logic)
13. [Print & Slip System](#13-print--slip-system)
14. [Supabase Edge Functions](#14-supabase-edge-functions)
15. [Build Phases](#15-build-phases)
16. [Core System Rules](#16-core-system-rules)
17. [Folder Structure](#17-folder-structure)

---

## 1. Project Overview

- **Project Name:** Shop Management System
- **Purpose:** A complete business operating system for a small Indian retail/distribution shop
- **Core Loop:** Buy Stock → List on Shopfront → Take Orders → Approve → Pack → Deliver → Record Money
- **Target User:** One shop owner with basic schooling — strong in trade, not in software
- **Scale:** Single shop, single owner, small staff team, local customers and dealers
- **Languages:** English interface with Indian business terminology (udhaar, rate, dealer, etc.)

---

## 2. Business Context

- **Shop Type:** Card, gift, and box shop
- **What it sells:** Finished goods, raw materials, and resold company products
- **Also acts as:** Dealer / distributor for some product lines
- **Selling channels:** Walk-in (via shopfront orders), WhatsApp sharing of shopfront link
- **Payment types accepted:** Cash, UPI, Udhaar (credit)
- **Key relationships:**
  - Buys from Suppliers / Companies
  - Sells to Customers (retail rate)
  - Sells to Dealers (wholesale rate)
  - Carries running balances for both buyers and suppliers

---

## 3. Design Philosophy

### 3.1 Core Principle
> **Simple on top. Strong underneath.**

- What the owner sees: few buttons, big labels, plain language, photos over text, one clear action per screen
- What runs underneath: proper data model, linked records, three-tier pricing, profit tracking, audit-ready ledger
- The power is hidden — not removed

### 3.2 Navigation Rule
- The owner should never need more than **two screens** to complete any task
- If a task takes three screens — the design is wrong, simplify it

### 3.3 Language Rule
- Every number must have a name — not just a figure
- Write: `Today's Sales ₹4,500` — not just `₹4,500`
- Write: `Items Low on Stock: 23` — not just `23`

### 3.4 Action Rule
- One clear primary action per screen
- No dead ends — every screen tells the user what to do next
- Errors say what went wrong and how to fix it — never vague messages

---

## 4. User Roles & Access

### 4.1 Owner
- Full access to everything
- Only role that can approve or reject orders
- Only role that sees profit figures and full ledger
- Can manage staff accounts, categories, and settings
- Sees all party balances — customers, dealers, suppliers

### 4.2 Staff
- Can enter Purchase records
- Can view Inventory and Stock Inquiry
- Can view assigned/packed orders
- Can mark orders Packed, Delivered, or Picked Up
- Cannot approve or reject orders
- Cannot see profit, rates (purchase rate), or ledger
- Cannot access Payment Entry or Reports

### 4.3 Customer
- Registers on Shopfront (name + phone)
- Browses items and sees retail Rate
- Places orders with quantity and optional note
- Tracks own order status
- Views own running balance (udhaar)
- Cannot see other customers' data

### 4.4 Dealer
- Same as Customer login flow
- Flagged as Dealer in their profile
- Sees Dealer Rate on shopfront when logged in
- Carries dealer-specific running balance

### 4.5 Supplier (No Login)
- Suppliers are records only — not system users
- No login, no portal for now
- Owner manages all supplier interaction manually
- Supplier login can be added in a later phase

---

## 5. Technology Stack

### 5.1 Frontend
- **Framework:** React (with React Router for navigation)
- **Styling:** Tailwind CSS
- **State Management:** React Context + Supabase Realtime
- **Icons:** Tabler Icons (outline)
- **Print:** Browser native print with custom CSS print stylesheet

### 5.2 Database & Backend
- **Database:** Supabase (PostgreSQL underneath)
- **Authentication:** Supabase Auth — email/phone + password
- **File Storage:** Supabase Storage (item photos)
- **Real-time:** Supabase Realtime (live order notifications)
- **Server Logic:** Supabase Edge Functions (PDF generation, QR codes, notifications)
- **Security:** Supabase Row Level Security (RLS)

### 5.3 Hosting
- **Frontend Hosting:** Vercel (free tier, one-click React deployment)
- **Database Hosting:** Supabase cloud (free tier sufficient for one shop)

### 5.4 Why No Separate Go Backend
- Supabase handles authentication, database queries, file storage, real-time, and security
- Edge Functions cover remaining server-side needs (PDF, QR, SMS)
- Go can be introduced later if the system grows significantly — the data model will support it cleanly

### 5.5 Barcode / QR
- Scanning: camera-based via browser (works on any phone, no hardware needed)
- Generation: Supabase Edge Function generates QR code on item creation

---

## 6. Complete Feature List

### 6.1 Module 1 — Purchase Entry (Buy Stock In)

- Add new item with all fields in exact order
- Auto-generate Item No (format: SHOP-0001, SHOP-0002, etc.)
- Upload photo from device camera or gallery
- Scan existing barcode via phone camera
- Generate new QR code for item if no barcode exists
- Link item to existing Company / Supplier (dropdown)
- Create new Supplier inline if not in list
- Set low stock threshold per item at time of entry
- On save — stock quantity increases automatically (database trigger)
- On save — supplier balance increases automatically (database trigger)
- On save — ledger entry created automatically
- Edit existing item — all fields editable
- View full purchase history per item
- Staff can enter purchases — owner can always edit

**Fields (in this exact order):**

| # | Field | Type | Notes |
|---|---|---|---|
| 1 | Item No | Auto-generated text | Unique per shop — assigned by DB trigger on insert |
| 2 | Item Name | Text | Required — `items.name` is NOT NULL |
| 3 | Company | Dropdown → suppliers table | Required. Inline-create allowed (owner only) |
| 4 | Category | Dropdown → categories table | Required |
| 5 | Location / Rack No | Text | Display only, does not split stock |
| 6 | Quantity | Number | How many came in (the opening Purchase Entry) |
| 7 | Purchase Rate | Currency | Cost price — what owner paid |
| 8 | Dealer Rate | Currency | Wholesale price for dealers |
| 9 | Rate | Currency | Retail price for customers |
| 10 | Photo | Image upload | Stored in Supabase Storage (`item-photos` bucket) |
| 11 | Barcode / QR | Scan or generate | For fast lookup |
| 12 | Low Stock Threshold | Number | Below this → item flagged Low (default 10) |

**Save sequence (honours Golden Rule #1 — stock in only via Purchase Entry):**
The form inserts the `items` row with `quantity = 0`, then inserts a `purchases`
row for the opening quantity. The `on_purchase_insert` trigger raises
`items.quantity`, raises the supplier's `balance_due`, and writes the ledger.
The form never sets `items.quantity` directly.

---

### 6.2 Module 2 — Inventory (All Stock)

- View all items in one master catalog list
- Each item shows: photo thumbnail, name, Item No, category, quantity, rate
- Search items by name, Item No, barcode, category, company
- Filter by: category, company, low stock status, active/inactive
- Scan barcode / QR to jump directly to item record
- Edit any field on any item
- Mark item inactive (hides from shopfront, stays in records)
- Set or change low stock threshold per item
- View current stock level with visual status (Low / Normal / High)
- Stock value shown per item (quantity × purchase rate)
- Total stock value shown at top of page (owner only)

---

### 6.3 Module 3 — Shopfront (Customer-Facing)

- Auto-generated from live inventory — no manual setup by owner
- Public URL the owner shares on WhatsApp
- Shows: item photo, item name, category, price (Rate)
- Logged-in dealers see Dealer Rate instead of Rate
- Browse by category (tabs or filter)
- Search by item name
- Out of stock items hidden automatically
- Low stock items show "Limited Stock" badge
- Inactive items never appear
- Customer can place order: select quantity, add note, submit
- Order confirmation shown immediately to customer
- Customer tracks own order status (Pending / Approved / Packed / Delivered)
- No login required to browse
- Login required to place order (name + phone registration)

---

### 6.4 Module 4 — Order Management

- All incoming orders in one list — newest first
- Order shows: item photo, item name, quantity, buyer name, buyer type, date, amount
- Filter by: status, buyer type (customer/dealer), date range
- Search by buyer name or item name
- View full order detail on tap
- Owner approves or rejects with one tap
- Rejection reason field (optional)
- Approved order auto-creates Sale record
- Stock decreases on approval (database trigger)
- Profit logged on approval (database trigger)
- Rejected order status closes — nothing changes in stock or money
- Real-time notification when new order arrives (Supabase Realtime)
- Badge count on Orders tab showing pending orders

---

### 6.5 Module 5 — Sale

- Created automatically on order approval — owner never creates manually
- Sale stores: Item No, Category, Quantity, Rate used, Amount, Profit, Payment Type
- Payment type selected by owner at time of approval: Cash / UPI / Udhaar
- If Udhaar selected: amount added to buyer's running balance automatically
- Print Order Supply slip from sale screen
- Slip shows: shop name, date, buyer name, item, quantity, rate, total amount
- View all sales in a list (owner only)
- Filter sales by: date, buyer, payment type, category

---

### 6.6 Module 6 — Fulfilment

- Staff sees list of approved orders waiting to be packed
- Each card shows: item name, location/rack no, quantity, buyer name
- Staff marks order as Packed
- Owner or staff then marks: Delivered or Picked Up from Store
- Owner sees live fulfilment status on dashboard
- Completed orders move to history
- All status changes timestamped automatically

---

### 6.7 Module 7 — Parties

#### 6.7.1 Suppliers / Companies
- Add supplier: name, contact person, phone, address
- View all items purchased from this supplier
- Running balance — how much shop owes supplier
- Full payment history with this supplier
- Full purchase history from this supplier
- Edit supplier details

#### 6.7.2 Customers & Dealers
- Auto-created when customer/dealer registers on shopfront
- Owner can also add manually
- Fields: name, phone, buyer type (Customer / Dealer)
- Running balance — udhaar / credit owed to shop
- Full order history
- Full payment history
- Edit buyer type (convert customer to dealer and vice versa)

---

### 6.8 Module 8 — Payment Entry

- Simple dedicated screen — separate from Sale or Purchase
- Record Payment In: money received from customer or dealer
- Record Payment Out: money paid to supplier
- Select party from list (customer, dealer, or supplier)
- Enter amount and payment method (Cash / UPI / Bank)
- Optional: enter UPI transaction reference number
- Optional: link payment to a specific sale or purchase
- On save: party running balance updates automatically (database trigger)
- On save: ledger entry created automatically
- View payment history per party

---

### 6.9 Module 9 — Stock Inquiry

- Quick lookup table showing all items
- Columns: Item No, Name, Category, Current Quantity, Status
- Status per item: Low (below threshold) / Normal / High (above 1000)
- Filter: show only Low stock items
- Sort by quantity (lowest first) — helps owner see what to reorder
- One tap from any low stock item → opens new Purchase Entry pre-filled with that item
- Threshold is per-item (set in Inventory module)

---

### 6.10 Module 10 — Reports & Accounting

#### Sales Reports (Owner Only)
- Today's total sales amount
- Today's total profit amount
- This week's sales and profit
- This month's sales and profit
- Sales by category (bar chart)
- Top 10 selling items by quantity
- Top 10 selling items by revenue

#### Ledger & Balances (Owner Only)
- Full ledger per customer (all sales, payments, running balance)
- Full ledger per dealer (all sales, payments, running balance)
- Full ledger per supplier (all purchases, payments, running balance)
- Udhaar list — all customers/dealers with outstanding balance
- Supplier dues list — all suppliers with outstanding balance owed by shop

#### Stock Reports (Owner Only)
- Current stock valuation (all items × purchase rate)
- Low stock items list
- Items with zero stock

#### Profit & Loss (Owner Only)
- Total revenue vs total cost vs total profit for any date range
- Profit by buyer type (customer vs dealer)
- Profit by category

---

### 6.11 Module 11 — Settings

- Shop name, address, phone number
- Currency symbol (default ₹)
- Default low stock threshold (overridden per item)
- Manage categories (add, rename, deactivate)
- Manage staff accounts (add, remove, reset password)
- Printer/slip settings (shop name on slip, footer message)

---

## 7. Database Model

### 7.1 Table: shops

```
id                uuid          PRIMARY KEY default uuid_generate_v4()
name              text          NOT NULL
address           text
phone             text
currency_symbol   text          DEFAULT '₹'
created_at        timestamptz   DEFAULT now()
```

---

### 7.2 Table: profiles

```
id                uuid          PRIMARY KEY (matches Supabase auth.users.id)
shop_id           uuid          REFERENCES shops(id)
full_name         text          NOT NULL
phone             text
role              text          NOT NULL CHECK (role IN ('owner','staff','customer','dealer'))
balance_due       numeric       DEFAULT 0  -- udhaar for customers/dealers
is_active         boolean       DEFAULT true
created_at        timestamptz   DEFAULT now()
updated_at        timestamptz   DEFAULT now()
```

---

### 7.3 Table: suppliers

```
id                uuid          PRIMARY KEY default uuid_generate_v4()
shop_id           uuid          REFERENCES shops(id) NOT NULL
name              text          NOT NULL
contact_person    text
phone             text
address           text
balance_due       numeric       DEFAULT 0  -- amount shop owes supplier
is_active         boolean       DEFAULT true
created_at        timestamptz   DEFAULT now()
updated_at        timestamptz   DEFAULT now()
```

---

### 7.4 Table: categories

```
id                uuid          PRIMARY KEY default uuid_generate_v4()
shop_id           uuid          REFERENCES shops(id) NOT NULL
name              text          NOT NULL
type              text          CHECK (type IN ('finished_good','raw_material','resale'))
is_active         boolean       DEFAULT true
created_at        timestamptz   DEFAULT now()
```

---

### 7.5 Table: items

The master catalog. Single record per product. Heart of the entire system.

```
id                    uuid        PRIMARY KEY default uuid_generate_v4()
shop_id               uuid        REFERENCES shops(id) NOT NULL
item_no               text        NOT NULL UNIQUE per shop (auto-generated)
name                  text        NOT NULL
supplier_id           uuid        REFERENCES suppliers(id) NOT NULL
category_id           uuid        REFERENCES categories(id) NOT NULL
location              text        -- rack/shelf label, display only
quantity              numeric     DEFAULT 0 NOT NULL
purchase_rate         numeric     NOT NULL  -- cost price
dealer_rate           numeric     NOT NULL  -- wholesale price
rate                  numeric     NOT NULL  -- retail price
photo_url             text        -- Supabase Storage URL
barcode               text        -- scanned or generated
low_stock_threshold   numeric     DEFAULT 10
is_active             boolean     DEFAULT true
created_at            timestamptz DEFAULT now()
updated_at            timestamptz DEFAULT now()
```

**Computed (not stored):**
- Stock status: quantity < low_stock_threshold → Low | quantity > 1000 → High | else Normal
- Stock value: quantity × purchase_rate (calculated in query, not stored)

---

### 7.6 Table: purchases

Every stock-in event. One row per purchase transaction.

```
id                uuid        PRIMARY KEY default uuid_generate_v4()
shop_id           uuid        REFERENCES shops(id) NOT NULL
item_id           uuid        REFERENCES items(id) NOT NULL
supplier_id       uuid        REFERENCES suppliers(id) NOT NULL
quantity          numeric     NOT NULL
purchase_rate     numeric     NOT NULL  -- rate at time of this purchase
total_cost        numeric     NOT NULL  -- quantity × purchase_rate
entered_by        uuid        REFERENCES profiles(id) NOT NULL
notes             text
created_at        timestamptz DEFAULT now()
```

**On INSERT trigger fires:**
- `items.quantity` += purchase.quantity
- `suppliers.balance_due` += total_cost
- New row inserted into `ledger`

---

### 7.7 Table: orders

Customer and dealer orders from the shopfront. Pending state before approval.

```
id                uuid        PRIMARY KEY default uuid_generate_v4()
shop_id           uuid        REFERENCES shops(id) NOT NULL
item_id           uuid        REFERENCES items(id) NOT NULL
buyer_id          uuid        REFERENCES profiles(id) NOT NULL
buyer_type        text        NOT NULL CHECK (buyer_type IN ('customer','dealer'))
quantity          numeric     NOT NULL
rate_at_order     numeric     NOT NULL  -- Rate or Dealer Rate locked at order time
amount            numeric     NOT NULL  -- quantity × rate_at_order
notes             text
status            text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','rejected',
                                                'packed','delivered','picked_up'))
rejection_reason  text
created_at        timestamptz DEFAULT now()
updated_at        timestamptz DEFAULT now()
```

---

### 7.8 Table: sales

Created automatically on order approval. The financial record of every sale.

```
id                uuid        PRIMARY KEY default uuid_generate_v4()
shop_id           uuid        REFERENCES shops(id) NOT NULL
order_id          uuid        REFERENCES orders(id) NOT NULL
item_id           uuid        REFERENCES items(id) NOT NULL
category_id       uuid        REFERENCES categories(id) NOT NULL
buyer_id          uuid        REFERENCES profiles(id) NOT NULL
buyer_type        text        NOT NULL CHECK (buyer_type IN ('customer','dealer'))
quantity          numeric     NOT NULL
rate_charged      numeric     NOT NULL  -- Rate or Dealer Rate actually used
amount            numeric     NOT NULL  -- quantity × rate_charged
purchase_rate     numeric     NOT NULL  -- copied from item at sale time (for profit calc)
profit            numeric     NOT NULL  -- (rate_charged − purchase_rate) × quantity
payment_type      text        NOT NULL CHECK (payment_type IN ('cash','upi','udhaar'))
approved_by       uuid        REFERENCES profiles(id) NOT NULL
created_at        timestamptz DEFAULT now()
```

**On INSERT trigger fires:**
- `items.quantity` -= sale.quantity
- If payment_type = 'udhaar': `profiles.balance_due` += sale.amount (for buyer)
- New row inserted into `ledger`
- `orders.status` updated to 'approved'

---

### 7.9 Table: payments

Every money movement — in or out — recorded separately from sales and purchases.

```
id                  uuid        PRIMARY KEY default uuid_generate_v4()
shop_id             uuid        REFERENCES shops(id) NOT NULL
direction           text        NOT NULL CHECK (direction IN ('in','out'))
party_id            uuid        NOT NULL  -- profiles.id or suppliers.id
party_type          text        NOT NULL CHECK (party_type IN ('customer','dealer','supplier'))
amount              numeric     NOT NULL
method              text        NOT NULL CHECK (method IN ('cash','upi','bank'))
reference_no        text        -- UPI transaction ID, cheque number etc.
linked_sale_id      uuid        REFERENCES sales(id)
linked_purchase_id  uuid        REFERENCES purchases(id)
recorded_by         uuid        REFERENCES profiles(id) NOT NULL
notes               text
created_at          timestamptz DEFAULT now()
```

**On INSERT trigger fires:**
- If direction = 'in' and party is customer/dealer: `profiles.balance_due` -= amount
- If direction = 'out' and party is supplier: `suppliers.balance_due` -= amount
- New row inserted into `ledger`

---

### 7.10 Table: fulfilment

Tracks packing and delivery status for each approved order.

```
id                uuid        PRIMARY KEY default uuid_generate_v4()
shop_id           uuid        REFERENCES shops(id) NOT NULL
order_id          uuid        REFERENCES orders(id) NOT NULL
sale_id           uuid        REFERENCES sales(id) NOT NULL
status            text        NOT NULL DEFAULT 'pending_pack'
                              CHECK (status IN ('pending_pack','packed','delivered','picked_up'))
packed_by         uuid        REFERENCES profiles(id)
packed_at         timestamptz
completed_by      uuid        REFERENCES profiles(id)
completed_at      timestamptz
delivery_note     text
created_at        timestamptz DEFAULT now()
```

---

### 7.11 Table: ledger

Append-only accounting log. Auto-generated by triggers. Never edited manually.

```
id                uuid        PRIMARY KEY default uuid_generate_v4()
shop_id           uuid        REFERENCES shops(id) NOT NULL
entry_type        text        NOT NULL
                              CHECK (entry_type IN ('purchase','sale','payment_in','payment_out'))
party_id          uuid        NOT NULL  -- customer, dealer, or supplier
party_type        text        NOT NULL CHECK (party_type IN ('customer','dealer','supplier'))
reference_id      uuid        NOT NULL  -- points to sale, purchase, or payment record
reference_table   text        NOT NULL  -- 'sales', 'purchases', or 'payments'
debit             numeric     DEFAULT 0
credit            numeric     DEFAULT 0
running_balance   numeric     NOT NULL  -- balance after this entry for this party
description       text        NOT NULL  -- auto-generated human-readable note
created_at        timestamptz DEFAULT now()
```

**Rules:**
- This table is append-only — no UPDATE, no DELETE ever
- Every financial event writes exactly one row here via trigger
- The owner's ledger view is simply a SELECT on this table filtered by party

---

## 8. Database Triggers & Automation

Every trigger listed here runs automatically in the database. The owner and staff never think about them.

### 8.1 After INSERT on purchases
```
1. items.quantity        += purchases.quantity
2. suppliers.balance_due += purchases.total_cost
3. INSERT INTO ledger (entry_type='purchase', party=supplier, debit=total_cost, description='Purchase: {item_name}')
```

### 8.2 After INSERT on sales
```
1. items.quantity         -= sales.quantity
2. IF payment_type = 'udhaar':
      profiles.balance_due += sales.amount  (for buyer profile)
3. INSERT INTO ledger (entry_type='sale', party=buyer, credit=amount, description='Sale: {item_name}')
4. UPDATE orders SET status='approved' WHERE id = sales.order_id
5. INSERT INTO fulfilment (order_id, sale_id, status='pending_pack')
```

### 8.3 After INSERT on payments (direction = 'in')
```
1. profiles.balance_due  -= payments.amount  (for buyer profile)
2. INSERT INTO ledger (entry_type='payment_in', party=buyer, debit=amount, description='Payment received: {method}')
```

### 8.4 After INSERT on payments (direction = 'out')
```
1. suppliers.balance_due -= payments.amount
2. INSERT INTO ledger (entry_type='payment_out', party=supplier, credit=amount, description='Payment made: {method}')
```

### 8.5 After UPDATE on orders (status = 'rejected')
```
1. No stock change
2. No ledger entry
3. orders.updated_at = now()
```

### 8.6 After UPDATE on fulfilment (status changes)
```
1. IF status = 'packed':     fulfilment.packed_at = now(),    orders.status = 'packed'
2. IF status = 'delivered':  fulfilment.completed_at = now(), orders.status = 'delivered'
3. IF status = 'picked_up':  fulfilment.completed_at = now(), orders.status = 'picked_up'
```

---

## 9. Row Level Security

All tables have RLS enabled in Supabase. These policies control who can see and change what.

### 9.1 items table

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| Owner | All items in shop | Yes | Yes | Soft delete (is_active=false) |
| Staff | All active items in shop | Yes | Location, quantity only | No |
| Customer / Dealer | Active items with quantity > 0 | No | No | No |
| Public (no login) | Active items with quantity > 0 | No | No | No |

### 9.2 purchases table

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| Owner | All | Yes | Yes | No |
| Staff | All | Yes | No | No |
| Customer / Dealer | No | No | No | No |

### 9.3 orders table

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| Owner | All | No | Status changes | No |
| Staff | Approved/packed orders | No | Pack status only | No |
| Customer / Dealer | Own orders only | Yes | No | No |

### 9.4 sales table

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| Owner | All | Via trigger only | No | No |
| Staff | No | No | No | No |
| Customer / Dealer | Own sales only | No | No | No |

### 9.5 payments table

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| Owner | All | Yes | No | No |
| Staff | No | No | No | No |
| Customer / Dealer | Own payments only | No | No | No |

### 9.6 ledger table

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| Owner | All | Via trigger only | No | No |
| Staff | No | No | No | No |
| Customer / Dealer | Own entries only | No | No | No |

### 9.7 profiles table

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| Owner | All profiles in shop | Yes | Yes | Soft delete |
| Staff | Own profile | No | Own profile | No |
| Customer / Dealer | Own profile | No | Own profile | No |

### 9.8 suppliers table

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| Owner | All | Yes | Yes | Soft delete |
| Staff | All (read only) | No | No | No |
| Customer / Dealer | No | No | No | No |

---

## 10. React Screen Structure

### 10.1 Public Routes (No Login)

```
/                     → Shopfront home (browse all items)
/shop/:category       → Shopfront filtered by category
/item/:id             → Item detail page
/login                → Login / Register page
```

### 10.2 Customer / Dealer Routes (Login Required)

```
/orders               → My orders list
/orders/:id           → My order detail + status
/account              → My profile + running balance
```

### 10.3 Staff Routes (Staff Login)

```
/staff                → Staff home (pending packs)
/staff/purchase       → Purchase Entry form
/staff/inventory      → Inventory list (read)
/staff/stock          → Stock Inquiry
/staff/fulfil/:id     → Pack and mark delivered
```

### 10.4 Owner Routes (Owner Login)

```
/owner                → Owner Dashboard (home)
/owner/purchase       → Purchase Entry
/owner/inventory      → Inventory (full edit)
/owner/orders         → Order Management
/owner/orders/:id     → Order detail + approve/reject
/owner/sales          → Sales list
/owner/sales/:id      → Sale detail + print slip
/owner/payments       → Payment Entry
/owner/parties        → Customers, Dealers, Suppliers list
/owner/parties/:id    → Party detail + ledger
/owner/stock          → Stock Inquiry
/owner/reports        → Reports & Accounting
/owner/settings       → Settings
```

### 10.5 Owner Dashboard Widgets

- Pending orders count (tap to go to orders)
- Today's sales total
- Today's profit total
- Items low on stock count (tap to go to stock inquiry)
- Top outstanding udhaar (one person, highest balance)
- Top supplier due (one supplier, highest balance owed)
- Quick actions: New Purchase | View Orders | Record Payment

---

## 11. Stock & Money Flow

### 11.1 Stock Flow

```
STOCK IN:
Owner/Staff enters Purchase Entry
        ↓
Purchase record saved
        ↓ (trigger)
items.quantity increases
        ↓
Item appears on Shopfront (if active and quantity > 0)

STOCK OUT:
Customer places order on Shopfront
        ↓
Order lands in owner's queue (stock NOT changed yet)
        ↓
Owner reviews and APPROVES
        ↓ (trigger)
Sale record created
items.quantity decreases
Profit calculated and stored
        ↓
Fulfilment record created (pending_pack)
        ↓
Staff packs order
        ↓
Staff marks Delivered or Picked Up
        ↓
Order complete
```

### 11.2 Money Flow

```
SALE CREATES A DUE:
Sale approved → payment_type = udhaar
        ↓ (trigger)
profiles.balance_due increases for buyer
Ledger entry: credit against buyer

PAYMENT CLEARS THE DUE:
Owner records Payment In against buyer
        ↓ (trigger)
profiles.balance_due decreases for buyer
Ledger entry: debit against buyer

PURCHASE CREATES A DUE (to supplier):
Purchase saved
        ↓ (trigger)
suppliers.balance_due increases

PAYMENT TO SUPPLIER CLEARS DUE:
Owner records Payment Out to supplier
        ↓ (trigger)
suppliers.balance_due decreases
```

---

## 12. Pricing Logic

### 12.1 Three-Tier Pricing

| Tier | Field | Applied To |
|---|---|---|
| Cost Price | purchase_rate | Internal only — never shown to buyers |
| Wholesale | dealer_rate | Shown to logged-in dealers on shopfront |
| Retail | rate | Shown to customers and public on shopfront |

### 12.2 Rate Selection at Order Time

```
IF buyer.role = 'dealer'  → rate_at_order = item.dealer_rate
IF buyer.role = 'customer' → rate_at_order = item.rate
```

Rate is locked at order time — if owner changes price later, existing orders are not affected.

### 12.3 Profit Calculation

```
profit = (rate_charged - purchase_rate) × quantity

Where:
  rate_charged = rate_at_order from the sale record
  purchase_rate = item.purchase_rate copied to sale at time of approval
```

---

## 13. Print & Slip System

### 13.1 Order Supply Slip

Printed when owner approves an order. Handed to staff for packing.

**Slip contents:**
- Shop name and phone number
- Date and time
- Order ID (for reference)
- Buyer name and phone
- Item name, Item No, Location/Rack No
- Quantity
- Rate
- Total Amount
- Payment type (Cash / UPI / Udhaar)
- Space for staff signature

### 13.2 Print Method

- Browser native print triggered by React
- Custom CSS `@media print` stylesheet hides navigation and shows only slip
- No special printer software or hardware required
- Works from any device — desktop, tablet, or phone

---

## 14. Supabase Edge Functions

These small serverless functions handle tasks that need server-side logic.

### 14.1 generate-qr
- Triggered: when new item is created without a barcode
- Action: generates QR code image containing item_id and item_no
- Returns: QR code image URL stored in Supabase Storage
- Updates: items.barcode with the generated QR URL

### 14.2 generate-item-no
- Triggered: before new item is inserted
- Action: reads the highest existing item_no for this shop, increments by 1
- Returns: new item_no (format: SHOP-0001)

### 14.3 generate-slip-pdf (optional future)
- Triggered: when owner requests PDF version of Order Supply slip
- Action: generates PDF with slip content
- Returns: PDF download URL
- Note: browser print covers 90% of cases; PDF is for WhatsApp-sharing the slip

### 14.4 send-order-notification (optional future)
- Triggered: when new order is placed on shopfront
- Action: sends WhatsApp or SMS to owner's phone
- Content: item name, quantity, buyer name

---

## 15. Build Phases

### Phase 1 — Foundation (Week 1)
- [ ] Supabase project setup
- [ ] All tables created with correct data types and constraints
- [ ] All triggers written and tested
- [ ] Row Level Security policies applied and tested
- [ ] Supabase Auth configured (email + phone)
- [ ] Supabase Storage bucket for item photos created
- [ ] React project initialized with Tailwind CSS and React Router
- [ ] Supabase client connected to React
- [ ] Login / Register screen built

### Phase 2 — Core Data (Week 2)
- [ ] Purchase Entry form (all 10 fields)
- [ ] Photo upload working (Supabase Storage)
- [ ] Camera-based barcode scan working
- [ ] QR code generation Edge Function working
- [ ] Supplier dropdown and inline create
- [ ] Category dropdown
- [ ] Item No auto-generation
- [ ] Inventory list screen
- [ ] Inventory search and filter
- [ ] Item edit screen

### Phase 3 — Shopfront & Orders (Week 3-4) — DONE
- [x] Public shopfront — browse by category
- [x] Public shopfront — item detail
- [x] Customer register and login
- [x] Dealer login with Dealer Rate display
- [x] Place order flow (quantity + note + confirm)
- [x] Order Management screen for owner
- [x] Real-time order notification via Supabase Realtime
- [x] Approve order flow — select payment type
- [x] Reject order flow — optional reason
- [x] Sale record auto-creation via trigger (verified working)

### Phase 4 — Fulfilment & Print (Week 5) — DONE
- [x] Staff fulfilment screen (pending packs list)
- [x] Mark as Packed
- [x] Mark as Delivered / Picked Up
- [x] Print Order Supply slip (browser print)
- [x] Customer order tracking screen

### Phase 5 — Money & Ledger (Week 6)
- [ ] Payment Entry screen (in and out)
- [ ] Party running balances displayed
- [ ] Ledger view per party
- [ ] Udhaar list screen
- [ ] Supplier dues list screen

### Phase 6 — Reports & Polish (Week 7)
- [ ] Owner dashboard with all widgets
- [ ] Today's sales and profit
- [ ] Weekly and monthly summaries
- [ ] Stock Inquiry screen with low stock filter
- [ ] Low stock → Purchase Entry quick link
- [ ] Settings screen (categories, staff, shop info)
- [ ] Stock valuation report
- [ ] Profit and loss summary

### Phase 7 — Future Additions
- [ ] Returns handling (stock back up, payment reverse)
- [ ] Supplier portal login
- [ ] WhatsApp/SMS notifications via Edge Function
- [ ] PDF slip generation and sharing
- [ ] Multi-item orders (currently one item per order)
- [ ] Bulk purchase entry (CSV import)
- [ ] Go backend (if system scales significantly)

---

## 16. Core System Rules

| Rule | Detail |
|---|---|
| Persona | Simple on top, strong underneath — built for a local owner with basic schooling |
| Language | Every number has a label. Never show a bare figure without context |
| Stock in | Only Purchase Entry increases stock. No other path |
| Inventory | One shared catalog. One running quantity per item. Same model as Purchase |
| Shopfront | Auto-generated from inventory. The only selling channel |
| Pricing | Three tiers: Purchase Rate (cost), Dealer Rate (wholesale), Rate (retail) |
| Rate locking | Rate is locked at order time. Price changes do not affect existing orders |
| Stock timing | Stock does NOT decrease when order is placed. Only decreases on owner approval |
| Sale approval | Every order needs owner approval before it becomes a Sale |
| Profit formula | (Rate charged − Purchase Rate) × Quantity. Uses buyer type to pick rate |
| Payment timing | Owner selects payment type at approval: Cash / UPI / Udhaar |
| Udhaar | Udhaar adds to buyer's running balance. Cleared by Payment Entry |
| Supplier balance | Purchase adds to supplier balance. Cleared by Payment Out entry |
| Ledger | Append-only. Auto-written by triggers. Never manually edited |
| Returns | Not in Phase 1. Planned for Phase 7. Rule to be decided before building |
| Supplier login | No supplier login in Phase 1. Suppliers are records only |
| Stock threshold | Set per item. Not a system-wide number |
| Location/Rack | Display label only. Does not split or track stock separately |
| Max screens | Owner should never need more than 2 screens to complete any task |

---

## 17. Folder Structure

```
shop-management/
├── supabase/
│   ├── migrations/
│   │   ├── 001_create_tables.sql
│   │   ├── 002_create_triggers.sql
│   │   ├── 003_row_level_security.sql
│   │   └── 004_seed_data.sql
│   └── functions/
│       ├── generate-qr/
│       │   └── index.ts
│       ├── generate-item-no/
│       │   └── index.ts
│       └── generate-slip-pdf/
│           └── index.ts
│
└── frontend/
    ├── public/
    ├── src/
    │   ├── lib/
    │   │   ├── supabase.js         ← Supabase client setup
    │   │   └── helpers.js          ← Profit calc, rate selector, formatters
    │   ├── context/
    │   │   ├── AuthContext.jsx     ← User session and role
    │   │   └── ShopContext.jsx     ← Shop-wide data
    │   ├── components/
    │   │   ├── ui/                 ← Buttons, inputs, badges, cards
    │   │   ├── ItemCard.jsx
    │   │   ├── OrderCard.jsx
    │   │   ├── PartyBalance.jsx
    │   │   ├── LedgerTable.jsx
    │   │   └── PrintSlip.jsx
    │   ├── pages/
    │   │   ├── public/
    │   │   │   ├── Shopfront.jsx
    │   │   │   ├── ItemDetail.jsx
    │   │   │   └── Login.jsx
    │   │   ├── customer/
    │   │   │   ├── MyOrders.jsx
    │   │   │   └── MyAccount.jsx
    │   │   ├── staff/
    │   │   │   ├── StaffHome.jsx
    │   │   │   ├── PurchaseEntry.jsx
    │   │   │   ├── Inventory.jsx
    │   │   │   ├── StockInquiry.jsx
    │   │   │   └── Fulfil.jsx
    │   │   └── owner/
    │   │       ├── Dashboard.jsx
    │   │       ├── PurchaseEntry.jsx
    │   │       ├── Inventory.jsx
    │   │       ├── OrderManagement.jsx
    │   │       ├── OrderDetail.jsx
    │   │       ├── Sales.jsx
    │   │       ├── SaleDetail.jsx
    │   │       ├── PaymentEntry.jsx
    │   │       ├── Parties.jsx
    │   │       ├── PartyDetail.jsx
    │   │       ├── StockInquiry.jsx
    │   │       ├── Reports.jsx
    │   │       └── Settings.jsx
    │   ├── App.jsx                 ← Router and role-based routing
    │   └── main.jsx
    ├── package.json
    └── tailwind.config.js
```

---

*Document version 1.0 — Ready for development. Start with Phase 1: Supabase setup and table creation.*