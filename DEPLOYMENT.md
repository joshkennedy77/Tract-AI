# Deploying Trak AI (Vercel + Railway)

Trak is split into two deployable parts:

| Piece | Host | Why |
| --- | --- | --- |
| **Frontend** (`frontend/`) | **Vercel** | Static Vite build |
| **API** (`backend/server.js`) | **Railway** | Long-running Express; audits can take many minutes |

Local dev stays the same: `npm run dev` (port 3000) + `npm run api` (port 3001).

---

## 1. Deploy the API on Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → select this repository.
2. **Settings → Deploy**
   - **Root Directory:** leave empty (repo root).
   - **Start Command:** `npm start` or `node backend/server.js`
   - Railway sets `PORT` automatically; do not hard-code it.
3. **Settings → Networking** → **Generate Domain** (e.g. `https://tract-api-production.up.railway.app`).
4. **Variables** — add these (copy values from your local `.env`):

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `NODE_ENV` | recommended | `production` (binds API to `0.0.0.0`) |
   | `OPENAI_API_KEY` | yes | AEO judge + OpenAI scans |
   | `ANTHROPIC_API_KEY` | yes | Claude scans |
   | `GEMINI_API_KEY` | yes | Gemini scans |
   | `GEMINI_GROUNDING` | recommended | `true` for GEO citations |
   | `PERPLEXITY_API_KEY` | optional | Perplexity scans |
   | `SUPABASE_URL` | yes | |
   | `SUPABASE_SERVICE_ROLE_KEY` | yes | Server writes; bypasses RLS |
   | `SUPABASE_ANON_KEY` | fallback | Only if service role missing |
   | `PERSIST_SCANS` | yes | `true` to save audits to Supabase |
   | `ALLOWED_ORIGINS` | recommended | Your Vercel URL, e.g. `https://your-app.vercel.app` |

   CORS also allows `http://localhost:3000` and any `*.vercel.app` preview URL automatically.

5. **Smoke test** (replace with your Railway domain):

   ```bash
   curl https://YOUR-API.up.railway.app/api/health
   ```

   Expected: `{"ok":true,"service":"tract-api"}`

---

## 2. Deploy the frontend on Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project** → import the same GitHub repo.
2. **Root Directory:** `frontend` ← important (so `vite` installs and builds correctly).
3. Vercel should detect `frontend/vercel.json` (framework: Vite, output: `dist`).
4. **Environment Variables** (Production + Preview):

   | Variable | Value |
   | --- | --- |
   | `VITE_SUPABASE_URL` | Same as Supabase project URL |
   | `VITE_SUPABASE_ANON_KEY` | Supabase **anon** / publishable key (safe in browser) |
   | `VITE_API_URL` | Your Railway URL, **no trailing slash**, e.g. `https://tract-api-production.up.railway.app` |

5. Deploy. Open the Vercel URL and sign in.

The frontend calls `VITE_API_URL + /api/...` in production (see `frontend/src/app.js`). Locally, leave `VITE_API_URL` unset and use the Vite proxy on port 3000.

---

## 3. Supabase Auth (redirect URLs)

In **Supabase Dashboard → Authentication → URL Configuration**:

**Site URL** (optional): your production Vercel URL, e.g. `https://your-app.vercel.app`

**Redirect URLs** — add all of these:

```
http://localhost:3000
http://localhost:3000/
https://your-app.vercel.app
https://your-app.vercel.app/
```

For preview deployments, either add each preview URL or rely on the wildcard pattern your project allows. Password-reset emails use `redirectTo` = your app origin; the URL must be in this list.

---

## 4. End-to-end checklist

- [ ] `curl https://YOUR-API.up.railway.app/api/health` returns OK
- [ ] Vercel site loads; sign-in works
- [ ] Browser Network tab: `/api/auth/me` hits Railway (not HTML 404 from Vercel)
- [ ] Run a small audit (1 brand, 1 engine) from **Run Audit**
- [ ] **Test Results** updates; with `PERSIST_SCANS=true`, rows appear in Supabase `scans` table
- [ ] Forgot-password email link opens your Vercel URL and completes reset

---

## 5. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Vercel build: `vite: command not found` | Root Directory not set to `frontend` |
| API 502 on Railway | API bound to `127.0.0.1` only — use latest `server.js` (`0.0.0.0` in production) |
| Browser: CORS error | Set `ALLOWED_ORIGINS` to your exact Vercel URL; redeploy API |
| Browser: HTML instead of JSON from `/api` | `VITE_API_URL` missing or wrong — redeploy Vercel after fixing |
| Scans don’t persist | `PERSIST_SCANS=true` on Railway + `SUPABASE_SERVICE_ROLE_KEY` set |
| Audit times out in browser | Normal for large runs; Railway allows long requests. Vercel **cannot** host the scan API as serverless. |

---

## 6. Changing the API URL later

1. Update `VITE_API_URL` in Vercel → redeploy frontend.
2. Update `ALLOWED_ORIGINS` on Railway if you use a new Vercel domain.

No code changes required if only the hostnames change.
