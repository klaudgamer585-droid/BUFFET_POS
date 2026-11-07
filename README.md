# Gelo's Buffet and Events Place POS

A buffet service prototype for table check-in, plate capacity, live guest billing, and manager-maintained promotions. Completed buffet and legacy menu sales, earnings, and guest counts are stored in MariaDB. The Dish Cost Inventory records dated dish costs and compares the selected day's costs with completed sales earnings.

## Functional requirements

- Record parties by table, adult count, child count, total pax, assigned plates, and seated/closed status.
- Check-in distributes one plate per guest by default. Additional plate distribution is recorded independently and visibly flagged when it exceeds recorded pax.
- Keep clean, in-use, and dishwashing plate counts. Bussing moves a plate from in-use to dishwashing; washing returns it to clean stock. Available stock is current clean stock minus in-use plates. Alert at or below the configurable percentage of the opening clean-stock baseline.
- Price adults and children separately, with an optional weekend surcharge. Calculate subtotal, one active discount/promo, service charge, tax, and total; round monetary results to cents for the response.
- Support percentage, fixed-amount, guest-tier, and birthday free-guest promotions. Promo conditions include target guest class, minimum pax, or one free adult per N paying adults. Managers can add, edit, activate, and deactivate rules without restarting the server.
- Recalculate check-in estimates immediately as guest counts, pricing, promo selection, and manual percentage discount change. The checkout endpoint recalculates the total on the server.

## Data model

| Entity | Prototype fields |
| --- | --- |
| `Table` | `id`, `seats`, computed `status`, computed active `party` |
| `Party` | `id`, `tableId`, `adults`, `children`, `paxCount`, `assignedPlates`, `status`, `checkedInAt`, optional `checkedOutAt` |
| `PlateInventory` | `initialCleanStock`, `cleanStock`, `inUse`, `inDishwashing`, `minimumThresholdPct`; computed `availableStock = cleanStock - inUse` |
| `PricingConfig` | `adultPrice`, `childPrice`, `weekendSurcharge`, `serviceChargePct`, `taxRate` |
| `Promo` | `id`, `code`, `name`, `type`, `value`, `active`, `appliesTo`, `conditions` |
| `PlateEvent` | `type` (`distributed`, `bussed`, `received`, `removed`, or `unavailable`), `quantity`, optional `partyId`, `source`, `reason`, `at` |
| `DishCostEntry` | `id`, `businessDate`, `dish`, `totalCost`, `createdAt`; persisted in MariaDB |
| `Sale` | party/table snapshot, guest-category counts, total guest count, payment method, promo, subtotal, discount, total earnings, timestamp |

Example promo conditions: `{ "minPax": 10 }` for a tier, `{ "freeEvery": 4 }` for a birthday, and `appliesTo: "children"` for a child-only percentage rule.

## API contract

All routes return JSON. State is held in server memory in this prototype.

| Method and route | Purpose |
| --- | --- |
| `GET /api/buffet/state` | Read tables, parties, plate inventory/events, pricing, promos, diner count, and available stock |
| `GET /api/orders?limit=10` | Read the most recent persisted sales across buffet and legacy menu checkout (1-100 results) |
| `GET /api/sales/summary` | Read all-time completed sale count, guest count, and earnings aggregated from MariaDB |
| `GET /api/sales?search=&startDate=&endDate=&source=&page=1&pageSize=25&timezoneOffset=` | Search/filter and paginate MariaDB sale records; dates use `YYYY-MM-DD` in the browser's local timezone, source is `all`, `buffet`, or `menu` |
| `GET /api/dish-costs?date=YYYY-MM-DD&timezoneOffset=` | Read the day's dish cost entries, their total, completed-sale earnings, and earnings after dish costs |
| `GET /api/dishes` | List saved reusable dishes and their latest saved default costs |
| `POST /api/dish-costs` | Add `{ dish, totalCost, date, saveToCatalog? }` as a persistent daily dish-cost entry; when `saveToCatalog` is true, add/update the reusable dish record in the same transaction |
| `DELETE /api/dish-costs/:id` | Remove a dish-cost entry |
| `POST /api/buffet/parties` | Check in `{ tableId, adults, children }`; assigns pax plates and rejects occupied/full tables or insufficient stock |
| `PATCH /api/buffet/parties/:id/plates` | `{ action: "distribute" | "bus", quantity }` adjusts plates by a positive quantity; `{ action: "set", quantity }` sets the assigned count to a non-negative whole number and records the inventory change |
| `PATCH /api/buffet/parties/:id/release` | End an active seating without payment, free the table, and move any assigned plates to dishwashing |
| `PATCH /api/buffet/plates` | `{ action: "receive" | "remove" | "wash", quantity }`, `{ action: "set-available", quantity }`, `{ action: "unavailable", quantity, source, partyId?, reason }`, or `{ action: "wash-all" }`; unavailable source is `clean`, `in-use`, or `dishwashing`, and in-use counts require an active party ID |
| `PATCH /api/buffet/threshold` | Update `{ minimumThresholdPct }` from 1 to 100 |
| `PATCH /api/buffet/pricing` | Update any of `adultPrice`, `childPrice`, `weekendSurcharge`, `serviceChargePct`, `taxRate` |
| `POST /api/buffet/promos` | Add a rule with `{ name, code, type, value, appliesTo, minPax, freeEvery }` |
| `PATCH /api/buffet/promos/:id` | Edit name/value/conditions or activate/deactivate with `{ active }` |
| `POST /api/buffet/checkout` | Finalize `{ partyId, promoId, customDiscountPct, paymentMethod }`; calculates total and returns the order and new state |

