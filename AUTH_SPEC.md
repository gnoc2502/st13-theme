# Auth & Security Spec — Theme Backend Admin

Doc dành riêng cho phần authentication + security của admin UI. Bổ sung cho `SPEC.md`.

Reference implementation đã có sẵn trong repo này (`server.js`, `cli.js`, `public/login.html`). BE dev khi port sang Postgres/production chỉ cần đổi driver + host, giữ nguyên logic auth.

---

## 1. Threat model — chống ai, chống cái gì

| Threat | Impact nếu không chống | Biện pháp |
|---|---|---|
| **Bot brute-force password** | Ai cũng có thể vào admin trong giờ | Rate limit login 5 lần/15 phút/IP + bcrypt cost 12 |
| **Password rò từ DB dump** | Attacker crack password → login | Bcrypt hash (không lưu plaintext), cost cao |
| **Session hijack qua XSS** | Attacker chèn JS → đánh cắp cookie → giả mạo admin | Cookie `HttpOnly` (JS không đọc được), CSP header |
| **Session hijack qua network sniff** | Man-in-the-middle đọc cookie | `Secure` flag + HTTPS bắt buộc trong production |
| **CSRF (Cross-Site Request Forgery)** | Web A xui browser POST tới admin | Cookie `SameSite=Strict` — browser không gửi cookie khi request cross-origin |
| **Session cookie leak qua URL** | Log server / analytics ghi lại | Không đặt session token trong URL, chỉ cookie |
| **Compromised admin không revoke được** | Admin bị đuổi việc vẫn login được | Session lưu DB → delete row = force logout ngay |
| **DB rò lộ session token** | Attacker có DB dump → giả session | Session token là random 32-byte + HMAC signature. DB dump không có SESSION_SECRET → không tạo được token mới |
| **API abuse (spam PATCH/DELETE)** | Xoá theme hàng loạt | Global rate limit 100 req/phút/IP trên `/admin/*` |
| **Timing attack password check** | Đo thời gian response → đoán được email đúng/sai | `bcrypt.compare` là constant-time |

**Ngoài phạm vi (chấp nhận rủi ro):**

- Physical device compromise (attacker có laptop của designer) — không phòng được, dùng screen lock
- Malicious admin insider — 1 designer thân tín, không lo
- Nation-state attacker — không phải target

---

## 2. Design chọn — MVP cho 1 designer

| Component | Chọn | Lý do KHÔNG chọn alt |
|---|---|---|
| **Login mechanism** | Email + password | OAuth/Google login: 1 designer không worth phức tạp |
| **Password hash** | `bcrypt` cost 12 | Argon2 tốt hơn nhưng bcrypt native support Node, đủ an toàn tới 2030+ |
| **Session storage** | DB (SQLite/Postgres) | JWT: khó revoke, cần rotate secret; DB session revoke instant |
| **Session transport** | HttpOnly Cookie | localStorage: bị XSS đọc được; Authorization header: cần state trong JS |
| **CSRF protection** | Cookie `SameSite=Strict` | Token CSRF: overkill khi có SameSite; SameSite=Strict = same protection với 0 code |
| **2FA** | KHÔNG (MVP) | Chỉ 1 designer, overkill. Nếu >3 admin nên bật TOTP |
| **Signup form** | KHÔNG | Admin tạo qua CLI (`node cli.js add-admin`) — không expose signup endpoint |
| **Password reset qua email** | KHÔNG (MVP) | Chỉ 1 admin — nếu quên password thì bạn tự reset qua CLI. Nếu >3 admin cần SMTP + magic link |
| **HTTPS** | Required in production | Không thảo luận — cleartext production = fail |

---

## 3. Password rules

**Minimum:**
- Length ≥ **10 chars** (chống brute force qua network — 10 chars mixed = 62^10 = ~800 nghìn tỷ tổ hợp)
- KHÔNG check strength complex (chữ hoa/số/ký tự đặc biệt) — nghiên cứu cho thấy user tạo password yếu như `Passw0rd!` thoả rule
- KHÔNG force rotate định kỳ — NIST 2017 khuyến cáo bỏ, chỉ rotate khi nghi ngờ leak

**Storage:**

```javascript
const bcrypt = require('bcrypt');
const BCRYPT_COST = 12;   // ~250ms/hash trên Mac M-series 2024 → attacker crack chậm

// Lưu
const hash = bcrypt.hashSync(password, BCRYPT_COST);
db.run('INSERT INTO admin_users (email, password_hash) VALUES (?, ?)', email, hash);

// Verify (constant-time, chống timing attack)
const row = db.get('SELECT password_hash FROM admin_users WHERE email = ?', email);
const valid = row ? bcrypt.compareSync(password, row.password_hash) : false;
```

