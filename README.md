# ComplaintDesk v3.0 — Setup Guide

## What was added / changed

### Frontend (`index.html`)
- **Sign In tab** — existing login flow, unchanged UX
- **Register tab** — new users fill name, email, phone, password (with strength meter & confirm)
- Accounts are saved to `localStorage` so they persist across browser sessions
- After successful registration, users are prompted to Sign In

### Frontend (`user-portal.html`)
- **Per-user complaint isolation** — every data access goes through `myComplaints()` which filters by `owner === currentUser.email`
- The **Track** page now also enforces this: entering another user's CMP-ID returns "not found in your account"
- Complaint data moved from `sessionStorage` → `localStorage` for cross-session persistence

### Backend (`backend.js`)
- Full Node.js / Express REST API
- SQLite database (`complaintdesk.db`) — zero config, file-based
- JWT authentication (7-day tokens)
- bcrypt password hashing (cost factor 10)
- **Isolation enforced at query level**: `WHERE id = ? AND owner_email = ?` — even if a user guesses another CMP-ID, the API returns 404

---

## Running the backend

### 1. Install dependencies
```bash
npm install
```

### 2. Create `.env` (optional but recommended)
```
PORT=3000
JWT_SECRET=replace_with_a_long_random_string
JWT_EXPIRES_IN=7d
```

### 3. Start the server
```bash
npm start          # production
npm run dev        # development (auto-reload with nodemon)
```

The API will be available at `http://localhost:3000`.

---

## API Reference

### Auth

| Method | Endpoint | Body | Auth |
|--------|----------|------|------|
| POST | `/api/auth/register` | `{name, email, phone, password}` | None |
| POST | `/api/auth/login` | `{email, password}` | None |
| GET  | `/api/auth/me` | — | Bearer token |

**Register response:**
```json
{
  "success": true,
  "token": "<JWT>",
  "user": { "id": 1, "name": "Priya Sharma", "email": "priya@example.com", "role": "user" }
}
```

---

### User — Complaints (own only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/complaints` | File a new complaint |
| GET  | `/api/complaints?status=Pending&search=billing&page=1` | List own complaints |
| GET  | `/api/complaints/:id` | View own complaint by ID |

> **Isolation guarantee:** `GET /api/complaints/CMP-004` by a user who does not own CMP-004 returns HTTP 404. The owner field is always taken from the verified JWT — it cannot be submitted or spoofed by the client.

---

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET   | `/api/admin/complaints` | All complaints (with filter/search/page) |
| GET   | `/api/admin/complaints/:id` | Any complaint by ID |
| PATCH | `/api/admin/complaints/:id` | Update `status`, `note`, `priority`, `department` |
| GET   | `/api/admin/stats` | Dashboard totals + category/priority breakdown |
| GET   | `/api/admin/users` | All registered users |

**Update complaint (admin):**
```json
PATCH /api/admin/complaints/CMP-001
{
  "status": "Resolved",
  "note": "Refund processed. Reference: TXN-99887"
}
```

---

## Default admin credentials
```
Email   : admin@complaintdesk.com
Password: admin123
```
Change these immediately in production by updating the seed in `backend.js` or via a DB migration.

---

## Connecting the frontend to the backend

In `index.html` and `user-portal.html`, replace the `localStorage`-based helpers with `fetch()` calls:

```js
// Login example
const res  = await fetch('http://localhost:3000/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
});
const data = await res.json();
if (data.success) {
  sessionStorage.setItem('cd_token', data.token);
  sessionStorage.setItem('cd_user', JSON.stringify(data.user));
  window.location.href = 'user-portal.html';
}

// Fetch own complaints (Authorization header carries identity)
const complaints = await fetch('http://localhost:3000/api/complaints', {
  headers: { Authorization: 'Bearer ' + sessionStorage.getItem('cd_token') }
}).then(r => r.json());
```
