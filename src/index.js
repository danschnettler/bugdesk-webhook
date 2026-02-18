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

// GHL Private Integrations use this base URL and require the Version header.
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

// Helper: Get customer email from Stripe if not provided
async function getCustomerEmail(customerId) {
  if (!customerId) return null;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer.email || null;
  } catch (err) {
    console.warn(`Failed to fetch customer ${customerId}:`, err.message);
    return null;
  }
}

// Helper: Extract comprehensive subscription data from Stripe subscription object
function extractSubscriptionData(sub) {
  const items = sub.items?.data || [];
  const primaryItem = items[0];
  const price = primaryItem?.price;
  
  // Extract customer ID as string (handle both string and object references)
  const customerId = typeof sub.customer === 'string' 
    ? sub.customer 
    : sub.customer?.id || sub.customer || null;
  
  return {
    stripe_subscription_id: sub.id,
    stripe_customer_id: customerId,
    subscription_status: sub.status,
    subscription_currency: sub.currency,
    subscription_interval: price?.recurring?.interval || null,
    subscription_interval_count: price?.recurring?.interval_count || null,
    subscription_amount: price?.unit_amount ? (price.unit_amount / 100).toFixed(2) : null,
    subscription_amount_formatted: price?.unit_amount 
      ? `$${(price.unit_amount / 100).toFixed(2)}` 
      : null,
    plan_name: price?.nickname || price?.product || null,
    plan_id: price?.id || null,
    trial_start: sub.trial_start ? new Date(sub.trial_start * 1000).toISOString() : null,
    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_start: sub.current_period_start 
      ? new Date(sub.current_period_start * 1000).toISOString() 
      : null,
    current_period_end: sub.current_period_end 
      ? new Date(sub.current_period_end * 1000).toISOString() 
      : null,
    cancel_at_period_end: sub.cancel_at_period_end ? 'true' : 'false',
    canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    billing_cycle_anchor: sub.billing_cycle_anchor 
      ? new Date(sub.billing_cycle_anchor * 1000).toISOString() 
      : null,
    collection_method: sub.collection_method || null,
    days_until_due: sub.days_until_due?.toString() || null,
  };
}

// Helper: Create or update subscription in GHL (if API supports it)
async function syncGHLSubscription({ contactId, subscriptionData }) {
  const token = process.env.GHL_API_KEY;
  const subAccountId = process.env.GHL_SUB_ACCOUNT_ID;
  
  if (!token || !contactId) return; // Skip if no token or contact ID
  
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Version: GHL_VERSION,
  };

  // Try to create/update subscription in GHL
  // Note: GHL subscription API may not support direct creation, so this may fail gracefully
  try {
    const subscriptionBody = {
      ...(subAccountId && { locationId: subAccountId }),
      contactId,
      name: subscriptionData.plan_name || 'Stripe Subscription',
      status: subscriptionData.subscription_status === 'active' ? 'active' : 'inactive',
      // Map Stripe fields to GHL subscription fields if available
      amount: subscriptionData.subscription_amount,
      currency: subscriptionData.subscription_currency,
      interval: subscriptionData.subscription_interval,
      // Store Stripe subscription ID for reference
      externalId: subscriptionData.stripe_subscription_id,
    };

    // Try POST to create/update subscription (endpoint may vary)
    // This is experimental - GHL API may not support this endpoint
    const res = await fetch(`${GHL_BASE}/payments/subscriptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(subscriptionBody),
    });

    if (!res.ok) {
      // If subscription endpoint doesn't exist or fails, that's okay
      // We'll still store data in custom fields
      console.log(`GHL subscription sync skipped (API may not support): ${res.status}`);
    }
  } catch (err) {
    // Silently fail - subscription creation in GHL may not be supported
    console.log('GHL subscription sync skipped:', err.message);
  }
}

// Helper: Send request to Go High Level API (Private Integration)
async function updateGHLContact({ email, ghlContactId, tags = [], customFields = {} }) {
  const subAccountId = process.env.GHL_SUB_ACCOUNT_ID;
  const body = {
    ...(subAccountId && { locationId: subAccountId }),
    type: 'Customer',
    email,
    tags,
    customFields: toGHLCustomFieldsArray(customFields),
  };

  const token = process.env.GHL_API_KEY;
  if (!token) {
    throw new Error('GHL_API_KEY is not set');
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Version: GHL_VERSION,
  };

  let contactId = ghlContactId;
  
  if (ghlContactId) {
    const res = await fetch(`${GHL_BASE}/contacts/${ghlContactId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GHL PUT contact failed ${res.status}: ${text}`);
    }
  } else {
    // Upsert: create or update by email so we don't fail when location disallows duplicates
    const res = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GHL POST contact upsert failed ${res.status}: ${text}`);
    }
    // Try to get contact ID from response
    try {
      const result = await res.json();
      contactId = result.contact?.id || null;
    } catch {
      // Response might not be JSON, that's okay
    }
  }
  
  return contactId;
}

