// Product changelog — one entry per release. Pure data, rendered by the
// Help screen. Add new entries at the TOP.
export const CHANGELOG=[
  {
    version:"v29.14.10",
    date:"22 Jun 2026",
    badge:"Latest",
    badgeColor:"#10b981",
    notes:[
      "📊 Report was printing too wide and clipping on the left edge — narrowed it to 40 characters per line (from 42) with proper left margin so the whole report stays on the paper. Added a “📏 Characters per line” slider in Preset Report (26–48) to fine-tune the exact width for your printer if needed.",
    ]
  },
  {
    version:"v29.14.9",
    date:"22 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "📊 Report rebuilt with fixed-width monospace columns so everything always lines up.",
    ]
  },
  {
    version:"v29.14.8",
    date:"22 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "📊 (superseded) Attempted fixed dot-width report printing.",
    ]
  },
  {
    version:"v29.14.7",
    date:"22 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "📊 Equal fixed-width report columns + optional vertical divider lines. 🧾 Customer info saves/prints with just a name OR phone.",
    ]
  },
  {
    version:"v29.14.6",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🐛 Fixed Preset KOT printing a different layout than its preview; verified all preset types print exactly what the preview shows.",
    ]
  },
  {
    version:"v29.14.5",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🐛 Report fixes: removed duplicated date/time line; tightened columns/margins so Amount & totals aren’t cut off; added adjustable ProductName→Qty gap slider.",
    ]
  },
  {
    version:"v29.14.4",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "™️ “Powered by RestoPOS ©” now also prints on the thermal VAT Return — it's now on every thermal print clients produce.",
    ]
  },
  {
    version:"v29.14.3",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🐛 Report print fixes: report now uses the Preset Report paper width (58mm applies), compact one-line rows so Amount no longer runs off the paper, plus a Row layout toggle.",
    ]
  },
  {
    version:"v29.14.2",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "™️ Every print now shows a small adjustable “Powered by RestoPOS ©” line at the bottom (toggle + size per preset type).",
    ]
  },
  {
    version:"v29.14.1",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🐛 Fixed the Preset Report live preview showing blank. 🧾 Preset KOT now supports Style 5 (Arabic above English, left-aligned).",
    ]
  },
  {
    version:"v29.14.0",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "📊 New “Preset Report” tab — fully customise the thermal Category Sales / Day Summary report (paper width, fonts, column widths, show/hide toggles), with a live preview. Also fixed the Amount column running off the paper.",
    ]
  },
  {
    version:"v29.13.18",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔍 Temporary diagnostic: the green success banner after Save/Print now shows exactly what customer name/phone was captured for that sale.",
    ]
  },
  {
    version:"v29.13.17",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🐛 Preset Invoice live preview (Settings) now includes a sample customer name/phone, so you can actually see the fix from v29.13.16 in the preview pane — it was using demo data with no customer before.",
    ]
  },
  {
    version:"v29.13.16",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🐛 Fixed: customer name/phone entered at checkout was never printing on Preset Invoice or Preset Draft bills — now shown under the Voucher No line (toggle in Layout extras: “Show customer name/phone on receipt”).",
    ]
  },
  {
    version:"v29.13.15",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🧾 Preset Style 5 reworked: now uses Style 3's minimal look (no boxes), item name shows Arabic above English fully left-aligned, plus an optional divider line between items (toggle in Layout extras).",
    ]
  },
  {
    version:"v29.13.14",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🧾 Added Preset Invoice/Draft Style 5 — item name shows Arabic centered above English (like a simplified tax invoice), each with its own size slider plus a gap control between the two lines.",
    ]
  },
  {
    version:"v29.13.13",
    date:"21 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "💳 Moved the Save Bill / Print & Save buttons up to close the gap under the keypad, and made them bigger — the large Print & Save button is now easier to tap.",
    ]
  },
  {
    version:"v29.13.12",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔍 Help → Update is now two steps (Check for Updates → shows what's new → Install This Update); Save/Print buttons nudged off the box edge",
    ]
  },
  {
    version:"v29.13.11",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "💳 Payment window: B2B buyer details moved to the left above payment method; Amount Due box made compact so the left side fits without scrolling",
    ]
  },
  {
    version:"v29.13.10",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔽 Transactions newest on top; Close Day & Reports thermal prints go silently via QZ Tray with bolder, larger text",
    ]
  },
  {
    version:"v29.13.9",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🍽️ KOT-Only prints with the exact same Preset KOT settings and paper width as the normal kitchen KOT",
    ]
  },
  {
    version:"v29.13.8",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🧾 Reprint & View from Transactions use the exact same customer-invoice format as the original print (logo, table, totals, QR); preview matches print 1:1",
    ]
  },
  {
    version:"v29.13.7",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔽 Transactions list newest sale on top; KOT-Only prints use Preset KOT format with a 'KOT ONLY' label",
    ]
  },
  {
    version:"v29.13.6",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🖨️ Reprint from Transactions → View prints silently via QZ Tray (no browser pop-up); QR now prints as a proper image",
    ]
  },
  {
    version:"v29.13.5",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "✅ Fixed the real cause of missing QR & ZATCA number — a reference error was crashing ZATCA invoice generation on every sale",
    ]
  },
  {
    version:"v29.13.4",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔧 Made ZATCA generation resilient to hashing errors and added on-screen error messages (which revealed the root cause fixed in 29.13.5)",
    ]
  },
  {
    version:"v29.13.3",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔢 The invoice number shown to customers and in Transactions is now the official ZATCA invoice number — same number printed below the QR",
    ]
  },
  {
    version:"v29.13.2",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔳 Fixed QR not showing in Transactions → View / reprint — each sale stores its QR directly when the ZATCA invoice is created",
    ]
  },
  {
    version:"v29.13.1",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🛠️ Fixed the Transactions tab crashing (Print/View buttons referenced state that wasn't set up in that screen)",
    ]
  },
  {
    version:"v29.13.0",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "📦 New full Inventory Management section — stock levels, low-stock alerts, stock In/Out, suppliers, and stock value, all auto-syncing",
      "🔍 Search + category filter in Create → Menu Items",
      "⌨️ Fixed on-screen keyboard typing every key twice on touch devices",
      "✋ Fixed drag-and-drop POS menu reorder on tablets (now works by touch)",
    ]
  },
  {
    version:"v29.12.1",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🧮 Fixed the 34.99 rounding bug — a 35.00 item now charges exactly 35.00 (VAT was being recomputed with a different formula in the payment window)",
    ]
  },
  {
    version:"v29.12.0",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🧾 Voucher number now matches the ZATCA invoice number printed below the QR",
      "📡 Strict Live/Offline indicator — actively checks real internet and flips instantly",
      "🎫 Daily token resets automatically on Close Day",
      "👤 Customer name + phone print on normal and preset invoices; preset preview shows name + number",
      "🔤 Preset KOT now has separate size sliders for English and Arabic item text",
    ]
  },
  {
    version:"v29.11.1",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔳 Reprints pull the EXACT original QR from invoice history (not regenerated) — every sale auto-links to its ZATCA invoice",
      "🖨️ Print from Transactions asks 'Print kitchen KOT?' — invoice always prints with its original QR",
    ]
  },
  {
    version:"v29.11.0",
    date:"20 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "📆 New Custom Report tab — pick an exact date+time range, see 'retrieving data', then get a full summary you can print A4 or Thermal",
      "🌙 End of Day now shows only your LAST closed period (one entry, may span multiple days)",
      "👁️ New View button on every transaction — see the exact invoice with its QR",
      "📌 Dashboard license-info widget pinned to the right — no longer shifts when the progress bar toggles",
    ]
  },
  {
    version:"v29.10.0",
    date:"19 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🖨️ New Print Type option in Advanced — choose Thermal or A4. Thermal prints silently via QZ Tray; A4 prints through your system's print dialog.",
      "📄 A4 mode prints full A4 size and shows a popup if printing fails or pop-ups are blocked",
    ]
  },
  {
    version:"v29.9.1",
    date:"19 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔓 Fixed login freezing on the Sign In button — all server checks now time out after 8s instead of hanging",
      "🌙 Fixed Close Day missing sales — sales now carry a reliable timestamp, so Close Day captures everything since the last close regardless of date changes",
      "🚪 New Sign Out button in Help → Support — log back in with an Admin / Manager / Cashier PIN",
    ]
  },
  {
    version:"v29.8.2",
    date:"19 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔎 Login now shows the EXACT reason it failed — wrong username, wrong password, license key not found, credentials not set, or a server/rules error — instead of a generic 'incorrect password' for every case",
      "🧪 Makes diagnosing a client's login problem instant during setup",
    ]
  },
  {
    version:"v29.8.1",
    date:"19 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔑 Fixed login on a brand-new device/browser — the sign-in screen now asks for your license key when none is saved, then verifies username & password against your account.",
      "💾 The license key is saved automatically after the first successful login, so you only enter it once per device",
      "🆕 New devices still go through admin approval after the password checks out",
    ]
  },
  {
    version:"v29.8.0",
    date:"19 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🔐 New device approval — logging in from a device that hasn't been used before now requires admin approval. Correct username + password alone is no longer enough on a new device.",
      "⏳ New \"Waiting for Approval\" screen that auto-signs-in the moment you approve the device from the admin panel — no manual refresh needed",
      "📱 Each device is identified and labelled (OS · browser) so you can recognise it in the admin approval list",
      "✅ Already-approved devices log in instantly as before; approval is remembered until you revoke it",
    ]
  },
  {
    version:"v29.7.0",
    date:"19 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🌙 Close Day now captures EVERYTHING since your last close — not just today's date. If a day was skipped/forgotten, those sales are no longer lost; they roll into the next close.",
      "📅 The Close Day screen now shows your previous close date & time, the full period it will cover, and how many days are included",
      "🧾 Multi-day closes produce ONE combined summary across the whole gap, labelled as a date range (e.g. '17 → 19 Jun')",
      "⚠️ A warning now appears if the period spans more than one day, so you know a day was missed before confirming",
      "🖨️ Reprinting an old combined close from Day History correctly pulls every order across the full date range",
    ]
  },
  {
    version:"v29.6.0",
    date:"19 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🎯 ZATCA reporting status consolidated into ONE place — Transactions → ZATCA Invoices — plus the existing Dashboard widgets. Removed the duplicate ZATCA Tools tab from Settings → Advanced.",
      "📡 The background FATOORA auto-sync now shows a real live banner (was tracked internally but never displayed before) — see exactly when invoices are syncing, and how many succeeded/failed",
      "🕐 New persisted \"Last auto-sync\" line — survives even after the live banner clears or the app reloads, so you always know when invoices last synced",
      "🚨 Added the Urgent (near 24h deadline) count to the ZATCA Invoices header stats — previously only on the Dashboard",
      "🔢 ICV counter + hash chain diagnostics moved from Settings into Transactions → ZATCA Invoices, alongside the invoice list",
      "🐛 Fixed stale help text pointing to a renamed screen (\"Invoices → ZATCA History\" → \"Transactions → ZATCA Invoices\")",
    ]
  },
  {
    version:"v29.5.0",
    date:"19 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "📜 New Help → History tab — export your full ZATCA invoice archive as CSV (for accountants) and/or a ZIP of signed UBL XML files (the legal ZATCA document) for any date range up to 5 years",
      "🔢 Built-in invoice count estimate before exporting, with auto date-range presets (Last Month / 3 Months / Year / 5 Years)",
      "🧱 Large exports auto-paginate from Firestore and auto-split XML ZIPs into chunks so big histories don't crash low-end tablets",
      "🔒 Export is scoped to your business's VAT number only — never pulls other RestoPOS clients' invoices",
    ]
  },
  {
    version:"v29.4.0",
    date:"19 Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "🗄️ ZATCA 5-year retention fix — every invoice now archives to Firestore the instant it's generated, not just after it's reported (unreported invoices are no longer lost if the browser is cleared before sync)",
      "🔁 New Firestore → local restore on app load — rebuilds invoice history AND repairs the ICV counter / hash chain after a browser cache clear or on a new device, so invoice numbering never resets or breaks",
      "📦 Local fast-cache cap raised from 500 → 5,000 invoices (Firestore remains the permanent unlimited archive; localStorage is just the instant-access layer)",
      "🐛 Fixed a duplicate Firestore archive doc per invoice — report/clearance updates now merge into the same record instead of creating a second one",
      "🐛 Fixed a syntax bug in the offline auto-sync retry loop (duplicate catch block) that could crash the background sync",
    ]
  },
  {
    version:"v29.3.0",
    date:"Jun 2026",
    badgeColor:"#1A6B4A",
    notes:[
      "✨ Item Description — tap any cart item to select modifiers (No Onion, Extra Spicy, etc.) set in Advanced",
      "📋 Descriptions print under items in KOT only — never on customer invoice",
      "📊 Sales Progress Bar — toggleable goal tracker on Dashboard showing Card / Cash / Total vs daily target",
      "🧾 Bill Type upgraded — added KOT Only option (saves as D-Invoice, prints KOT only, no customer bill)",
      "💳 Removed Apple Pay & Mada from payment methods (Cash / Card / Cash+Card remain)",
    ]
  },{
    version:"v29.2.5",
    date:"15 Jun 2026",
    badgeColor:"#10b981",
    changes:[
      "🧾 Smart order labels now print on the INVOICE too — Parcel / Dine in / Delivery, with a Telephone line on phone orders (was KOT-only before)",
      "🍳 Smart KOT labels now work even without the preset enabled — Takeaway→Parcel, Dine-in→Dine in, Phone→Telephone line on top",
      "📊 Close Day thermal report redesigned — category table with Qty / Tax / Amount columns, full totals block, and the open→close date & time range printed automatically",
    ]
  },
  {
    version:"v29.1.5",
    date:"15 Jun 2026",
    badge:"Previous",
    badgeColor:"#6366f1",
    changes:[
      "🧹 Removed the old Invoice Format tab — all bills are now designed in one place: Settings → Preset Bills",
      "🖨️ ESC/POS Test Print now actually prints — it uses your connected ESC/POS printer if available, otherwise prints through QZ Tray using your saved preset design",
      "🍳 ESC/POS Kitchen test print now prints a real KOT too",
      "🧱 ESC/POS layer kept in place as the foundation for the upcoming native Windows app",
    ]
  },
  {
    version:"v29.0.5",
    date:"15 Jun 2026",
    badge:"Previous",
    badgeColor:"#6366f1",
    changes:[
      "🖨️ FIXED: bills now correctly print your saved Preset design — tapping Save in Presets always turns the preset ON",
      "🔤 FIXED: Arabic no longer boxes on the classic receipt either — switched all printed receipts to system fonts (Tahoma/Arial) that print instantly",
      "✅ Both Preset and Classic receipts now render Arabic + English perfectly",
    ]
  },
  {
    version:"v28.9.5",
    date:"14 Jun 2026",
    badge:"Previous",
    badgeColor:"#6366f1",
    changes:[
      "✏️ New Edit Layout mode in POS — tap the pencil next to the search bar to rearrange your menu",
      "↕️ Drag items to reorder them within a category — your custom order is saved",
      "📐 Box height slider — make item boxes flatter (rectangular) to fit more on screen, text stays the same size",
      "💾 Changes only apply after you tap Save — Cancel discards them",
      "⭐ Favourites category is now just a star to save space when scrolling categories",
    ]
  },
  {
    version:"v28.8.5",
    date:"14 Jun 2026",
    badge:"Previous",
    badgeColor:"#6366f1",
    changes:[
      "🔤 FIXED Arabic boxing on printed bills — switched receipt Arabic to system fonts (Tahoma/Arial) that the printer renders instantly, so Arabic next to English (Tel, VAT, TOTAL, etc.) never collapses again",
    ]
  },
  {
    version:"v28.7.5",
    date:"14 Jun 2026",
    badge:"Previous",
    badgeColor:"#6366f1",
    changes:[
      "🔤 Fixed Arabic text collapsing/boxing on bills after adding a logo — Arabic now always prints bold and clean on invoices, drafts, and KOTs",
      "🏢 Business name is now optional when a logo is added, required when there's no logo",
      "📍 New optional Extra Info line on bills — prints between business name and Tel number",
      "🅱️ New text thickness control — pick a section (Items, Header, Token, Totals) and adjust its boldness independently",
      "🍳 Smart KOT titles — Takeaway prints Parcel, Dine-in prints Dine in, Phone orders add a Telephone line on top",
      "📐 New KOT box padding slider to resize the token box",
    ]
  },
  {
    version:"v28.6.5",
    date:"14 Jun 2026",
    badge:"Previous",
    badgeColor:"#6366f1",
    changes:[
      "📄 Terms & Conditions tab added in Help — clients can read and download the full legal PDF",
      "💳 Pay VAT button in VAT tab — active only during quarterly filing window (April, July, October, January)",
      "🧾 INV number box added to top bar — shows current ZATCA invoice number, updates on real invoices only",
      "📉 Analytics, Audit Trail, and Tools moved inside Advanced tab — cleaner main taskbar",
      "🔢 Token number size increased on invoices, drafts, and KOTs for better visibility",
      "🎚️ Token No. size slider added in Presets — adjust independently from other fonts",
      "🚫 Draft bills no longer appear in Dashboard recent orders — only real invoices shown",
      "🔄 Update tab now shows version history and changelog",
    ]
  },
  {
    version:"v28.5.5",
    date:"13 Jun 2026",
    badge:"Previous",
    badgeColor:"#6366f1",
    changes:[
      "🔇 Silent printing via QZ Tray — no more print popup dialogs",
      "🖨️ Silent Print Setup tab added in Advanced settings",
      "📋 WhatsApp upgrade link updated to +966 53 836 0053",
      "📅 Past-year revenue fields (2022–2025) added to ZATCA eligibility check",
      "🔐 Clear License button disabled for clients — contact support to manage",
      "👤 Already a customer? Log In button added to registration Step 1",
    ]
  },
  {
    version:"v27.0.0",
    date:"May 2026",
    badge:"",
    badgeColor:"#94a3b8",
    changes:[
      "⚡ ZATCA Setup tab — self-service Phase 2 onboarding with 7-step animated progress",
      "🧾 VAT Guide tab — VAT Categories, Calculator, Return, Penalty Estimator, ZATCA Rules",
      "📡 FATOORA reporting wired to real ZATCA microservice on Railway",
      "✅ Phase 2 eligibility check with automated mandate detection",
    ]
  },
];
