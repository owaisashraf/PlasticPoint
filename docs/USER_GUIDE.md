# ShopLedger — user guide

ShopLedger runs on the shop laptop. Double-click the **ShopLedger** shortcut on the desktop; it opens in the browser at `http://localhost:3000`. A black window titled "ShopLedger – keep this window open" appears with it: minimise it, don't close it. Press **?** on any screen to see the keyboard shortcuts.

The footer shows **Last backup**. If it turns red, tell the owner.

## For operators

**New sale (F4)** — the most-used screen.
1. **F2** opens the customer search. Type any part of the name, shop, phone, city or code. The list shows each customer's balance and badges for overdue or bad debt. Not there? Choose **+ Add new customer** at the bottom.
2. Type an **item code** and press Enter. A size × colour grid opens with the stock in each box: type quantities, press **Ctrl+Enter**.
3. The price is fixed. You may change the **discount %** on a line; changed discounts turn purple. If a discount is too high you will see "This discount needs owner approval": the owner types their password to allow it.
4. Enter any **cash received now**, then **Ctrl+S** to save, or **Ctrl+Enter** to save and print or send on WhatsApp.

Warnings about overdue invoices or the credit limit do not stop the sale — they are there so you can mention them to the customer.

**Payments → Receive** — choose the customer; the money pays the oldest invoices first. For cheques, enter the cheque number, bank and date.

**Returns** — open the original invoice and press **Return items**. You can pay money back now if the customer wants it.

**Overdue** — everyone who is late, longest first (amber, orange, red). Use the chat icon to send a **WhatsApp reminder** and the page icon for a statement.

**WhatsApp** — the chat opens with the message ready. The PDF is saved on the laptop: press **Open folder** and drag the file into the chat, then press Send. If the customer has no number, ShopLedger asks you to add it.

**Mistakes** — you can **Edit** your own documents on the same day, with a reason. For anything older, ask the owner. Nothing is ever deleted: every change is recorded.

## For the owner

You can do everything an operator can, plus:

- **Profit**: the dashboard shows profit today, this month and net profit for the fiscal year (July–June). New Sale shows each sale's profit; loss-making lines are red.
- **Reports**: Profit & loss (month by month, compare with last year), Net profit, Gross profit by item/customer/city/operator, Discounts, Profit check (sales below cost, products whose discount is above the supplier margin), Expenses, Assets, Cash/bank book and Stock valuation. Every report prints to PDF and exports to CSV.
- **Prices**: change prices, supplier margins and discounts on the product, or for a whole category with **Bulk update**. Stock already bought keeps its old cost.
- **Expenses** and **Assets**: enter rent, salaries, bills, and things the shop buys to keep (furniture, computer, vehicle). Depreciation is worked out automatically.
- **Edit or void** any document, with a reason. **Mark cheque bounced** on a cheque payment. **Mark bad debt** and **Write off** on the customer page.
- **Approvals**: when an operator needs one, type your username and password in the box on their screen.
- **Settings**: business details, payment terms, discounts and minimum profit, document numbers, WhatsApp messages, users, and **Backups**.

**Backups** happen every day at 21:00, at start-up and when ShopLedger closes. In Settings → Backups you can **Back up now**, **Download** a backup as a .zip (keep it private — it contains everything), and **Restore** one. Set a **second backup folder** on a USB drive or a Google Drive / OneDrive folder so a copy always leaves the laptop.

## For the superuser

You have everything the owner has, plus:

- **Change History**: every document created, edited, voided, printed or shared, and every change to customers, products, prices, users and settings. Click a row to see exactly what changed (old → new). Use **Flagged only** and **Not yet reviewed** to find edits after printing, later-day edits, reduced totals, big discounts and below-cost sales; press **Mark reviewed** when you have checked one. The dashboard shows how many flagged changes are waiting.
- **Verify integrity** checks that no record in the history was changed or removed.
- **Forgotten superuser password**: on the laptop, double-click `scripts\reset-superuser.bat`. It cannot be done from another device.
