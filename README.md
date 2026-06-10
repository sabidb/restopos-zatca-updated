# 🍽️ RestoPOS — ZATCA Phase 2 Compliant Restaurant POS

<div align="center">

![Version](https://img.shields.io/badge/version-v23-green)
![ZATCA](https://img.shields.io/badge/ZATCA-Phase%202-blue)
![License](https://img.shields.io/badge/license-Commercial-orange)
![PWA](https://img.shields.io/badge/PWA-Ready-brightgreen)

**Professional Restaurant Point of Sale System**
**نظام نقاط البيع الاحترافي للمطاعم**
**Professionelles Restaurant-Kassensystem**

[🌐 Live Demo](https://restopos.store) • [👑 Admin Panel](https://restopos-admin.vercel.app) • [📧 Support](mailto:restopos.noreply@gmail.com)

</div>

---

## 🇬🇧 English

### What is RestoPOS?

RestoPOS is a fully featured, cloud-connected restaurant Point of Sale system built for the Saudi Arabian market. It is fully compliant with ZATCA Phase 2 e-invoicing requirements and works as a Progressive Web App — installable on any PC, tablet, or mobile device directly from Chrome.

### Key Features

**Point of Sale**
- Fast item search and category filtering
- Dine-in, Takeaway, and Delivery order types
- Table management with real-time status
- Cart management with quantity adjustments
- Customer name, phone, and address capture
- Hold orders and recall them later
- KOT (Kitchen Order Ticket) printing

**Payments**
- Cash with change calculation and quick amount buttons
- Card, Mada, Apple Pay
- Split payment (Cash + Card) with validation
- Coupon codes and manual discounts
- VAT calculated after discount (ZATCA compliant)
- Cash drawer auto-open on cash payments
- Print & Save toggle persists across invoices

**ZATCA Phase 2 Compliance**
- UBL 2.1 XML invoice generation
- TLV QR code with seller name, VAT, timestamp, total, VAT amount
- SHA-256 hash chain linking all invoices
- Sequential ICV counter
- FATOORA queue management
- VAT liability dashboard with submission tracking
- Push to FATOORA button (simulation mode — configure CSID for live)

**Printing**
- Dual ESC/POS thermal printer support (Bill + Kitchen)
- Auto-connect to previously approved USB printers
- Auto-cut after every receipt and KOT
- Fallback to browser print if no printer connected
- Custom receipt templates (Modern, Classic, Minimal, Arabic RTL)
- Full invoice format editor with live preview

**Reports & Analytics**
- Daily, weekly, monthly sales reports
- Category and item-level sales breakdown
- Payment method breakdown
- VAT collected reports
- Excel export with Arabic text support (UTF-8 BOM)
- Close Day summary with A4 PDF and thermal print options
- Calendar date presets (Today, Yesterday, This Month, etc.)

**Cloud & Offline**
- Auto-sync all data to Firebase Firestore every 3 seconds
- Full data restore on new device login
- Works completely offline — POS, printing, reports
- Syncs to cloud when internet reconnects
- Monthly sales archiving — unlimited invoice history

**Multi-language**
- Full English interface
- Full Arabic interface with RTL layout
- Tajawal font for Arabic
- Auto-translate menu item names via MyMemory API
- Bilingual receipts (English + Arabic item names)

**Security**
- License key activation with admin approval
- Username + password login with bcrypt hashing
- Email verification with 6-digit code (EmailJS)
- Password reset via email
- Rate limiting — 5 failed attempts locks for 5 minutes
- Force logout and deactivation from admin panel
- Subscription expiry enforcement

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite 5 |
| Database | Firebase Firestore |
| Storage | Firebase Storage |
| Auth | Custom (EmailJS + bcrypt) |
| Printing | ESC/POS Web Serial API |
| Offline | Service Worker (Workbox) |
| Hosting | Vercel |
| Domain | restopos.store |

### Installation (PWA)

1. Open [restopos.store](https://restopos.store) in **Google Chrome**
2. Click the **⬇️ Install App** button in the header
3. Or click the install icon in Chrome's address bar
4. The app installs to your desktop like a native application
5. Works offline after first load

### Setup for New Clients

1. Client opens restopos.store
2. Fills business registration (Name, CR, VAT, Email, Phone)
3. Uploads CR certificate and VAT certificate (optional)
4. Enters license key provided by you
5. Creates username and password
6. Waits for admin approval
7. You approve from restopos-admin.vercel.app
8. Client logs in with their credentials

### Environment Variables

```env
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

### Subscription Plans

| Plan | Price | Features |
|------|-------|----------|
| Basic | SAR 150/mo | Up to 2 users, basic reports |
| Professional | SAR 299/mo | Up to 5 users, advanced reports, custom invoice |
| Premium | SAR 399/mo | Unlimited users, all features, priority support |

### Support

- 📧 Email: restopos.noreply@gmail.com
- 📞 Phone: +966 53 836 0053
- 💬 WhatsApp: +966 53 836 0053
- 🌐 Website: restopos.store

---

## 🇩🇪 Deutsch

### Was ist RestoPOS?

RestoPOS ist ein vollständiges, cloudbasiertes Kassensystem (Point of Sale) für Restaurants, das speziell für den saudi-arabischen Markt entwickelt wurde. Es erfüllt vollständig die ZATCA Phase 2 Anforderungen für elektronische Rechnungsstellung und funktioniert als Progressive Web App — direkt aus Chrome auf jedem PC, Tablet oder Mobilgerät installierbar.

### Hauptfunktionen

**Point of Sale**
- Schnelle Artikelsuche und Kategoriefilterung
- Bestelltypen: Im Restaurant, Mitnahme und Lieferung
- Tischverwaltung mit Echtzeit-Status
- Warenkorbverwaltung mit Mengenanpassungen
- Erfassung von Kundendaten (Name, Telefon, Adresse)
- Bestellungen halten und später abrufen
- KOT-Druck (Küchenbestellzettel)

**Zahlungen**
- Bargeld mit Wechselgeldberechnung und Schnellbetragsschaltflächen
- Karte, Mada, Apple Pay
- Geteilte Zahlung (Bargeld + Karte) mit Validierung
- Gutscheincodes und manuelle Rabatte
- MwSt nach Rabatt berechnet (ZATCA-konform)
- Automatisches Öffnen der Kassenschublade bei Barzahlung
- Drucken & Speichern-Schalter bleibt über Rechnungen hinweg erhalten

**ZATCA Phase 2 Konformität**
- UBL 2.1 XML-Rechnungsgenerierung
- TLV QR-Code mit Verkäufername, MwSt, Zeitstempel, Gesamtbetrag
- SHA-256 Hash-Kette verbindet alle Rechnungen
- Sequenzieller ICV-Zähler
- FATOORA-Warteschlangenverwaltung
- MwSt-Dashboard mit Einreichungsverfolgung

**Druck**
- Doppelte ESC/POS-Thermodrucker-Unterstützung (Kasse + Küche)
- Automatische Verbindung zu zuvor genehmigten USB-Druckern
- Automatischer Schnitt nach jeder Quittung und jedem KOT
- Benutzerdefinierte Quittungsvorlagen (Modern, Klassisch, Minimal, Arabisch RTL)

**Berichte & Analysen**
- Tägliche, wöchentliche, monatliche Verkaufsberichte
- Aufschlüsselung nach Kategorien und Artikeln
- Excel-Export mit arabischer Textunterstützung
- Tagesabschluss-Zusammenfassung mit A4 PDF und Thermodruck
- Kalender-Datumsvoreinstellungen

**Cloud & Offline**
- Automatische Synchronisierung aller Daten mit Firebase Firestore alle 3 Sekunden
- Vollständige Datenwiederherstellung bei neuem Gerät
- Funktioniert vollständig offline
- Synchronisiert mit der Cloud, wenn die Internetverbindung wiederhergestellt wird
- Monatliche Verkaufsarchivierung — unbegrenzte Rechnungshistorie

**Mehrsprachigkeit**
- Vollständige englische Benutzeroberfläche
- Vollständige arabische Benutzeroberfläche mit RTL-Layout
- Automatische Übersetzung von Menüpunktnamen
- Zweisprachige Quittungen

**Sicherheit**
- Lizenzschlüsselaktivierung mit Admin-Genehmigung
- Benutzername + Passwort-Anmeldung mit bcrypt-Hashing
- E-Mail-Verifizierung mit 6-stelligem Code
- Passwort-Zurücksetzen per E-Mail
- Ratenbegrenzung — 5 fehlgeschlagene Versuche sperren für 5 Minuten

### Technologie-Stack

| Ebene | Technologie |
|-------|------------|
| Frontend | React 18, Vite 5 |
| Datenbank | Firebase Firestore |
| Speicher | Firebase Storage |
| Authentifizierung | Custom (EmailJS + bcrypt) |
| Druck | ESC/POS Web Serial API |
| Offline | Service Worker (Workbox) |
| Hosting | Vercel |
| Domain | restopos.store |

### Installation (PWA)

1. Öffnen Sie [restopos.store](https://restopos.store) in **Google Chrome**
2. Klicken Sie auf die Schaltfläche **⬇️ App installieren** in der Kopfzeile
3. Oder klicken Sie auf das Installationssymbol in der Adressleiste von Chrome
4. Die App wird wie eine native Anwendung auf Ihrem Desktop installiert
5. Funktioniert nach dem ersten Laden offline

### Einrichtung für neue Kunden

1. Kunde öffnet restopos.store
2. Füllt die Unternehmensregistrierung aus (Name, CR, MwSt, E-Mail, Telefon)
3. Lädt CR-Zertifikat und MwSt-Zertifikat hoch (optional)
4. Gibt den von Ihnen bereitgestellten Lizenzschlüssel ein
5. Erstellt Benutzername und Passwort
6. Wartet auf Admin-Genehmigung
7. Sie genehmigen von restopos-admin.vercel.app
8. Kunde meldet sich mit seinen Anmeldedaten an

### Abonnementpläne

| Plan | Preis | Funktionen |
|------|-------|-----------|
| Basic | SAR 150/Monat | Bis zu 2 Benutzer, Grundberichte |
| Professional | SAR 299/Monat | Bis zu 5 Benutzer, erweiterte Berichte |
| Premium | SAR 399/Monat | Unbegrenzte Benutzer, alle Funktionen |

### Support

- 📧 E-Mail: restopos.noreply@gmail.com
- 📞 Telefon: +966 53 836 0053
- 💬 WhatsApp: +966 53 836 0053
- 🌐 Website: restopos.store

---

## 🇸🇦 العربية

<div dir="rtl">

### ما هو RestoPOS؟

RestoPOS هو نظام نقاط بيع احترافي متكامل ومتصل بالسحابة للمطاعم، مصمم خصيصاً للسوق السعودي. يتوافق بالكامل مع متطلبات المرحلة الثانية من الفوترة الإلكترونية لهيئة الزكاة والضريبة والجمارك (زاتكا)، ويعمل كتطبيق ويب تقدمي (PWA) — قابل للتثبيت على أي جهاز كمبيوتر أو جهاز لوحي أو هاتف مباشرةً من متصفح Chrome.

### المميزات الرئيسية

**نقطة البيع**
- بحث سريع عن الأصناف وتصفية حسب الفئة
- أنواع الطلبات: داخل المطعم، خارجي، توصيل
- إدارة الطاولات مع حالة فورية
- إدارة سلة المشتريات مع تعديل الكميات
- تسجيل بيانات العميل (الاسم، الهاتف، العنوان)
- إيقاف الطلبات واسترجاعها لاحقاً
- طباعة تذكرة المطبخ (KOT)

**المدفوعات**
- نقد مع حساب الباقي وأزرار مبالغ سريعة
- بطاقة، مدى، Apple Pay
- دفع مقسّم (نقد + بطاقة) مع التحقق
- أكواد الخصم والخصومات اليدوية
- احتساب ضريبة القيمة المضافة بعد الخصم (متوافق مع زاتكا)
- فتح درج النقد تلقائياً عند الدفع نقداً
- خيار الطباعة والحفظ يُحفظ عبر الفواتير

**توافق زاتكا المرحلة الثانية**
- توليد فاتورة XML بتنسيق UBL 2.1
- رمز QR بتنسيق TLV يحتوي على اسم البائع والرقم الضريبي والطابع الزمني والإجمالي ومبلغ الضريبة
- سلسلة تجزئة SHA-256 تربط جميع الفواتير
- عداد ICV تسلسلي
- إدارة قائمة انتظار فاتورة
- لوحة مسؤولية ضريبة القيمة المضافة مع تتبع التقديم
- زر الدفع إلى فاتورة (وضع المحاكاة — قم بتكوين CSID للتقديم المباشر)

**الطباعة**
- دعم طابعتين حراريتين ESC/POS (الفاتورة + المطبخ)
- اتصال تلقائي بالطابعات USB المعتمدة مسبقاً
- قص تلقائي بعد كل إيصال وتذكرة مطبخ
- قوالب إيصالات مخصصة (حديث، كلاسيكي، بسيط، عربي RTL)
- محرر تنسيق الفاتورة الكامل مع معاينة مباشرة

**التقارير والتحليلات**
- تقارير المبيعات اليومية والأسبوعية والشهرية
- تفصيل المبيعات حسب الفئة والصنف
- تفصيل طرق الدفع
- تقارير ضريبة القيمة المضافة المحصّلة
- تصدير Excel مع دعم النص العربي
- ملخص إغلاق اليوم مع خيارات طباعة A4 والحراري
- اختصارات التاريخ (اليوم، أمس، هذا الشهر، إلخ)

**السحابة والعمل دون اتصال**
- مزامنة تلقائية لجميع البيانات مع Firebase Firestore كل 3 ثوانٍ
- استعادة كاملة للبيانات عند تسجيل الدخول على جهاز جديد
- يعمل بالكامل دون اتصال — نقطة البيع والطباعة والتقارير
- المزامنة مع السحابة عند استعادة الاتصال بالإنترنت
- أرشفة المبيعات الشهرية — تاريخ فواتير غير محدود

**تعدد اللغات**
- واجهة إنجليزية كاملة
- واجهة عربية كاملة مع تخطيط RTL وخط تجوال
- ترجمة تلقائية لأسماء الأصناف عبر MyMemory API
- إيصالات ثنائية اللغة (أسماء الأصناف بالإنجليزية والعربية)

**الأمان**
- تفعيل مفتاح الترخيص مع موافقة المشرف
- تسجيل دخول بالاسم وكلمة المرور مع تشفير bcrypt
- التحقق من البريد الإلكتروني برمز مكون من 6 أرقام (EmailJS)
- إعادة تعيين كلمة المرور عبر البريد الإلكتروني
- تحديد المعدل — 5 محاولات فاشلة تؤدي إلى القفل لمدة 5 دقائق
- إنهاء الجلسة قسراً وإلغاء التفعيل من لوحة المشرف
- تطبيق انتهاء صلاحية الاشتراك

### المكدس التقني

| الطبقة | التقنية |
|--------|---------|
| الواجهة الأمامية | React 18، Vite 5 |
| قاعدة البيانات | Firebase Firestore |
| التخزين | Firebase Storage |
| المصادقة | مخصص (EmailJS + bcrypt) |
| الطباعة | ESC/POS Web Serial API |
| العمل دون اتصال | Service Worker (Workbox) |
| الاستضافة | Vercel |
| النطاق | restopos.store |

### التثبيت (PWA)

1. افتح [restopos.store](https://restopos.store) في **Google Chrome**
2. انقر على زر **⬇️ تثبيت التطبيق** في الرأس
3. أو انقر على أيقونة التثبيت في شريط عنوان Chrome
4. يتم تثبيت التطبيق على سطح المكتب كتطبيق أصلي
5. يعمل دون اتصال بعد التحميل الأول

### الإعداد للعملاء الجدد

1. يفتح العميل restopos.store
2. يملأ تسجيل الأعمال (الاسم، السجل التجاري، الرقم الضريبي، البريد الإلكتروني، الهاتف)
3. يرفع شهادة السجل التجاري وشهادة تسجيل ضريبة القيمة المضافة (اختياري)
4. يدخل مفتاح الترخيص المقدم منك
5. ينشئ اسم مستخدم وكلمة مرور
6. ينتظر موافقة المشرف
7. تعتمد من restopos-admin.vercel.app
8. يسجل العميل الدخول ببياناته

### خطط الاشتراك

| الخطة | السعر | المميزات |
|-------|-------|---------|
| أساسي | 150 ريال/شهر | حتى مستخدمَين، تقارير أساسية |
| احترافي | 299 ريال/شهر | حتى 5 مستخدمين، تقارير متقدمة |
| مميز | 399 ريال/شهر | مستخدمون غير محدودون، جميع المميزات |

### الدعم

- 📧 البريد الإلكتروني: restopos.noreply@gmail.com
- 📞 الهاتف: 0053 836 53 966+
- 💬 واتساب: 0053 836 53 966+
- 🌐 الموقع: restopos.store

</div>

---

## 📁 Repository Structure

```
restopos-zatca-updated/
├── src/
│   ├── App.jsx          # Main application (7400+ lines)
│   └── main.jsx         # React entry point
├── public/
│   ├── pwa-192x192.png  # PWA icon
│   └── pwa-512x512.png  # PWA icon large
├── index.html           # HTML entry point
├── vite.config.js       # Vite + PWA configuration
├── package.json         # Dependencies
└── README.md            # This file
```

---

## 📄 License

This is proprietary commercial software. All rights reserved.
© 2026 RestoPOS — restopos.store

For licensing inquiries contact: restopos.noreply@gmail.com

---

<div align="center">
Made with ❤️ for Saudi restaurants · صُنع بـ ❤️ للمطاعم السعودية
<br/>
<strong>restopos.store</strong>
</div>
