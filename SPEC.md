# Theme Backend — Production Spec

Backend production cho **iLauncher OS** Android app (`com.ilauncher.oslauncher`). Designer upload theme qua admin UI → app tải on-demand từ CDN.

**Stack:** Node.js + Express + **Postgres** (metadata) + **Cloudflare R2** (file storage, S3-compatible) + R2 public URL (r2.dev subdomain dev / custom domain production).

Doc này dành cho **BE dev** implement production. Auth chi tiết ở `AUTH_SPEC.md`. Local prototype ở chính repo này (`server.js`) là reference behavior — giữ đúng API contract để app hiện tại không phải sửa.

---

## 1. Mục đích & non-goals

**Làm được:**
- Designer upload theme mới **không cần release APK**
- App download on-demand khi user bấm Apply (giảm ~10 MB APK size ban đầu)
- Bump version + unpublish
- Verify integrity qua SHA-256

**Không làm (giai đoạn này):**
- Không IAP — theme unlock qua rewarded ad
- Không user-generated content — chỉ admin upload
- Không region/A-B testing — 1 manifest global
- Không real-time push — app poll manifest khi mở IconThemeActivity

---

## 2. Kiến trúc — 3 layer, 3 vai rõ ràng

```
┌────────────────────┐        ┌─────────────────────────────────┐
│  Designer (web)    │──HTTPS─▶  BE API (Node/Express)          │
│  admin.html        │        │  ├─ Postgres (metadata + auth)  │
│  (login required)  │        │  └─ Upload handler               │
└────────────────────┘        │      ├─ validate zip + SHA-256   │
                              │      ├─ PUT bytes → R2 (S3 API) │
                              │      └─ INSERT metadata → DB    │
                              └─────────────────────────────────┘
                                    │                     │
                       PUT bundle   │                     │ SELECT
                    + preview bytes │                     │ metadata
                              (S3 SDK, sig v4)            │
                                    ▼                     ▼
                       ┌──────────────────────┐  ┌──────────────┐
                       │  Cloudflare R2       │  │  Postgres    │
                       │  bucket: trip-assets │  │  (nguồn sự   │
                       │  (nguồn sự thật cho  │  │  thật cho    │
                       │   file bytes)        │  │  metadata)   │
                       └──────────────────────┘  └──────────────┘
                                    │
                                    │ public read
                                    ▼
                       ┌──────────────────────────────┐
                       │  R2 public URL               │
                       │  Dev: pub-<hash>.r2.dev      │
                       │  Prod: cdn.<your-domain>     │
                       │  → Cloudflare edge global    │
                       └──────────────────────────────┘
                                    │
                                    │ GET bundle.zip / preview
                                    ▼
                       ┌──────────────────────────────┐
                       │  Android app (device)        │
                       │  ThemeRepository.download()  │
                       └──────────────────────────────┘
```

**Phân vai:**

| Layer | Trách nhiệm | KHÔNG chứa |
|---|---|---|
| **R2 (bucket `trip-assets`)** | Bytes của file (bundle.zip, preview.png). Immutable per version. | Không biết theme nào published, isFree, order... |
| **Postgres** | Metadata + pointer (`bundle_path`) trỏ tới object trong R2. Business state: status, isFree, order, deleted_at... | Không lưu bytes. |
| **R2 public URL / custom domain** | Serve file cho app qua Cloudflare edge global (free egress). | Không authoritative. |

**Nguyên tắc:**
- BE **KHÔNG proxy** file traffic. Manifest trả URL public thẳng.
- Object key có `v<n>` → **immutable content pattern** — không cần invalidate cache.
- Đổi metadata (rename, isFree, order) = 1 query DB, **không đụng R2**.
- R2 = **free egress** qua Cloudflare CDN (không tính bandwidth khi app tải). Chỉ tính storage (~$0.015/GB/tháng) + request (Class A rẻ).

---

## 3. Data model — Postgres

### 3.1 `themes` — theme metadata