**Không bao giờ log password** — kể cả `console.log(req.body)` cũng có thể leak. Redact trước khi log.

---

## 4. Session design

### 4.1 Token format

```
<random-32-byte-hex>.<hmac-sha256-signature>
```

- **Random 32 bytes** = 256 bits entropy → không đoán được
- **HMAC signature** dùng `SESSION_SECRET` (env var) → attacker có DB dump không tạo được token mới

Tạo:

```javascript
const raw = crypto.randomBytes(32).toString('hex');
const sig = crypto.createHmac('sha256', SESSION_SECRET).update(raw).digest('hex');
const token = `${raw}.${sig}`;
```

Verify:

```javascript
const [raw, sig] = token.split('.', 2);
const expected = crypto.createHmac('sha256', SESSION_SECRET).update(raw).digest('hex');
if (expected !== sig) return null;   // token tampered or bad secret
// Sau đó check DB xem token còn active không
```

### 4.2 Cookie config

```javascript
res.cookie('theme_admin_session', token, {
  httpOnly: true,                                          // JS không đọc được
  secure: process.env.NODE_ENV === 'production',           // HTTPS only trong prod
  sameSite: 'strict',                                      // chống CSRF
  maxAge: 7 * 24 * 60 * 60 * 1000,                         // 7 ngày
  path: '/',
});
```

**Lưu ý:**

- `sameSite: 'strict'` — cookie KHÔNG gửi khi user click link từ site khác. Nếu muốn "click link email → auto login": dùng `'lax'`. Với admin UI, `'strict'` an toàn hơn.
- `secure: true` bắt buộc trong production. Local dev = false để test qua `http://localhost`.

### 4.3 Session TTL

| Setting | Value | Lý do |
|---|---|---|
| **Absolute expiry** | 7 ngày | Balance security ↔ UX. Designer không phải login mỗi ngày. |
| **Idle expiry** | KHÔNG (MVP) | Complexity thêm, 7 ngày absolute là đủ |
| **Renew on activity** | KHÔNG (MVP) | Session cứng 7 ngày → dễ audit |

Muốn stricter: giảm xuống 24h + implement renew (extend expires_at khi user active).

### 4.4 Revoke session

```javascript
// Logout user hiện tại
db.run('DELETE FROM admin_sessions WHERE token = ?', currentToken);

// Force logout TOÀN BỘ session của 1 admin (khi đổi password, hoặc admin bị compromise)
db.run('DELETE FROM admin_sessions WHERE email = ?', email);

// Force logout TẤT CẢ (rotate SESSION_SECRET, deploy)
// → tất cả HMAC signature cũ invalid → mọi cookie fail verify → user phải login lại
```

### 4.5 Housekeeping

Cron mỗi giờ:

```javascript
setInterval(() => {
  db.run('DELETE FROM admin_sessions WHERE expires_at < ?', Date.now());
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  db.run('DELETE FROM admin_login_attempts WHERE at < ?', cutoff);
}, 60 * 60 * 1000);
```

---

## 5. Rate limiting

Dùng `express-rate-limit` (đơn giản, in-memory) cho MVP. Production scale nhiều instance → dùng Redis backend.

### 5.1 Login endpoint

```javascript
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,     // 15 phút
  max: 5,                        // 5 lần thử / IP / window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});
app.post('/auth/login', loginLimiter, ...);
```

**Chống bypass:**
- `app.set('trust proxy', 1)` — cần bật để `req.ip` là IP thật của client (không phải IP của reverse proxy/Cloudflare). Nếu không bật → rate limit theo IP proxy = 1 IP duy nhất = mọi user bị block.

### 5.2 Global admin rate limit

```javascript
const adminLimiter = rateLimit({ windowMs: 60 * 1000, max: 100 });
app.use('/admin', adminLimiter, requireAuth);
```

100 req/phút/IP là comfortable cho 1 designer thao tác, chặn bot spam.

### 5.3 Track login attempts trong DB (audit)

Ngoài rate limiter (in-memory), lưu attempt vào DB để **audit sau incident**:

```sql
CREATE TABLE admin_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  success INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts_ip_at ON admin_login_attempts(ip, at);
```

Query khi thấy dấu hiệu tấn công:

```sql
SELECT ip, COUNT(*) as attempts
FROM admin_login_attempts
WHERE at > (unixepoch() - 3600) * 1000 AND success = 0
GROUP BY ip HAVING attempts >= 3
ORDER BY attempts DESC;
```

---

## 6. Middleware `requireAuth`

Guard mọi endpoint admin. Behavior:

