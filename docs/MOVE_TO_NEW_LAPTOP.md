# Installing ShopLedger, and moving it to a new laptop

Everything the shop has — customers, sales, payments, users, backups, invoices — is in one folder: **`ShopLedger\data`**. The rest of the ShopLedger folder is the program. Moving to a new laptop means: install the program, then bring the `data` folder.

You need: the **ShopLedger** release folder (or `ShopLedger-x.y.z.zip`), and on the old laptop either the `data` folder or a recent backup.

## 1. Install on the new laptop

1. Install **Node.js 24 LTS** for Windows from https://nodejs.org (choose the "LTS" Windows installer, then Next → Next → Install).
2. Copy the **ShopLedger** folder to the laptop, for example to `C:\ShopLedger`. If you have the .zip, right-click it → **Extract All**.
3. Open the folder, then `scripts`, and double-click **install.bat**. It checks Node.js, prepares the data folder and adds a **ShopLedger** shortcut to the desktop and to Startup. When it says "ShopLedger is ready", press a key to close it.

For a brand-new shop, stop here: start ShopLedger and it asks you to create the **superuser**, then the **owner**. The owner then adds operators in Settings → Users.

**Do not start ShopLedger yet if you are moving data** — do step 2 first.

## 2. Bring the shop's data

### Option A — copy the data folder (best)

1. On the **old** laptop, close ShopLedger: click its black window and press **Ctrl+C** (or close the window). Wait until the window has gone — ShopLedger takes a last backup as it closes.
2. Copy the whole **`ShopLedger\data`** folder to a USB drive.
3. On the **new** laptop, delete the empty `ShopLedger\data` folder that install.bat made, and paste the copied `data` folder in its place.

### Option B — from a backup file

Use this if the old laptop is broken and you have a backup (from the backups folder, the second backup folder, or a downloaded .zip).

1. If it is a .zip, right-click → **Extract All** to get the `shopledger-YYYY-MM-DD_HHmm.db` file. Use the newest one.
2. Copy it into `ShopLedger\data` on the new laptop and **rename it to `shopledger.db`** (replace the file if Windows asks).
   If there are files named `shopledger.db-wal` or `shopledger.db-shm` in that folder, delete them.
3. Also copy the old `backups` folder into `ShopLedger\data` if you have it.

Logins and passwords come with the data: everyone logs in as before.

## 3. Check, then start

1. In `ShopLedger\scripts`, double-click **verify-audit.bat**. It must say **Audit log OK**. If it reports a problem, stop and keep the old laptop or backup safe — do not start entering sales.
2. Start ShopLedger with the desktop shortcut and log in as the owner.
3. Check a few things against the old laptop: the latest invoice number, two or three customer balances, and the stock of a busy item.
4. Settings → Backups → **Back up now**. If you use a second backup folder, check its path is right on this laptop (a USB drive may have a different letter).

## Good to know

- The old laptop's `data` folder is your safety copy until the new one has been in use for a week. Do not use both laptops for sales.
- Moving to a different **Node.js version** later: run `scripts\install.bat` again; it reinstalls what is needed (this needs the internet once).
- Other devices on the shop Wi-Fi: Settings → Network → allow, then restart ShopLedger.
- Superuser password forgotten: `scripts\reset-superuser.bat`, on the laptop itself.