```sql
CREATE TABLE themes (
    id              TEXT PRIMARY KEY,           -- slug: 'dragon_ball'
    name            TEXT NOT NULL,              -- 'Dragon Ball'
    is_free         BOOLEAN NOT NULL DEFAULT false,
    order_index     INTEGER NOT NULL DEFAULT 999,   -- ASC = lên trước
    bundle_version  INTEGER NOT NULL,           -- auto-bump khi re-upload
    bundle_sha256   TEXT NOT NULL,              -- hex lowercase, 64 chars
    bundle_size     BIGINT NOT NULL,            -- bytes
    bundle_path     TEXT NOT NULL,              -- R2 object key: 'themes/dragon_ball/v3/bundle.zip'
    preview_path    TEXT,                       -- R2 object key: 'themes/dragon_ball/v3/preview.webp'
    min_app_version TEXT NOT NULL DEFAULT '0.0.1',
    status          TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'published', 'unpublished')),
    description     TEXT,                       -- note nội bộ (optional)
    deleted_at      TIMESTAMPTZ,                -- soft delete
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_themes_status_order ON themes(status, order_index) WHERE deleted_at IS NULL;
CREATE INDEX idx_themes_deleted_at ON themes(deleted_at);
```

**Rules:**
- `id`: locked sau upload đầu. Slug từ Name (lowercase, replace non-alphanumeric → `_`). Regex `^[a-z0-9_]+$`.
- `bundle_version`: auto-bump, mỗi lần upload lại cùng `id` = `current + 1`. User không gõ tay.
- `status`: `draft` (chỉ admin thấy) / `published` (app thấy) / `unpublished` (đã public rồi gỡ — app không thấy trong manifest mới, nhưng user đã tải vẫn giữ).
- `bundle_path` / `preview_path`: **object key trong R2 bucket**, không phải URL đầy đủ. Manifest ghép: `<R2_PUBLIC_BASE_URL>/<bundle_path>`.

### 3.2 `admin_users`, `admin_sessions`, `admin_login_attempts`

Auth tables — schema + logic ở `AUTH_SPEC.md` section 4-5. Tóm tắt:

```sql
CREATE TABLE admin_users (
    email         TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,        -- bcrypt cost 12
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE TABLE admin_sessions (
    token       TEXT PRIMARY KEY,       -- '<random32>.<hmac>'
    email       TEXT NOT NULL REFERENCES admin_users(email) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    ip          TEXT,
    user_agent  TEXT
);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);

CREATE TABLE admin_login_attempts (
    id       BIGSERIAL PRIMARY KEY,
    email    TEXT NOT NULL,
    ip       TEXT NOT NULL,
    success  BOOLEAN NOT NULL,
    at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_login_attempts_ip_at ON admin_login_attempts(ip, at);
CREATE INDEX idx_login_attempts_email_at ON admin_login_attempts(email, at);
```

---

## 4. Config — env vars (BẠN ĐIỀN)

Copy sang `.env` production. **KHÔNG commit `.env`.**

### 4.1 Database (Postgres)

```bash
# Format: postgres://<user>:<password>@<host>:<port>/<database>
DATABASE_URL=postgres://st13:<password>@217.217.254.127:5432/st13_theme
DATABASE_SSL=false      # true nếu server bật TLS (Supabase/Neon/Railway)
```

Node driver: `pg` (`db.js` trong repo dùng `Pool` + `withTransaction()` helper).

### 4.2 Cloudflare R2 (S3-compatible)

```bash
R2_ACCOUNT_ID=<cloudflare-account-id>                             # trong URL endpoint
R2_ACCESS_KEY_ID=<từ R2 Dashboard → Manage R2 API Tokens>
R2_SECRET_ACCESS_KEY=<hiển thị 1 lần khi tạo token>
R2_BUCKET=trip-assets                                             # bucket name
R2_PUBLIC_BASE_URL=https://pub-<hash>.r2.dev                      # r2.dev (dev) hoặc custom domain (prod)
```

