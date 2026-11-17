# TOPGFLEET server

Node.js + Postgres. Bitta servis: sayt ham, API ham shu yerdan beriladi.

## Nima bor
- Haqiqiy login (parol scrypt bilan xeshlanadi), ikki bosqichli kirish (TOTP / Google Authenticator)
- Rollar: `admin`, `member`, `driver` (driver hozircha faqat kelajakdagi ilova uchun, saytga kira olmaydi)
- 5 ta xato urinishdan keyin akkaunt 15 daqiqaga bloklanadi; IP bo'yicha so'rov limiti
- Hamma o'zgarish jamoa uchun umumiy, har 15 soniyada yangilanadi
- Faoliyat jurnali (kim kirdi, kim nimani o'zgartirdi), faqat admin ko'radi
- PDF/JPEG/PNG fayl yuklash (Railway Volume ga yoziladi, kirmagan odam ocholmaydi)
- Xavfsizlik sarlavhalari (CSP, HSTS, X-Frame-Options...), CSRF himoyasi, HTTPS majburiy

## Railway ga qo'yish (qadamma-qadam)

1. **GitHub.** Yangi *private* repo oching (`topgfleet`). Shu papkadagi fayllarni yuklang
   (`node_modules` va `.env` ni yuklamang, `.gitignore` shuni hal qiladi).
2. **Railway → New Project → Deploy from GitHub repo** → `topgfleet` ni tanlang.
3. Project ichida **+ New → Database → Add PostgreSQL**.
4. Server servisini oching → **Variables** → quyidagilarni qo'shing:
   | Nomi | Qiymati |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `APP_SECRET` | 48+ tasodifiy belgi (`openssl rand -base64 48`) |
   | `ADMIN_EMAIL` | sizning e-mail |
   | `ADMIN_PASSWORD` | kuchli parol (kamida 10 belgi) |
   | `ADMIN_NAME` | ismingiz |
   | `DATA_DIR` | `/data` |
5. Server servisida **Settings → Volumes → Add Volume**, mount path: `/data` (yuklangan fayllar shu yerda saqlanadi).
6. **Settings → Networking → Generate Domain**. Chiqqan havolani oching va kiring.
7. **Profil → Akkaunt → Ikki bosqichli kirish → Yoqish.** Kalitni Google Authenticator ga kiriting.
8. Kirish ishlagach, Railway Variables dan **`ADMIN_PASSWORD` ni o'chirib tashlang** (u faqat birinchi marta kerak).
9. **Jamoa:** Profil → Jamoa → Add user (member yoki admin). Birinchi kirishda ular parolni almashtiradi.

### O'z domeningiz
Railway → Settings → Networking → **Custom Domain** → domeningizni kiriting. Railway ko'rsatgan
CNAME yozuvini domen provayderingizning DNS bo'limiga qo'shing. SSL avtomatik.

### Zaxira nusxa
Railway Postgres servisida **Backups** ni yoqing. Qo'shimcha: vaqti-vaqti bilan `pg_dump` oling.
Fayllar (`/data`) ham Volume backups ga kiradi.

## Mahalliy ishga tushirish
```
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/topgfleet
export APP_SECRET=$(openssl rand -base64 48)
export ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='Kuchli-Parol-123'
npm start
```
Sinovlar (o'zi vaqtinchalik Postgres ochadi): avval `npm i --no-save embedded-postgres jsdom`, keyin `npm test` va `npm run test:e2e`.

## Hozirgi cheklovlar (halol ro'yxat)
- 2FA sozlashda QR kod yo'q, kalitni qo'lda kiritiladi (barcha ilovalar buni qo'llaydi).
- Sahifa ichidagi skriptlar uchun CSP `unsafe-inline` ruxsat beradi (sayt bitta HTML fayl). Keyingi bosqichda skriptlarni ajratib, buni olib tashlash mumkin.
- So'rov limiti xotirada, server qayta ishga tushsa nolga tushadi. Bitta server nusxasi uchun mo'ljallangan.
- Ikki kishi bir vaqtda bitta yozuvni o'zgartirsa, oxirgi saqlagan yutadi.
- Fayl yuklash serverda tayyor, lekin saytdagi hujjat/hisob-faktura formalari hali faqat fayl nomini saqlaydi.
- Telegram bot, AI, Samsara/Motive, driver ilovasi: keyingi bosqichlar.
- Hech bir tizim 100% buzilmas emas. Bu qatlamlar odatiy hujumlarni yopadi; parol va 2FA ni to'g'ri saqlash ham muhim.
