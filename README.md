# bugdesk-webhook

Node.js server that handles Stripe webhooks with signature verification.

## Setup

```bash
npm install
```

## Environment

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `STRIPE_SECRET_KEY` | Stripe secret key (sk_...) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret (whsec_...) from Stripe Dashboard → Developers → Webhooks |
| `GHL_API_KEY` | Go High Level API key for creating/updating contacts |

Create a `.env` file (do not commit it) or set these in your environment.

## Run

```bash
npm run dev   # development with --watch
npm start     # production
```

## Endpoints

- **POST /webhook** — Stripe webhook endpoint. Configure this URL in Stripe (e.g. `https://your-host/webhook`). Events are verified with `STRIPE_WEBHOOK_SECRET`; unhandled event types are logged.
- **GET /health** — Health check.

## Local testing with Stripe CLI

```bash
stripe listen --forward-to localhost:3000/webhook
```

Use the printed `whsec_...` as `STRIPE_WEBHOOK_SECRET` when running the server locally.

---

## Deploying on Render

### 1. Push your code to GitHub

Initialize git (if you haven’t), commit, and push to a GitHub repo:

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/bugdesk-webhook.git
git push -u origin main
```

### 2. Create a Web Service on Render

1. Go to [render.com](https://render.com) and sign in (or sign up with GitHub).
2. Click **Dashboard** → **New** → **Web Service**.
3. Connect your GitHub account if needed, then select the **bugdesk-webhook** repository.
4. Use these settings:
   - **Name:** `bugdesk-webhook` (or any name you like).
   - **Region:** Choose the one closest to you or your users.
   - **Branch:** `main` (or your default branch).
   - **Runtime:** `Node`.
   - **Build Command:** `npm install` (Render usually fills this in; you can leave default).
   - **Start Command:** `npm start`.
   - **Instance type:** Free (or paid if you prefer).

5. Click **Advanced** and add **Environment Variables**:

   | Key                     | Value (example / where to get it) |
   |-------------------------|------------------------------------|
   | `STRIPE_SECRET_KEY`     | Your Stripe secret key `sk_...`    |
   | `STRIPE_WEBHOOK_SECRET` | Leave empty for now (step 4)       |
   | `GHL_API_KEY`           | Your Go High Level API key         |

   Do **not** add `PORT`; Render sets it automatically.

6. Click **Create Web Service**. Render will build and deploy. Wait until the service shows **Live** and note the URL (e.g. `https://bugdesk-webhook.onrender.com`).

### 3. Configure Stripe to send webhooks to Render

1. In [Stripe Dashboard](https://dashboard.stripe.com) go to **Developers** → **Webhooks** → **Add endpoint**.
2. **Endpoint URL:** `https://YOUR-RENDER-URL.onrender.com/webhook` (use the URL from step 2).
3. **Events to send:** Select (or “Select all” then narrow down):
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Click **Add endpoint**. Stripe will show **Signing secret** (starts with `whsec_...`). Click **Reveal** and copy it.

### 4. Add the webhook secret on Render

1. In Render, open your **bugdesk-webhook** service → **Environment**.
2. Add or edit `STRIPE_WEBHOOK_SECRET` and paste the `whsec_...` value from step 3.
3. Save. Render will redeploy with the new variable.

### 5. Test the webhook

- In Stripe Dashboard → Webhooks → your endpoint, use **Send test webhook** and pick an event (e.g. `checkout.session.completed`). It should return 200.
- Or trigger a real test checkout and confirm the event is received and your GHL contact is updated.

**Optional:** Use **GET** `https://YOUR-RENDER-URL.onrender.com/health` to confirm the app is running.