Endpoint tự build: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`. Node driver: `@aws-sdk/client-s3` (R2 tương thích S3 API v4 sig).

### 4.3 Auth & runtime

```bash
SESSION_SECRET=<64-hex-chars>          # openssl rand -hex 32 — rotate = force logout all
ADMIN_INITIAL_EMAIL=admin@example.com  # seed admin cold-start (nếu admin_users empty)
ADMIN_INITIAL_PASSWORD=<≥12-chars>     # xoá sau khi tạo admin thật qua CLI
NODE_ENV=production                    # bật cookie Secure flag
PORT=8787
```

---

## 5. API contract

Match **chính xác** với prototype để app không phải sửa.

### 5.1 `GET /manifest` — public, no auth

App Android fetch mỗi lần mở IconThemeActivity.

**Response 200:**
```json
{
  "version": 1787641487245,
  "themes": [
    {
      "id": "dragon_ball",
      "name": "Dragon Ball",
      "isFree": false,
      "order": 3,
      "previewUrl": "https://pub-8d557592318143ec8b5fbfbbfa13480d.r2.dev/themes/dragon_ball/v3/preview.webp",
      "bundleUrl":  "https://pub-8d557592318143ec8b5fbfbbfa13480d.r2.dev/themes/dragon_ball/v3/bundle.zip",
      "bundleVersion": 3,
      "bundleSha256": "5496052f6e18c94f0c191a61e9159bdb1b88cc8df9a58b9ada00e38163ecdf28",
      "bundleSize": 1190451,
      "minAppVersion": "0.0.1"
    }
  ]
}
```

**Requirements:**
- Filter: `status = 'published' AND deleted_at IS NULL`
- Sort: `ORDER BY order_index ASC, created_at ASC`
- `version` = `Date.now()` millis
- URL bundle/preview = `${R2_PUBLIC_BASE_URL}/${bundle_path}` (absolute HTTPS)
- Headers:
  - `Cache-Control: public, max-age=3600`
  - `ETag: "<sha-of-response-body>"` — support `If-None-Match` → 304

### 5.2 `POST /admin/upload` — auth required

Upload theme mới hoặc re-upload version mới.

**Request:** `multipart/form-data`

| Field | Kiểu | Bắt buộc | Ghi chú |
|---|---|---|---|
| `id` | text | yes | Regex `^[a-z0-9_]+$`. Locked sau upload đầu. |
| `name` | text | yes | |
| `isFree` | text `"true"`/`"false"` | no (default false) | |
| `order` | integer | no (default 999) | |
| `status` | text | no (default `draft`) | `draft` / `published` |
| `minAppVersion` | text | no (default `0.0.1`) | |
| `bundle` | file (.zip ≤50MB) | yes | Bundle theme |
| `preview` | file (image ≤2MB) | no | Nếu không có → extract từ zip |

**Server flow (thứ tự quan trọng):**

```
1. Parse multipart, validate id regex + bundle exists
2. SELECT bundle_version FROM themes WHERE id = $1
   → newVersion = (current ?? 0) + 1
3. Đọc bundle bytes → compute SHA-256 + size
4. Validate zip structure:
   - Zip hợp lệ (mở được với unzipper/adm-zip)
   - Reject entry name chứa '..' (zip-slip)
   - Có `theme.json` ở root HOẶC trong exactly 1 wrapping folder
   - `theme.json` parse được, có key `name` + `background`
   - File `background` được reference tồn tại trong zip
   - Skip `__MACOSX/`, `.DS_Store`, `._*`
5. Nếu không có preview file → extract preview.webp/png từ zip
6. PUT bundle bytes → R2 key `themes/<id>/v<newVersion>/bundle.zip`  (via S3 SDK)
7. PUT preview bytes → R2 key `themes/<id>/v<newVersion>/preview.<ext>`
   (R2 TRƯỚC, DB SAU — nếu R2 fail, không có row mồ côi trong DB)
8. UPSERT themes (Postgres):
   - INSERT nếu id mới
   - UPDATE nếu id tồn tại — set bundle_version=newVersion, bundle_path=..., ...
