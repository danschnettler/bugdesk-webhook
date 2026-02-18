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

// Constants
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const STRIPE_EXPAND_OPTIONS = ['items.data.price.product'];

// Convert { key: value } to GHL format: [ { key, value } ]. Omit null/undefined values.
function toGHLCustomFieldsArray(obj) {
  return Object.entries(obj)
    .filter(([, value]) => value != null)
    .map(([key, value]) => ({ key, value }));
}

// Helper: Extract ID from Stripe object (handles both string and object references)
function extractId(obj) {
  if (!obj) return null;
  return typeof obj === 'string' ? obj : obj.id || null;
}

// Helper: Convert Unix timestamp to ISO string
function timestampToISO(timestamp) {
  return timestamp ? new Date(timestamp * 1000).toISOString() : null;
}

// Helper: Get GHL API headers
function getGHLHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    'Content-Type': 'application/json',
    Version: GHL_VERSION,
  };
}

// Helper: Get customer details (email, name, phone) from Stripe if not provided
async function getCustomerDetails(customerId) {
  if (!customerId) return { email: null, name: null, phone: null };
  try {
    const customer = await stripe.customers.retrieve(extractId(customerId));
    return {
      email: customer.email || null,
      name: customer.name || null,
      phone: customer.phone || customer.metadata?.phone || null,
    };
  } catch (err) {
    console.warn(`Failed to fetch customer ${customerId}:`, err.message);
    return { email: null, name: null, phone: null };
  }
}

// Helper: Get email from event metadata or customer object
async function getEmailFromEvent(metadata, customer) {
  if (metadata?.email) return metadata.email;
  if (customer) {
    const details = await getCustomerDetails(customer);
    return details.email;
  }
  return null;
}

// Helper: Get name from event metadata or customer object
async function getNameFromEvent(metadata, customer, customerDetails = null) {
  if (metadata?.name) return metadata.name;
  if (customerDetails?.name) return customerDetails.name;
  if (customer) {
    const details = await getCustomerDetails(customer);
    return details.name;
  }
  return null;
}

// Helper: Get phone from event metadata or customer object
async function getPhoneFromEvent(metadata, customer, customerDetails = null) {
  if (metadata?.phone) return metadata.phone;
  if (customerDetails?.phone) return customerDetails.phone;
  if (customer) {
    const details = await getCustomerDetails(customer);
    return details.phone;
  }
  return null;
}

// Helper: Fetch full subscription with expanded items
async function fetchFullSubscription(subscriptionId) {
  return await stripe.subscriptions.retrieve(subscriptionId, {
    expand: STRIPE_EXPAND_OPTIONS,
  });
}

// Helper: Process subscription event (created/updated/deleted)
async function processSubscriptionEvent(sub, tags, statusOverride = null) {
  console.log(`[processSubscriptionEvent] Processing subscription ${sub.id}`);
  console.log(`[processSubscriptionEvent] Tags to apply: ${JSON.stringify(tags)}`);
  
  const fullSub = await fetchFullSubscription(sub.id);
  const metadata = fullSub.metadata || {};
  
  // Get customer details once and reuse
  const customerDetails = fullSub.customer 
    ? await getCustomerDetails(fullSub.customer)
    : null;
  
  const email = metadata.email || customerDetails?.email || null;
  const name = await getNameFromEvent(metadata, fullSub.customer, customerDetails);
  const phone = await getPhoneFromEvent(metadata, fullSub.customer, customerDetails);
  const ghlContactId = metadata.ghl_contact_id || null;
  
  console.log(`[processSubscriptionEvent] Contact Info:`);
  console.log(`  - Email: ${email || 'N/A'}`);
  console.log(`  - Name: ${name || 'N/A'}`);
  console.log(`  - Phone: ${phone || 'N/A'}`);
  console.log(`  - GHL Contact ID from metadata: ${ghlContactId || 'none'}`);
  
  const subscriptionData = extractSubscriptionData(fullSub);
  if (statusOverride) {
    subscriptionData.subscription_status = statusOverride;
  }
  
  console.log(`[processSubscriptionEvent] Updating contact with ${tags.length} tag(s): ${tags.join(', ')}`);
  
  const contactId = await updateGHLContact({
    email,
    name,
    phone,
    ghlContactId,
    tags,
    customFields: subscriptionData,
  });
  
  console.log(`[processSubscriptionEvent] Contact update result:`);
  console.log(`  - Contact ID: ${contactId || 'NOT FOUND'}`);
  console.log(`  - Tags that were sent: ${JSON.stringify(tags)}`);
  
  return { email, name, phone, contactId, hasTrial: fullSub.trial_end && fullSub.trial_end > Math.floor(Date.now() / 1000) };
}