- Có session hợp lệ → next()
- Không session hoặc expired:
  - Request là **API call** (URL bắt đầu `/admin/`, có `Accept: application/json`, hoặc `X-Requested-With: XMLHttpRequest`) → **401 JSON** để client tự xử lý
  - Request là **HTML page** (browser mở URL trực tiếp) → **302 redirect** tới `/login.html`

```javascript
function requireAuth(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  const session = verifyAndTouchSession(token);
  if (!session) {
    const isApi = req.originalUrl.startsWith('/admin/')
      || req.headers.accept?.includes('application/json')
      || req.headers['x-requested-with'] === 'XMLHttpRequest';
    if (isApi) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/login.html');
  }
  req.adminEmail = session.email;   // để endpoint downstream biết ai đang gọi
  next();
}
```

Client-side (admin.html) intercept fetch để auto-redirect khi session expire giữa chừng:

```javascript
const origFetch = window.fetch;
window.fetch = async (...args) => {
  const res = await origFetch(...args);
  if (res.status === 401 && !args[0].includes('/auth/')) {
    location.href = '/login.html';
  }
  return res;
};
```

---

## 7. Endpoint list

| Method | Path | Auth | Rate limit | Mục đích |
|---|---|---|---|---|
| GET | `/manifest` | ❌ public | none | App fetch (Android client) |
| GET | `/files/*` | ❌ public | none | Serve bundle/preview file (local prototype only) |
| GET | `/login.html` | ❌ public | none | Login page HTML |
| POST | `/auth/login` | ❌ public | 5/15min/IP | Xác thực + set cookie |
| POST | `/auth/logout` | any | none | Xoá cookie + delete session row |
| GET | `/auth/me` | any | none | Return current admin email (401 nếu chưa auth) |
| POST | `/auth/change-password` | ✅ required | 100/min/IP | Đổi password + invalidate other sessions |
| GET | `/admin.html` | ✅ required | none | Admin UI page |
| GET | `/admin/themes` | ✅ required | 100/min/IP | List themes |
| POST | `/admin/upload` | ✅ required | 100/min/IP | Upload new theme |
| PATCH | `/admin/themes/:id` | ✅ required | 100/min/IP | Edit fields |
| DELETE | `/admin/themes/:id` | ✅ required | 100/min/IP | Soft delete |
| POST | `/admin/themes/:id/restore` | ✅ required | 100/min/IP | Un-soft-delete |

---

## 8. Admin management — CLI tool

**Không có endpoint HTTP** cho add/remove admin — chỉ qua CLI trên server. Lý do: tránh accidentally expose signup, và giảm bề mặt tấn công.

```bash
node cli.js add-admin designer@example.com
# prompts password (hidden input) → bcrypt hash → insert DB

node cli.js reset-password admin@example.com
# reset + auto revoke all sessions của user đó

node cli.js list-admins
# in bảng: email, created_at, last_login_at

node cli.js remove-admin ex-designer@example.com
# xoá admin + xoá session (CASCADE)
```

Reference impl xem `cli.js` trong repo này (~90 dòng).

---

## 9. Deployment checklist

Trước khi deploy production:

- [ ] Đổi `SESSION_SECRET` sang random 64 hex chars: `openssl rand -hex 32`
- [ ] Không dùng seed `ADMIN_INITIAL_PASSWORD` yếu như "admin123" — set password ≥ 12 chars random
- [ ] Set `NODE_ENV=production` (kích hoạt cookie `Secure` flag)
- [ ] Ensure serving qua HTTPS (host provider tự lo: Fly.io, Railway, Vercel đều default TLS)
- [ ] `app.set('trust proxy', 1)` NẾU deploy sau reverse proxy (Cloudflare, nginx). Bỏ nếu direct.
- [ ] Bật CSP header:
  ```javascript
  app.use((req, res, next) => {
    res.set('Content-Security-Policy',
      "default-src 'self'; " +
      "img-src 'self' https://*.b-cdn.net data:; " +
      "script-src 'self' 'unsafe-inline'; " +   // 'unsafe-inline' vì admin.html có inline script; strip nếu tách JS ra file riêng
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self';");
    next();
  });
  ```
- [ ] Bật security headers khác qua `helmet`:
  ```javascript
  const helmet = require('helmet');
  app.use(helmet({ contentSecurityPolicy: false })); // CSP set manually above
  ```
- [ ] Log rotation cho stdout/stderr (host provider thường tự lo)
- [ ] Backup DB định kỳ (bao gồm admin_users + admin_sessions)
- [ ] Không commit `.env` (đã có trong `.gitignore`)
- [ ] Kiểm tra SSH access server chỉ cho ops team, không dùng root password

---

## 10. Incident response

### Khi nghi ngờ admin bị compromise