9. Retention: xoá version <= newVersion - 3 khỏi R2 (giữ 3 version gần nhất)
10. Trả response
```

**Response 200:**
```json
{
  "ok": true,
  "id": "dragon_ball",
  "bundleVersion": 3,
  "bundleSha256": "5496052f...",
  "bundleSize": 1190451,
  "bundlePath": "themes/dragon_ball/v3/bundle.zip"
}
```

**Order-of-operations quan trọng:**
- **R2 upload xong RỒI mới INSERT DB.** Nếu R2 fail → không có row DB trỏ tới object không tồn tại.
- Nếu R2 OK mà DB fail → có object mồ côi trong bucket. Cleanup job (section 8.2) sẽ quét sau.
- Không cần transaction 2-phase — chấp nhận mồ côi tạm thời, cleanup async.

### 5.3 `PATCH /admin/themes/:id` — auth required

Sửa metadata không cần re-upload. **Không đụng R2.**

**Request:** `application/json`
```json
{
  "status": "published",      // optional: 'draft' | 'published' | 'unpublished'
  "isFree": true,             // optional
  "order": 5,                 // optional
  "name": "Dragon Ball Z",    // optional
  "minAppVersion": "1.2.0"    // optional
}
```

**Response:** `{ "ok": true }`

Chỉ update field có trong body. Reject key ngoài whitelist. Set `updated_at = NOW()`.

### 5.4 `POST /admin/themes/:id/preview` — auth, granular re-upload

Chỉ đổi ảnh preview, giữ nguyên bundle + version.

**Request:** `multipart/form-data`, field `preview` (image ≤2MB)

**Flow:**
1. PUT lên R2 key `themes/<id>/v<current>/preview.<newExt>` (ghi đè)
2. Nếu ext đổi (webp → png) → xoá object preview cũ khỏi R2 + UPDATE `preview_path`
3. Response: `{ ok: true, previewUrl: "..." }`

### 5.5 `POST /admin/themes/:id/bundle` — auth, granular re-upload

Chỉ đổi bundle zip, giữ preview cũ.

**Request:** `multipart/form-data`, field `bundle` (zip ≤50MB)

**Flow:** Y hệt `/admin/upload` nhưng không đổi `id`/`name`. Bump version, copy `preview_path` sang folder v mới (via `CopyObjectCommand` — 1 API call, không tải xuống + upload lại). URL luôn dùng cùng version với bundle.

### 5.6 `GET /admin/themes` — auth required

List toàn bộ (kể cả draft/unpublished, KHÔNG bao gồm trash mặc định).

- `?trash=true` → chỉ trả `deleted_at IS NOT NULL`, order by `deleted_at DESC`.

**Response:** array row DB, snake_case (không map camelCase).

### 5.7 `GET /admin/themes/:id` — auth required

Detail 1 theme + list version còn giữ trên R2 (dùng cho preview modal + version history UI).

**Response:**
```json
{
  "id": "dragon_ball",
  "name": "...",
  ...
  "versions": [
    { "version": 3, "bundlePath": "...", "previewPath": "...", "size": ..., "sha256": "..." },
    { "version": 2, ... }
  ]
}
```

Version list build từ `listObjects('themes/<id>/')` trong `r2.js` (S3 ListObjectsV2 API).

### 5.8 `DELETE /admin/themes/:id` — auth required

**Soft delete (default):**
- `UPDATE themes SET deleted_at = NOW() WHERE id = $1`
- **KHÔNG xoá R2 object** — recover được trong 30 ngày.
- Row biến mất khỏi `/manifest` + `/admin/themes` (trừ `?trash=true`).

**Hard delete: `DELETE /admin/themes/:id?permanent=true`**
- Xoá row DB + **tất cả version** trong R2.
- Không recover được. UI phải confirm 2 lần.

**Auto-purge (cron daily 03:00):**
```sql
-- Lấy list id sắp bị hard delete
SELECT id FROM themes WHERE deleted_at < NOW() - INTERVAL '30 days';
```
Với mỗi id: `listObjects('themes/<id>/')` → `deleteObject()` cho từng key → `DELETE FROM themes WHERE id = ...`.

### 5.9 `POST /admin/themes/:id/restore` — auth required

Un-soft-delete: `UPDATE themes SET deleted_at = NULL, updated_at = NOW()`. Status giữ như trước xoá.

### 5.10 Auth endpoints

Chi tiết ở `AUTH_SPEC.md` section 6-7. Tóm tắt:

| Method | Path | Auth | Rate limit |
|---|---|---|---|
| POST | `/auth/login` | ❌ | 5/15min/IP |
| POST | `/auth/logout` | any | none |
| GET | `/auth/me` | any | none |
| POST | `/auth/change-password` | ✅ | 100/min/IP |
| GET | `/admin.html` | ✅ (redirect login) | none |
| GET | `/login.html` | ❌ | none |

---

## 6. Cloudflare R2 integration

R2 là object storage S3-compatible. BE dùng `@aws-sdk/client-s3` (chuẩn AWS SDK) trỏ vào endpoint R2. Helper wrap có sẵn ở `r2.js`.

### 6.1 Setup — làm 1 lần trên Cloudflare Dashboard

**Bucket:**
- Dashboard → **R2** → **Create bucket**
- Name: `trip-assets`
- Location: chọn Auto (Cloudflare tự pick nearest)

**API Token (Access Key + Secret):**
- R2 → **Manage R2 API Tokens** (góc trên bên phải)
- Create API Token:
  - Token name: `theme-be-upload`
  - Permission: **Object Read & Write**
  - Specify bucket: `trip-assets` (KHÔNG chọn all buckets — giảm blast radius)
  - TTL: forever
- Copy **Access Key ID** + **Secret Access Key** — Secret **chỉ hiện 1 lần**, save cẩn thận.

**Public access:**

R2 bucket mặc định **private**. Chọn 1 trong 2 cách để app tải public:

| Cách | URL | Khi nào dùng |
|---|---|---|
| **r2.dev subdomain** | `https://pub-<hash>.r2.dev/<key>` | Dev/staging. Cloudflare khuyến cáo **không dùng cho production traffic** (có rate limit). Bật ở bucket **Settings → Public access → r2.dev subdomain → Allow Access**. |
| **Custom domain** | `https://cdn.tripcode.com/<key>` | Production. Cần domain trong Cloudflare + DNS routing. **Free bandwidth**, không rate limit. |