Legacy menu, recipe, discount, and item-order endpoints remain available for the existing inventory page and older POS integrations.

## POS screen flows

1. **Floor and plate dashboard:** Service metrics summarize diners, clean plates, dishwashing, and bussed plates in the last hour, plus all-time earnings and guests served from completed sales in MariaDB. The Sales & Database view provides date/source filters, receipt/table search, paginated records, and receipt details. The floor map shows tables with seats, occupied pax, assigned plates, and selection state. The plate panel tracks opening stock, threshold, in-use/washing counts, and recent movement. Plate controls can add/remove clean stock or set the available unassigned clean count while preserving plates in use. Staff can also mark plates unavailable from clean, selected active-table, or dishwashing stock and record why; plate activity shows the reason. Low stock changes the bar to red and displays an alert.
2. **Check-in:** Select an open table, enter adults and children with steppers or direct numeric input, and review the live price estimate. Check-in assigns one plate per guest and reserves the table. Occupied tables expose distribute/bus controls and an option to set the assigned plate count; count increases use clean stock and reductions move plates to dishwashing. Over-pax assignments are flagged. A confirmed unpaid release frees the table without creating an order and moves remaining assigned plates to dishwashing. Plate shortages and table capacity are checked on both client and server.
3. **Billing and discount:** Select an active table to see subtotal, promo chips, a manual discount slider, and live estimated fees/total. Review bill opens checkout with adult/child lines, discount, service, tax, payment method, and amount due. Checkout closes the party and moves its assigned plates to dishwashing.
4. **Manager:** Change adult/child pricing, weekend surcharge, service charge, tax, or low-stock threshold. Add promo rules and edit their name/value or active status. Current estimates and checkout totals use the updated values.
5. **Dish Cost Inventory:** Select a business date, record each dish and its total cost, then compare the day's combined dish costs with completed sales earnings. Entries are stored in MariaDB; optionally save/update a dish and its latest cost in the reusable dish list to select it for future daily entries. The comparison is earnings after dish costs and excludes other business expenses.

## Run locally with XAMPP MariaDB

1. In the XAMPP Control Panel, start **MySQL** (MariaDB). The default connection is `127.0.0.1:3306`, user `root`, no password, and database `buffet_pos`.
2. If your XAMPP credentials differ, set these environment variables before starting the POS server: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`. For PowerShell, for example:

   ```powershell
   $env:DB_HOST = "127.0.0.1"
   $env:DB_PORT = "3306"
   $env:DB_NAME = "buffet_pos"
   $env:DB_USER = "root"
   $env:DB_PASSWORD = ""
   npm.cmd install
   npm.cmd start
   ```

3. The server creates the configured database, `sales`, `dish_cost_entries`, and `dish_catalog` tables automatically; the configured MariaDB user needs permission to create the database and tables.
4. On startup, existing sales in `data/buffet-pos.sqlite` are copied into MariaDB using sale IDs to prevent duplicate imports. The SQLite file is retained as a backup.
5. Open `http://localhost:3000`. To inspect the `buffet_pos` database, open `http://localhost/phpmyadmin` and select it.

## Production hardening

Sales and dated dish-cost entries are persisted in MariaDB through `mysql2`; the prior SQLite database is read at startup and imported idempotently by sale ID, without being modified or deleted. Keep a backup of the SQLite file until the imported data is verified in phpMyAdmin. The runtime requires Node.js 22.13 or newer. This remains a single-process prototype: tables, active parties, plate events, pricing, promos, and menu are still held in memory and reset on restart. Before production, persist those operational settings, enforce role-based authorization for manager actions, use an auditable append-only plate/order ledger, add idempotency and concurrency controls to check-in/checkout, define jurisdiction-specific tax and discount policy, and add automated API/UI tests and monitoring.