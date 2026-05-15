# HFM Report — Internal Tool

เว็บไซต์ภายในสำหรับ Export รายงาน Client Performance จาก HFM Affiliates API เป็น Excel (.xlsx) แบบรายสัปดาห์

## Stack

- **Runtime:** Bun
- **Framework:** Hono (HTML template, no frontend framework)
- **Excel:** SheetJS (xlsx)
- **Session:** HMAC-signed cookie (Web Crypto API)

---

## Local Development

```bash
# 1. Clone / copy project
cd hfm-report

# 2. Install dependencies
bun install

# 3. Setup environment
cp .env.example .env
# Edit .env — set ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET

# 4. Run dev server (with hot reload)
bun dev

# Open http://localhost:3000
```

---

## Production Deployment (Docker / DigitalOcean)

### 1. Prepare .env

```bash
cp .env.example .env
nano .env
```

Set these values:
```
ADMIN_USERNAME=your_username
ADMIN_PASSWORD=strong_password_here
SESSION_SECRET=$(openssl rand -base64 32)
PORT=3000
```

### 2. Build & Run with Docker Compose

```bash
docker compose up -d --build
```

Check logs:
```bash
docker compose logs -f hfm-report
```

### 3. Nginx Reverse Proxy (optional, recommended)

```nginx
server {
    listen 80;
    server_name report.yourdomain.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

---

## Usage Flow

1. Login with `ADMIN_USERNAME` / `ADMIN_PASSWORD`
2. กรอก **Wallet ID** + **Password** (HFM account credentials)
3. เลือก **ช่วงวันที่** — กดปุ่ม "สัปดาห์นี้" / "สัปดาห์ที่แล้ว" หรือเลือกวันเองแล้วระบบจะ snap ไปที่จันทร์–อาทิตย์อัตโนมัติ
4. กด **Export to Excel** → ไฟล์ `.xlsx` จะถูกดาวน์โหลดทันที

### คอลัมน์ใน Excel

| Column | Source field |
|--------|-------------|
| Wallet ID | `client_id` |
| Account ID | `account_id` |
| Account Type | `account_type` |
| Trading Lots | `volume` |

---

## API Flow

```
POST /api/auth/key          { wallet_id, password }  →  { api_key }
GET  /api/performance/client-performance
       ?from_date=YYYY-MM-DDTHH:MM:SS
       &to_date=YYYY-MM-DDTHH:MM:SS
     Authorization: Bearer <api_key>
     → { clients: [...], totals: {...} }
```

Session expires after **8 hours**.