### 6.2 S3 API — upload (Node SDK)

```js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

await s3.send(new PutObjectCommand({
  Bucket: 'trip-assets',
  Key: 'themes/dragon_ball/v3/bundle.zip',
  Body: buffer,
  ContentType: 'application/zip',
}));
```

Wrap sẵn ở `r2.js`:
```js
const { uploadObject } = require('./r2');
await uploadObject('themes/dragon_ball/v3/bundle.zip', buffer, 'application/zip');
```

SDK auto retry với exponential backoff + AWS Signature v4. Không cần code retry tay.

### 6.3 S3 API — delete

```js
await s3.send(new DeleteObjectCommand({ Bucket: 'trip-assets', Key }));
```

Wrap ở `r2.js` (`deleteObject`) — idempotent, 404 = OK.

### 6.4 S3 API — list (cleanup + version history)

```js
await s3.send(new ListObjectsV2Command({ Bucket: 'trip-assets', Prefix: 'themes/dragon_ball/' }));
```

Wrap ở `r2.js` (`listObjects`) — tự loop qua `NextContinuationToken` khi >1000 objects.

### 6.5 S3 API — head (verify + get size)

```js
await s3.send(new HeadObjectCommand({ Bucket: 'trip-assets', Key }));
```

Wrap ở `r2.js` (`headObject`) — trả `{ size, contentType, lastModified }` hoặc `null` nếu 404.

### 6.6 Public URL

```
${R2_PUBLIC_BASE_URL}/${bundle_path}
```

Ví dụ với `R2_PUBLIC_BASE_URL=https://pub-8d557592318143ec8b5fbfbbfa13480d.r2.dev` và `bundle_path=themes/dragon_ball/v3/bundle.zip`:
```
https://pub-8d557592318143ec8b5fbfbbfa13480d.r2.dev/themes/dragon_ball/v3/bundle.zip
```

Cloudflare tự cache tại edge global. Miss → pull từ R2; hit → serve từ edge.

### 6.7 Retention policy

Giữ **N=3 version** gần nhất. Sau upload v4, xoá v1 khỏi R2.

Lý do: user có manifest cache cũ có thể vẫn trỏ về v2/v3. Nếu delete quá aggressive → download failed.

Implementation: sau step 8 của upload flow (section 5.2):
```js
const { purgeOldVersions } = require('./r2');
await purgeOldVersions(id, newVersion, 3);  // xoá v <= newVersion-3
```

### 6.8 Cache invalidation

**Không cần.** URL chứa `v<n>` — mỗi version = URL khác. Version cũ vẫn cache OK (không harm), version mới fetch fresh. Immutable content pattern.

Nếu bất khả kháng cần purge cache 1 URL cụ thể: dùng Cloudflare Cache API hoặc dashboard.

### 6.9 Security

- **`R2_SECRET_ACCESS_KEY` không leak ra client.** Chỉ BE giữ. Nếu bị leak → **rotate** ngay (Cloudflare Dashboard → API Tokens → Roll).
- **Token scope theo bucket** — không tạo token all-buckets.
- **Public URL** — anyone có URL đều tải được. OK vì theme unlock qua ad, không phải paywall.
- Nếu sau này có paid theme → dùng **S3 Presigned URL** (`getSignedUrl` từ `@aws-sdk/s3-request-presigner`) sign URL có hạn 1h, hoặc **Cloudflare Access** gate bucket.

### 6.10 Cost model

Cloudflare R2 pricing (2026):
- **Storage:** ~$0.015/GB/tháng
- **Class A (write) operations:** ~$4.50/triệu req (PUT, LIST, COPY)
- **Class B (read) operations:** ~$0.36/triệu req (GET, HEAD)
- **Egress:** **$0** (free — cả qua r2.dev và custom domain)