// Helper: Extract comprehensive subscription data from Stripe subscription object
function extractSubscriptionData(sub) {
  const items = sub.items?.data || [];
  const price = items[0]?.price;
  const recurring = price?.recurring;
  
  return {
    stripe_subscription_id: sub.id,
    stripe_customer_id: extractId(sub.customer),
    subscription_status: sub.status,
    subscription_currency: sub.currency,
    subscription_interval: recurring?.interval || null,
    subscription_interval_count: recurring?.interval_count || null,
    subscription_amount: price?.unit_amount ? (price.unit_amount / 100).toFixed(2) : null,
    subscription_amount_formatted: price?.unit_amount 
      ? `$${(price.unit_amount / 100).toFixed(2)}` 
      : null,
    plan_name: price?.nickname || price?.product || null,
    plan_id: price?.id || null,
    trial_start: timestampToISO(sub.trial_start),
    trial_end: timestampToISO(sub.trial_end),
    current_period_start: timestampToISO(sub.current_period_start),
    current_period_end: timestampToISO(sub.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end ? 'true' : 'false',
    canceled_at: timestampToISO(sub.canceled_at),
    billing_cycle_anchor: timestampToISO(sub.billing_cycle_anchor),
    collection_method: sub.collection_method || null,
    days_until_due: sub.days_until_due?.toString() || null,
  };
}

// Helper: Find contact by email (fallback when ID not in response)
async function findContactByEmail(email, headers) {
  if (!email) return null;
  
  const subAccountId = process.env.GHL_SUB_ACCOUNT_ID;
  const url = `${GHL_BASE}/contacts/?email=${encodeURIComponent(email)}${subAccountId ? `&locationId=${subAccountId}` : ''}`;
  
  try {
    const res = await fetch(url, { headers });
    if (res.ok) {
      const result = await res.json();
      return result.contacts?.[0]?.id || null;
    }
  } catch (err) {
    console.warn('[GHL] Could not search for contact by email:', err.message);
  }
  return null;
}

// Helper: Extract contact ID from GHL response
function extractContactIdFromResponse(result) {
  return result.contact?.id || result.id || result.contactId || null;
}

// Helper: Send request to Go High Level API (Private Integration)
async function updateGHLContact({ email, name, phone, ghlContactId, tags = [], customFields = {} }) {
  if (!process.env.GHL_API_KEY) {
    throw new Error('GHL_API_KEY is not set');
  }

  const subAccountId = process.env.GHL_SUB_ACCOUNT_ID;
  const headers = getGHLHeaders();
  const body = {
    ...(subAccountId && { locationId: subAccountId }),
    type: 'Customer',
    email,
    ...(name && { name }),
    ...(phone && { phone }),
    tags,
    customFields: toGHLCustomFieldsArray(customFields),
  };
  
  console.log(`[updateGHLContact] Sending to GHL:`);
  console.log(`  - Email: ${email || 'N/A'}`);
  console.log(`  - Name: ${name || 'N/A'}`);
  console.log(`  - Phone: ${phone || 'N/A'}`);
  console.log(`  - Tags: ${JSON.stringify(tags)}`);
  console.log(`  - GHL Contact ID (if updating): ${ghlContactId || 'none (creating new)'}`);
  console.log(`  - Custom Fields Count: ${Object.keys(customFields).length}`);

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
    // Upsert: create or update by email
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
      contactId = extractContactIdFromResponse(result);
      
      if (contactId) {
        console.log(`[GHL] Contact created/updated: ${contactId}`);
      } else if (email) {
        // Fallback: search by email
        console.log(`[GHL] Contact ID not in response, searching by email: ${email}`);
        contactId = await findContactByEmail(email, headers);
        if (contactId) {
          console.log(`[GHL] Found contact by email: ${contactId}`);
        }
      }
    } catch (err) {
      console.warn('[GHL] Could not parse contact ID from upsert response:', err.message);
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
          const metadata = session.metadata || {};
          
          console.log(`[Checkout Completed] Session ID: ${session.id}, Mode: ${session.mode}, Subscription: ${session.subscription || 'none'}`);
          
          // Get email, name, and phone from session or customer
          let email = session.customer_details?.email;
          let name = session.customer_details?.name;
          let phone = session.customer_details?.phone;
          
          // If not in session details, fetch from customer
          if (session.customer && (!email || !name || !phone)) {
            const customerDetails = await getCustomerDetails(session.customer);
            email = email || customerDetails.email;
            name = name || customerDetails.name;
            phone = phone || customerDetails.phone;
          }
          
          // If this checkout created a subscription, process it immediately
          if (session.mode === 'subscription' && session.subscription) {
            console.log(`[Checkout Completed] Subscription detected: ${session.subscription}, processing...`);
            try {
              const fullSub = await fetchFullSubscription(session.subscription);
              
              // Detailed trial detection logging
              const currentTimestamp = Math.floor(Date.now() / 1000);
              const trialEnd = fullSub.trial_end;
              const hasTrial = trialEnd && trialEnd > currentTimestamp;
              
              console.log(`[Checkout Completed] Trial Detection:`);
              console.log(`  - Trial End Timestamp: ${trialEnd || 'null'}`);
              console.log(`  - Trial End Date: ${trialEnd ? new Date(trialEnd * 1000).toISOString() : 'N/A'}`);
              console.log(`  - Current Timestamp: ${currentTimestamp}`);
              console.log(`  - Current Date: ${new Date().toISOString()}`);
              console.log(`  - Trial End > Current: ${trialEnd ? trialEnd > currentTimestamp : 'N/A'}`);
              console.log(`  - Has Active Trial: ${hasTrial}`);
              console.log(`  - Tags to apply: ${hasTrial ? '["is_trialing"]' : '[]'}`);
              
              const subscriptionData = extractSubscriptionData(fullSub);
              
              const tagsToApply = hasTrial ? ['is_trialing'] : [];
              console.log(`[Checkout Completed] Creating/updating contact with tags: ${JSON.stringify(tagsToApply)}`);
              
              const contactId = await updateGHLContact({
                email,
                name,
                phone,
                ghlContactId: metadata.ghl_contact_id || null,
                tags: tagsToApply,
                customFields: {
                  ...subscriptionData,
                  stripe_checkout_id: session.id,
                },
              });
              
              console.log(`[Checkout Completed] Contact ID: ${contactId || 'NOT FOUND'}, Tags applied: ${JSON.stringify(tagsToApply)}`);
            } catch (err) {
              console.error('[Checkout Completed] Error processing subscription:', err.message);
              // Fall back to basic contact creation
              await updateGHLContact({
                email,
                name,
                phone,
                ghlContactId: metadata.ghl_contact_id || null,
                tags: [],
                customFields: {
                  stripe_customer_id: extractId(session.customer),
                  stripe_checkout_id: session.id,
                },
              });
            }
          } else {
            // No subscription, just create/update contact
            await updateGHLContact({
              email,
              name,
              phone,
              ghlContactId: metadata.ghl_contact_id || null,
              tags: [],
              customFields: {
                stripe_customer_id: extractId(session.customer),
                stripe_checkout_id: session.id,
              },
            });
          }
          break;
        }

        case 'customer.subscription.created': {
          const sub = event.data.object;
          console.log(`[Subscription Created] Processing subscription ${sub.id}, customer: ${extractId(sub.customer)}`);
          
          const fullSub = await fetchFullSubscription(sub.id);
          
          // Detailed trial detection logging
          const currentTimestamp = Math.floor(Date.now() / 1000);
          const trialEnd = fullSub.trial_end;
          const hasTrial = trialEnd && trialEnd > currentTimestamp;
          
          console.log(`[Subscription Created] Trial Detection:`);
          console.log(`  - Trial End Timestamp: ${trialEnd || 'null'}`);
          console.log(`  - Trial End Date: ${trialEnd ? new Date(trialEnd * 1000).toISOString() : 'N/A'}`);
          console.log(`  - Current Timestamp: ${currentTimestamp}`);
          console.log(`  - Current Date: ${new Date().toISOString()}`);
          console.log(`  - Trial End > Current: ${trialEnd ? trialEnd > currentTimestamp : 'N/A'}`);
          console.log(`  - Has Active Trial: ${hasTrial}`);
          
          const tagsToApply = hasTrial ? ['is_trialing'] : [];
          console.log(`[Subscription Created] Tags to apply: ${JSON.stringify(tagsToApply)}`);
          
          const { email, name, phone, contactId } = await processSubscriptionEvent(
            sub,
            tagsToApply
          );
          
          console.log(`[Subscription Created] Final Result:`);
          console.log(`  - Email: ${email || 'N/A'}`);
          console.log(`  - Name: ${name || 'N/A'}`);
          console.log(`  - Phone: ${phone || 'N/A'}`);
          console.log(`  - Has Trial: ${hasTrial}`);
          console.log(`  - Contact ID: ${contactId || 'NOT FOUND'}`);
          console.log(`  - Tags Applied: ${JSON.stringify(tagsToApply)}`);
          
          if (!contactId) {
            console.warn('[Subscription Created] Cannot update contact: contactId is missing');
          }
          break;
        }

        case 'customer.subscription.updated': {
          const sub = event.data.object;
          await processSubscriptionEvent(sub, ['subscription_updated']);
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          await processSubscriptionEvent(sub, ['subscription_canceled'], 'canceled');
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