// Webhook route must receive raw body for signature verification.
// Register it before any JSON body parser.
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    console.log('[webhook] Request received');
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

    console.log('[webhook] Event verified:', event.type, event.id);

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          let email = session.customer_details?.email;
          const metadata = session.metadata || {};
          const ghlContactId = metadata.ghl_contact_id || null;

          // Get email from customer if not in session details
          if (!email && session.customer) {
            email = await getCustomerEmail(
              typeof session.customer === 'string' 
                ? session.customer 
                : session.customer.id
            );
          }

          // Don't add trial_started here - wait for customer.subscription.created event
          // which has the actual trial_end information
          await updateGHLContact({
            email,
            ghlContactId,
            tags: [],
            customFields: {
              stripe_customer_id: typeof session.customer === 'string' 
                ? session.customer 
                : session.customer?.id || session.customer,
              stripe_checkout_id: session.id,
            },
          });
          break;
        }

        case 'customer.subscription.created': {
          const sub = event.data.object;
          
          // Fetch full subscription with expanded items to get price/plan details
          const fullSub = await stripe.subscriptions.retrieve(sub.id, {
            expand: ['items.data.price.product'],
          });
          
          const metadata = fullSub.metadata || {};
          let email = metadata.email || null;
          const ghlContactId = metadata.ghl_contact_id || null;
          
          // Get email from customer if not in metadata
          if (!email && fullSub.customer) {
            email = await getCustomerEmail(
              typeof fullSub.customer === 'string' 
                ? fullSub.customer 
                : fullSub.customer.id
            );
          }

          // Extract all subscription data
          const subscriptionData = extractSubscriptionData(fullSub);

          // Only add trial_started tag if subscription actually has a trial period
          const hasTrial = fullSub.trial_end && fullSub.trial_end > Math.floor(Date.now() / 1000);
          const tags = hasTrial ? ['trial_started'] : [];

          // Update contact with all subscription data
          const contactId = await updateGHLContact({
            email,
            ghlContactId,
            tags,
            customFields: subscriptionData,
          });

          // Try to sync subscription to GHL (may not be supported by API)
          if (contactId) {
            await syncGHLSubscription({ contactId, subscriptionData });
          }
          break;
        }

        case 'customer.subscription.updated': {
          const sub = event.data.object;
          
          // Fetch full subscription with expanded items
          const fullSub = await stripe.subscriptions.retrieve(sub.id, {
            expand: ['items.data.price.product'],
          });
          
          const metadata = fullSub.metadata || {};
          let email = metadata.email || null;
          const ghlContactId = metadata.ghl_contact_id || null;
          
          // Get email from customer if not in metadata
          if (!email && fullSub.customer) {
            email = await getCustomerEmail(
              typeof fullSub.customer === 'string' 
                ? fullSub.customer 
                : fullSub.customer.id
            );
          }

          // Extract all subscription data
          const subscriptionData = extractSubscriptionData(fullSub);

          // Update contact with all subscription data
          const contactId = await updateGHLContact({
            email,
            ghlContactId,
            tags: ['subscription_updated'],
            customFields: subscriptionData,
          });

          // Try to sync subscription to GHL
          if (contactId) {
            await syncGHLSubscription({ contactId, subscriptionData });
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          
          // Fetch full subscription details even if deleted
          const fullSub = await stripe.subscriptions.retrieve(sub.id, {
            expand: ['items.data.price.product'],
          });
          
          const metadata = fullSub.metadata || {};
          let email = metadata.email || null;
          const ghlContactId = metadata.ghl_contact_id || null;
          
          // Get email from customer if not in metadata
          if (!email && fullSub.customer) {
            email = await getCustomerEmail(
              typeof fullSub.customer === 'string' 
                ? fullSub.customer 
                : fullSub.customer.id
            );
          }

          // Extract subscription data (status will be 'canceled')
          const subscriptionData = extractSubscriptionData(fullSub);
          subscriptionData.subscription_status = 'canceled';

          // Update contact with cancellation info
          const contactId = await updateGHLContact({
            email,
            ghlContactId,
            tags: ['subscription_canceled'],
            customFields: subscriptionData,
          });

          // Try to sync subscription cancellation to GHL
          if (contactId) {
            await syncGHLSubscription({ contactId, subscriptionData });
          }
          break;
        }

        default:
          console.log(`Unhandled event type ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error('⚠️ Error processing webhook:', err.message);
      if (err.stack) console.error(err.stack);
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