Ví dụ 100 theme mỗi cái 5MB, 10K user tải mỗi ngày:
- Storage: 500MB × $0.015 = **$0.0075/tháng**
- Egress: 10K × 5MB × 30 ngày = 1.5TB = **$0** (Bunny sẽ tính ~$15/tháng)
- Read ops: 10K × 30 = 300K/tháng = **~$0.11/tháng**
- **Total: ~$0.12/tháng** cho 100 theme + 300K downloads.

---

## 7. Admin UI — features

Reuse `public/admin.html` từ prototype. UI dành cho **1 designer non-technical**.

### 7.1 Nguyên tắc UX bắt buộc

| Nguyên tắc | Áp dụng |
|---|---|
| **Không destroy im lặng** | Confirm dialog cho Delete / Unpublish / Replace. |
| **Undo được** | Delete = soft delete. Recycle bin 30 ngày, restore 1 click. |
| **Preview trước khi publish** | Upload xong hiện modal: theme.json parsed, list icon, preview → confirm mới publish. Draft = default. |
| **Feedback tức thì** | Toast success/error trong <1s. |
| **Progressive disclosure** | Field advanced (minAppVersion, order) ẩn dưới "Advanced". |
| **Không hỏi cái đã biết** | ID auto-slug từ Name. Version auto-bump. Preview auto-extract từ zip. |

### 7.2 Feature checklist

**MUST (bắt buộc):**
- Upload theme (zip + preview + metadata)
- List toàn bộ (bao gồm draft/unpublished)
- Inline edit: status, isFree, order, **name**
- **Re-upload preview riêng** (không đụng bundle)
- **Re-upload bundle riêng** (giữ preview)
- **Soft delete + Recycle Bin + Restore**
- **Confirm dialog** cho destructive action
- **Thumbnail preview trong list**

**SHOULD (2 tuần sau launch nếu cần):**
- Preview modal trước khi publish
- Search / filter theme
- Sort by cột

**NICE (backlog):**
- Sort by column, duplicate theme, version history + rollback, audit log, bulk actions, drag-drop upload.

### 7.3 UI layout (đề xuất)

```
┌─────────────────────────────────────────────────────────────┐
│  Theme Admin                  designer@example.com [Logout]  │
├─────────────────────────────────────────────────────────────┤
│  [+ Upload theme mới]         [🗑️ Recycle Bin (3)]         │
│  🔍 [Search theme...]  Status: [All ▾]  Sort: [Order ▾]    │
│                                                              │
│  ┌────┬─────────┬──────────┬────┬─────┬──────┬───────┬───┐ │
│  │Thumb│ ID     │ Name     │Free│Order│  v   │Status │ ⋯ │ │
│  ├────┼─────────┼──────────┼────┼─────┼──────┼───────┼───┤ │
│  │[🖼]│dragon.. │Dragon Ball│PAID│  3  │  v2  │[Pub▾] │[⋯]│ │
│  └────┴─────────┴──────────┴────┴─────┴──────┴───────┴───┘ │
│                                                              │
│  [⋯]: Edit name / Replace preview / Replace bundle /        │
│       View versions / Duplicate / Move to trash              │
└─────────────────────────────────────────────────────────────┘
```

---

## 8. Ops

### 8.1 Retention

Bundle version: giữ N=3 (section 6.7). Auto-purge soft delete: 30 ngày (section 5.8).

### 8.2 Cleanup mồ côi (weekly cron)

Trường hợp: R2 upload OK mà DB fail → object mồ côi trong bucket.

```js
// Weekly Sunday 04:00
const { listObjects, deleteObject } = require('./r2');
const objects = await listObjects('themes/');
const idsInBucket = new Set(objects.map(o => o.key.split('/')[1]));  // themes/<id>/...
const { rows } = await db.query('SELECT id FROM themes');
const idsInDb = new Set(rows.map(r => r.id));
for (const id of idsInBucket) {
  if (!idsInDb.has(id)) {
    console.warn(`orphan R2 prefix: themes/${id}/ — no matching DB row`);
    // Nếu confirm orphan >7 ngày → deleteObject cho từng key
  }
}
```

### 8.3 Logging (JSON)

