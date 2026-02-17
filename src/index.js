import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';

const app = express();
const port = process.env.PORT ?? 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

if (!webhookSecret) {
  console.warn('STRIPE_WEBHOOK_SECRET is not set; webhook signature verification will fail.');
}

// Convert { key: value } to GHL format: [ { key, value } ]. Omit null/undefined values.
function toGHLCustomFieldsArray(obj) {
  return Object.entries(obj)
    .filter(([, value]) => value != null)
    .map(([key, value]) => ({ key, value }));
}

// Helper: Send request to Go High Level API
async function updateGHLContact({ email, ghlContactId, tags = [], customFields = {} }) {
  const body = {
    email,
    tags,
    customFields: toGHLCustomFieldsArray(customFields),
  };

  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) {
    throw new Error('GHL_API_KEY is not set');
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  if (ghlContactId) {
    const res = await fetch(`https://rest.gohighlevel.com/v1/contacts/${ghlContactId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GHL PUT contact failed ${res.status}: ${text}`);
    }
  } else {
    const res = await fetch('https://rest.gohighlevel.com/v1/contacts/', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GHL POST contact failed ${res.status}: ${text}`);
    }
  }
}

// Webhook route must receive raw body for signature verification.
// Register it before any JSON body parser.
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    if (!sig || !webhookSecret) {
      return res.status(400).send('Missing Stripe-Signature or webhook secret.');
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('⚠️ Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const email = session.customer_details?.email;
          const metadata = session.metadata || {};
          const ghlContactId = metadata.ghl_contact_id || null;

          await updateGHLContact({
            email,
            ghlContactId,
            tags: ['trial_started'],
            customFields: {
              stripe_customer_id: session.customer,
              stripe_checkout_id: session.id,
            },
          });
          break;
        }

        case 'customer.subscription.created': {
          const sub = event.data.object;
          const metadata = sub.metadata || {};
          const email = metadata.email || null;
          const ghlContactId = metadata.ghl_contact_id || null;

          await updateGHLContact({
            email,
            ghlContactId,
            tags: ['trial_started'],
            customFields: {
              stripe_subscription_id: sub.id,
              trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
              subscription_status: sub.status,
            },
          });
          break;
        }

        case 'customer.subscription.updated': {
          const sub = event.data.object;
          const metadata = sub.metadata || {};
          const email = metadata.email || null;
          const ghlContactId = metadata.ghl_contact_id || null;

          await updateGHLContact({
            email,
            ghlContactId,
            tags: ['subscription_updated'],
            customFields: {
              stripe_subscription_id: sub.id,
              subscription_status: sub.status,
              trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
            },
          });
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const metadata = sub.metadata || {};
          const email = metadata.email || null;
          const ghlContactId = metadata.ghl_contact_id || null;

          await updateGHLContact({
            email,
            ghlContactId,
            tags: ['subscription_canceled'],
            customFields: {
              stripe_subscription_id: sub.id,
              subscription_status: 'canceled',
            },
          });
          break;
        }

        default:
          console.log(`Unhandled event type ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error('⚠️ Error processing webhook:', err);
      res.status(500).send('Internal Server Error');
    }
  }
);

// JSON body parsing for any other routes (none by default)
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Stripe webhook server listening on port ${port}`);
});