```bash
# 1. Force logout admin đó
node cli.js reset-password compromised@example.com
# → user phải đăng nhập lại, cookie cũ invalid

# 2. Check log attempts
sqlite3 data/themes.db "SELECT * FROM admin_login_attempts WHERE email='compromised@example.com' ORDER BY at DESC LIMIT 20"

# 3. Nếu confirm compromise: rotate SESSION_SECRET
openssl rand -hex 32 > new_secret.txt
# Update .env, restart server → tất cả session cũ invalid, mọi admin phải login lại
```

### Khi phát hiện brute-force

```bash
# 1. Xem IP nào brute force nhiều
sqlite3 data/themes.db "SELECT ip, COUNT(*) FROM admin_login_attempts WHERE success=0 AND at > (unixepoch()-3600)*1000 GROUP BY ip ORDER BY 2 DESC"

# 2. Block IP tại reverse proxy (Cloudflare rule) — express-rate-limit đã tự block 15 phút
# nhưng attacker có thể rotate IP → cần block tại upstream
```

### Khi database rò

- Password hash bcrypt cost 12 → attacker crack ~1 password/vài giờ trên GPU. Vẫn cần ép user reset:
  ```bash
  node cli.js reset-password <email>  # cho từng admin
  ```
- Session token: nếu attacker CÓ CẢ `SESSION_SECRET` (không nên xảy ra vì secret không nằm trong DB) → rotate secret ngay
- Nếu attacker CHỈ có DB dump: session token cũ vẫn valid với secret cũ → rotate secret để invalidate

---

## 11. Test criteria (BE dev tự verify)

Chạy tất cả các case sau, expect kết quả đúng:

| # | Test | Expected |
|---|---|---|
| 1 | GET `/admin.html` chưa login | 302 → `/login.html` |
| 2 | GET `/admin/themes` chưa login | 401 JSON |
| 3 | POST `/auth/login` với password sai | 401 JSON, KHÔNG set cookie |
| 4 | POST `/auth/login` × 6 lần liên tiếp | Lần 6 trả 429 (rate limit) |
| 5 | POST `/auth/login` đúng | 200, Set-Cookie có `HttpOnly` + `SameSite=Strict` |
| 6 | GET `/admin/themes` với cookie | 200, JSON array |
| 7 | GET `/manifest` (không cookie) | 200 (public) |
| 8 | POST `/auth/logout` | 200, cookie cleared |
| 9 | GET `/admin/themes` sau logout | 401 |
| 10 | Modify cookie value bằng tay (tamper sig) | requireAuth reject → 401 |
| 11 | Wait 8 ngày, GET `/admin/themes` | 401 (session expired) |
| 12 | POST `/auth/change-password` | 200, sessions khác của cùng admin bị xoá |
| 13 | CLI: `node cli.js add-admin foo@x.com` | Insert row, verify bằng list-admins |
| 14 | CLI: `node cli.js remove-admin foo@x.com` | Delete row + cascade delete sessions |
| 15 | Rate limit response có header `RateLimit-*` | Yes (standardHeaders: true) |

---

## 12. Tương lai (roadmap khi >3 admin)

Khi team scale, cân nhắc:

1. **TOTP 2FA** — mỗi login yêu cầu code từ Google Authenticator. Dùng `speakeasy` library.
2. **Password reset qua email** — SMTP + magic link expire 1 giờ.
3. **Role-based access** — không phải mọi admin đều được delete theme. Thêm cột `role` (owner/editor/viewer).
4. **SSO qua Google Workspace / GitHub** — dùng Passport.js.
5. **Session store scale** — chuyển từ SQLite/Postgres sang Redis nếu >10K session active.
6. **Audit log endpoint level** — bảng `admin_audit_log` ghi lại "ai gọi endpoint nào lúc nào với payload gì".
7. **IP whitelist** — chỉ cho login từ office IP.
8. **WebAuthn / Passkey** — thay thế password bằng biometric (Touch ID / Windows Hello). Tương lai của auth.

---

## 13. Reference implementation

Tất cả concept trên đã được implement trong repo này:

- **`server.js`** — express + bcrypt + cookie session + rate limit
- **`cli.js`** — admin management CLI
- **`public/login.html`** — login page
- **`public/admin.html`** — admin UI (auto-redirect 401 → login)
- **`.env.example`** — env vars needed
- **`data/themes.db`** — SQLite (production: swap Postgres)

BE dev có thể:
1. Chạy `node server.js` để hiểu behavior thực tế
2. Copy toàn bộ auth logic sang codebase production
3. Chỉ đổi database driver (SQLite → pg/prisma/drizzle) — schema + queries tương thích 95%