```json
{ "ts": "...", "level": "info",  "event": "upload",            "id": "dragon_ball", "version": 3, "sha256": "...", "size": 1190451, "actor": "designer@example.com" }
{ "ts": "...", "level": "info",  "event": "manifest_hit",      "themes_count": 10, "if_none_match": true }
{ "ts": "...", "level": "warn",  "event": "r2_upload_failed",  "id": "...", "reason": "..." }
{ "ts": "...", "level": "warn",  "event": "orphan_r2_prefix",  "prefix": "themes/foo/" }
```

**Không log password / SESSION_SECRET / R2_SECRET_ACCESS_KEY.**

### 8.4 Monitoring

- Uptime BE: BetterUptime / UptimeRobot ping `/manifest` mỗi phút.
- R2 metrics: Cloudflare Dashboard → R2 → Metrics (storage, Class A/B ops, egress).
- Alert nếu 5xx rate > 1% trong 5 phút.

### 8.5 Backup

- Postgres: managed provider auto-backup daily.
- R2: **không có versioning built-in**. Nếu cần backup, mirror sang S3/B2/local qua `rclone` daily cron.

### 8.6 CORS

- `/manifest`: không cần (app native).
- `/admin/*`: chỉ cần nếu admin UI host khác domain BE. Cùng domain → không cần.

---

## 9. Admin management — CLI

**Không có endpoint HTTP** để add admin (tránh expose signup + giảm attack surface). Chỉ CLI trên server:

```bash
node cli.js add-admin designer@example.com       # prompts password, bcrypt hash
node cli.js reset-password admin@example.com     # auto revoke all sessions
node cli.js list-admins
node cli.js remove-admin ex-designer@example.com # cascade delete sessions
```

Reference: `cli.js` trong repo prototype. Port sang Postgres = đổi driver, giữ logic.

---

## 10. Deploy checklist

Trước khi deploy production:

- [ ] `SESSION_SECRET` = `openssl rand -hex 32` (không dùng default)
- [ ] `ADMIN_INITIAL_PASSWORD` ≥ 12 chars random (xoá sau khi tạo admin thật qua CLI)
- [ ] `NODE_ENV=production` (bật cookie Secure flag)
- [ ] `DATABASE_URL` với `DATABASE_SSL=true` nếu managed provider (Supabase/Neon)
- [ ] `R2_SECRET_ACCESS_KEY` không commit + không log
- [ ] `R2_PUBLIC_BASE_URL` — production dùng **custom domain**, không dùng `r2.dev` (có rate limit)
- [ ] R2 API token scope theo bucket cụ thể, không all-buckets
- [ ] HTTPS serving (Fly.io / Railway / Vercel default TLS)
- [ ] `app.set('trust proxy', 1)` nếu sau reverse proxy (Cloudflare, nginx)
- [ ] CSP header + `helmet`:
  ```js
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use((_, res, next) => {
    res.set('Content-Security-Policy',
      "default-src 'self'; " +
      "img-src 'self' https://*.r2.dev https://cdn.tripcode.com data:; " +   // replace domain phù hợp
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self';");
    next();
  });
  ```
- [ ] Rate limit: 5/15min login, 100/min admin (chi tiết `AUTH_SPEC.md` section 5)
- [ ] Cron: retention R2 (mỗi upload), auto-purge soft delete (daily 03:00), cleanup orphan (weekly Sunday 04:00)
- [ ] Backup DB được test restore
- [ ] `.env` trong `.gitignore`
- [ ] Log rotation (host provider tự lo)

---

## 11. Test criteria

### 11.1 Smoke test — full flow

1. `POST /admin/upload` với zip hợp lệ → 200, `bundleVersion=1`, SHA-256 khớp `shasum -a 256`
2. Check R2 (dashboard hoặc `node scripts/test-r2.js`): object tồn tại tại `themes/<id>/v1/bundle.zip`
3. Check DB: row mới với `bundle_path` khớp
4. `GET /manifest` → thấy theme, `bundleUrl` = `<R2_PUBLIC_BASE_URL>/themes/<id>/v1/bundle.zip`
5. `curl <bundleUrl>` → tải zip OK, SHA-256 khớp
6. `PATCH /admin/themes/:id { status: 'draft' }` → 200, DB update, R2 KHÔNG đụng
7. `GET /manifest` → không có theme (status ≠ published)
8. `PATCH ... { status: 'published' }` → thấy lại
9. Re-upload cùng id → `bundleVersion=2`, v2 lên R2, v1 vẫn còn
10. Upload v4 → v1 bị delete khỏi R2 (giữ v2, v3, v4)
11. `DELETE /admin/themes/:id` (soft) → row có `deleted_at`, R2 giữ nguyên
12. `POST /admin/themes/:id/restore` → row hiện lại
13. `DELETE /admin/themes/:id?permanent=true` → row + tất cả version R2 bị xoá

