# Indeed Job Filter (AI)

Chrome extension (Manifest V3) that goes through the jobs on a Indeed results page, asks an AI model how well each one fits
**your** resume and rules, and acts on the result directly on the page.

## Install
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Pin the icon. The first click opens the options page (or right-click the icon → Options).
3. Choose an AI provider, paste your API key and your resume (plain text), write your hard criteria
   (see the example and guide at the top of `settings.js`), then press **Save & test API**.

## Privacy
Your API keys, resume and settings are stored only in your browser (`chrome.storage.local`). They are sent only to the AI
provider you choose and are never part of this repository. Do not commit exported settings or resume files (see `.gitignore`).

Technical details: `ARCHITECTURE.md` · history: `CHANGELOG.md`.

---

## راهنمای فارسی

## نصب
1. `chrome://extensions` → Developer mode → **Load unpacked** → پوشه `indeed-job-filter`.
2. آیکون را pin کنید. اولین کلیک صفحه تنظیمات را باز می‌کند (یا راست‌کلیک → Options).
3. سرویس AI، مدل، API Key، رزومه، کلمات کلیدی و معیارها را وارد کنید و **Save & test API** را بزنید.
   (تنظیمات این اکستنشن از اکستنشن لینکدین جداست.)

## استفاده
- در صفحه Indeed (صفحه اصلی «Jobb för dig» یا نتایج جستجو) روی آیکون کلیک کنید.
- کارهای همین صفحه یکی‌یکی باز می‌شوند و روی هر کارت برچسب می‌خورد: سبز = مناسب، قرمز = نامناسب (با امتیاز و دلیل). کارهای مناسب خودکار بوکمارک (Save job 🔖) می‌شوند؛ اکستنشن هیچ‌وقت dislike نمی‌کند.
- پنل: گزارش کلی، دکمه Details برای جزئیات، Stop و ↻ Run again.
- اگر Indeed صفحه امنیتی («Just a moment…») نشان داد، اکستنشن متوقف می‌شود. آن را خودتان رد کنید و Run again بزنید.

جزئیات فنی در `ARCHITECTURE.md` و تاریخچه در `CHANGELOG.md` است.