### 11.2 Security test

- Upload zip có entry `../../../etc/passwd` → reject + log warn
- Upload file .png thay .zip → reject
- Upload file 100 MB → reject (max 50 MB)
- `GET /admin/upload` không auth → 401 (API) / redirect login (HTML)
- Basic Auth sai → 401
- `id = "'; DROP TABLE themes;--"` → reject (regex validate)

### 11.3 R2 integration test

Chạy `node scripts/test-r2.js` — smoke test full flow upload/head/list/fetch-public-URL/delete. Kỳ vọng tất cả 6 bước ✓.

Test failure mode:
- Sai `R2_ACCESS_KEY_ID` → SDK báo `InvalidAccessKeyId`
- Sai `R2_SECRET_ACCESS_KEY` → `SignatureDoesNotMatch`
- Bucket chưa tạo → `NoSuchBucket`
- Chưa bật public access → fetch URL trả 401/404 (upload/list vẫn OK)
- Xoá object trực tiếp trên Dashboard → `GET bundleUrl` = 404, manifest vẫn OK (row DB vẫn còn) → cần chạy cleanup job orphan

### 11.4 Auth test

Chi tiết ở `AUTH_SPEC.md` section 11 (15 test cases).

---

## 12. Client contract — KHÔNG ĐƯỢC PHÁ

App Android đang chạy production với contract này. Đổi bất kỳ field nào trong `/manifest` response = phá app cũ.

**Bắt buộc giữ đúng tên + type:**
- `themes[].id` — string
- `themes[].name` — string
- `themes[].isFree` — boolean
- `themes[].order` — int
- `themes[].previewUrl` — string (nullable)
- `themes[].bundleUrl` — string
- `themes[].bundleVersion` — int
- `themes[].bundleSha256` — string (hex lowercase, 64 chars)
- `themes[].bundleSize` — long
- `themes[].minAppVersion` — string

Thêm field mới OK — app parser `ignoreUnknownKeys = true`.

---

## 13. Reference — files trong repo

Code prototype = reference implementation. Production sẽ hoà trộn 2 nhánh (SQLite → Postgres, local files → R2):

| File | Vai trò |
|---|---|
| `server.js` | Express + SQLite + local filesystem — nhánh prototype (sẽ port sang Postgres + R2) |
| `db.js` | **Postgres pool** (`pg`) + `withTransaction()` + `ensureSchema()` chạy DDL section 3 — sẵn để wire |
| `r2.js` | **R2 helper** (`@aws-sdk/client-s3`) — `uploadObject`, `deleteObject`, `headObject`, `listObjects`, `publicUrl`, `purgeOldVersions` — sẵn để wire |
| `bunny.js` | Legacy (Bunny helper) — giữ tạm, xoá sau khi confirm R2 production stable |
| `cli.js` | admin CLI — cần port sang Postgres (`pg` async) |
| `public/admin.html` + `public/login.html` | UI (reuse, mở rộng các MUST còn thiếu) |
| `scripts/test-r2.js` | Smoke test R2 end-to-end |
| `AUTH_SPEC.md` | Auth chi tiết (bổ sung cho section 5.10) |
| `.env.example` | Template env vars — copy sang `.env` (gitignored) |

BE dev có thể `node server.js` để test app hiện tại → hiểu behavior → viết production sao cho request/response tương thích.

**Delta local → production:**

| Local prototype | Production |
|---|---|
| SQLite (`better-sqlite3`) | Postgres (`pg`) via `db.js` |
| `data/uploads/` + `/files/*` static | Cloudflare R2 (`@aws-sdk/client-s3`) via `r2.js` |
| `preview_ext` column | `bundle_path` + `preview_path` columns (object keys) |
| Không có retention | `purgeOldVersions()` sau mỗi upload |
| Không có cleanup mồ côi | Weekly cron quét R2 vs DB |
| Không có auto-purge soft delete | Daily cron 03:00 |
| `SESSION_SECRET` random mỗi restart | Fixed trong env |
| HTTP | HTTPS + CSP + `helmet` |
| Cache HTTP request | Cloudflare edge cache (URL immutable per version) |
