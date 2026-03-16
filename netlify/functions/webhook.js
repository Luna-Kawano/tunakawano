// ============================================================
// netlify/functions/webhook.js
// ─────────────────────────────────────────────────────────────
// Fires after every successful Stripe payment.
// Does three things:
//   1. Sends YOU an order notification email
//   2. Creates a Printful order for any POD items
//   3. Logs everything to Netlify function logs
//
// ENVIRONMENT VARIABLES TO ADD IN NETLIFY:
// (Site settings → Environment variables)
//
//   STRIPE_SECRET_KEY      your Stripe secret key (sk_live_...)
//   STRIPE_WEBHOOK_SECRET  from Stripe dashboard → Webhooks → signing secret
//   PRINTFUL_API_KEY       from printful.com → Settings → API
//   PRINTFUL_STORE_ID      from printful.com → Settings → Stores (numeric ID)
//   NOTIFY_EMAIL           your email address (kawano.luna@gmail.com)
//   NOTIFY_EMAIL_PASS      Gmail App Password — NOT your regular Gmail password
//                          Generate at: myaccount.google.com/apppasswords
//                          (requires 2FA enabled on your Google account)
//
// STRIPE WEBHOOK SETUP:
//   1. Go to Stripe dashboard → Developers → Webhooks → Add endpoint
//   2. URL: https://tunakawano.com/.netlify/functions/webhook
//   3. Events to listen for: checkout.session.completed
//   4. Copy the signing secret → paste as STRIPE_WEBHOOK_SECRET in Netlify
// ============================================================

const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');

// ============================================================
// EMAIL TRANSPORTER
// Uses Gmail SMTP. Free, no extra service needed.
// ============================================================
function makeTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.NOTIFY_EMAIL,
      pass: process.env.NOTIFY_EMAIL_PASS, // Gmail App Password
    },
  });
}

// ============================================================
// FORMAT ORDER EMAIL
// Builds a clear plain-text summary of the order for you.
// ============================================================
function formatOrderEmail(session, orderItems, printfulOrderId, optedIn) {
  const customer  = session.customer_details;
  const shipping  = session.shipping_details;
  const addr      = shipping?.address;
  const totalCAD  = (session.amount_total / 100).toFixed(2);

  const selfItems     = orderItems.filter(i => i.fulfillment === 'self');
  const printfulItems = orderItems.filter(i => i.fulfillment === 'printful');

  const fmtItem = i => {
    const size = i.size ? ` (${i.size})` : '';
    return `  • ${i.productId}${size} × ${i.quantity}`;
  };

  const selfSection = selfItems.length > 0
    ? `\nYOU NEED TO SHIP:\n${selfItems.map(fmtItem).join('\n')}\n`
    : '';

  const printfulSection = printfulItems.length > 0
    ? `\nPRINTFUL WILL SHIP (order #${printfulOrderId || 'see Printful dashboard'}):\n${printfulItems.map(fmtItem).join('\n')}\n`
    : '';

  const addrLine = addr
    ? `${addr.line1}${addr.line2 ? ', ' + addr.line2 : ''}, ${addr.city}, ${addr.state || ''} ${addr.postal_code}, ${addr.country}`
    : 'No address on file';

  return {
    subject: `🐟 New order! $${totalCAD} CAD — ${customer?.name || 'Unknown'}`,
    text: `
New order received on tunakawano.com!

─────────────────────────────
CUSTOMER
  Name:      ${customer?.name || '—'}
  Email:     ${customer?.email || '—'}
  Ship to:   ${addrLine}
  Marketing: ${optedIn ? '✅ Opted in — added to Google Sheet' : '❌ No opt-in'}
─────────────────────────────
ORDER TOTAL: $${totalCAD} CAD
Stripe session: ${session.id}
─────────────────────────────
${selfSection}${printfulSection}
─────────────────────────────
Action needed:
${selfItems.length > 0 ? '  ☐ Pack and ship your self-fulfilled items\n' : ''}${printfulItems.length > 0 ? `  ✓ Printful order created automatically (ID: ${printfulOrderId || 'check dashboard'})\n` : ''}
View in Stripe: https://dashboard.stripe.com/payments/${session.payment_intent}
`.trim(),
  };
}

// ============================================================
// LOG TO GOOGLE SHEETS
// ─────────────────────────────────────────────────────────────
// Sends customer data to your Google Apps Script webhook.
// Only fires if GOOGLE_SHEETS_WEBHOOK env var is set.
// Safe to fail — won't break the order flow if it errors.
// ============================================================
async function logToGoogleSheets(session, orderItems, optedIn) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK;
  if (!webhookUrl) return; // silently skip if not configured

  const customer   = session.customer_details;
  const totalCAD   = '$' + (session.amount_total / 100).toFixed(2);
  const itemsSummary = orderItems
    .map(i => `${i.productId}${i.size ? ` (${i.size})` : ''} × ${i.quantity}`)
    .join(', ');

  try {
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:      customer?.email || '',
        name:       customer?.name  || '',
        optedIn:    !!optedIn,
        orderTotal: totalCAD,
        items:      itemsSummary,
      }),
    });
    console.log('Google Sheets log sent — opted in:', optedIn);
  } catch (err) {
    console.error('Google Sheets log failed (non-fatal):', err.message);
  }
}

// ============================================================
// SEND ORDER NOTIFICATION
// ============================================================
async function sendOrderEmail(session, orderItems, printfulOrderId, optedIn) {
  const notify = process.env.NOTIFY_EMAIL;
  const pass   = process.env.NOTIFY_EMAIL_PASS;

  if (!notify || !pass) {
    console.warn('NOTIFY_EMAIL or NOTIFY_EMAIL_PASS not set — skipping email notification.');
    return;
  }

  try {
    const transporter = makeTransporter();
    const { subject, text } = formatOrderEmail(session, orderItems, printfulOrderId, optedIn);
    await transporter.sendMail({
      from:    `"Tuna Kawano Shop" <${notify}>`,
      to:      notify,
      subject,
      text,
    });
    console.log('Order notification email sent to', notify);
  } catch (err) {
    // Don't fail the whole webhook if email fails — Stripe logs are backup
    console.error('Failed to send order email:', err.message);
  }
}

// ============================================================
// CREATE PRINTFUL ORDER
// ─────────────────────────────────────────────────────────────
// Idempotent — uses Stripe session ID as external_id so if
// Stripe retries the webhook, Printful won't create a duplicate.
// ============================================================
async function createPrintfulOrder(session, printfulItems) {
  const addr = session.shipping_details?.address;
  const name = session.shipping_details?.name || session.customer_details?.name || '';

  if (!addr) throw new Error('No shipping address on session');

  const order = {
    external_id: session.id, // Printful deduplicates on this — safe to retry
    recipient: {
      name,
      address1:     addr.line1,
      address2:     addr.line2 || '',
      city:         addr.city,
      state_code:   addr.state   || '',
      country_code: addr.country,
      zip:          addr.postal_code,
      email:        session.customer_details?.email || '',
    },
    items: printfulItems.map(item => ({
      variant_id:   item.printfulVariantId,
      quantity:     item.quantity,
      retail_price: (item.pricePaid / 100).toFixed(2), // shows on Printful packing slip
    })),
  };

  const response = await fetch('https://api.printful.com/orders', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
      'Content-Type':  'application/json',
      ...(process.env.PRINTFUL_STORE_ID
        ? { 'X-PF-Store-Id': process.env.PRINTFUL_STORE_ID }
        : {}),
    },
    body: JSON.stringify(order),
  });

  const result = await response.json();

  if (!response.ok) {
    // Check if it's a duplicate (Printful returns 400 with "external_id already exists")
    const isDuplicate = result?.error?.message?.includes('external_id');
    if (isDuplicate) {
      console.warn('Printful order already exists for session', session.id, '— skipping duplicate.');
      return null;
    }
    throw new Error(`Printful API error: ${JSON.stringify(result.error || result)}`);
  }

  console.log('Printful order created:', result.result.id);
  return result.result.id;
}

// ============================================================
// HANDLER
// ============================================================
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── Verify request came from Stripe ──────────────────────
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      event.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Event ignored' };
  }

  const session = stripeEvent.data.object;
  console.log('Processing order for session:', session.id);

  // ── Parse order items from metadata ──────────────────────
  let orderItems;
  try {
    orderItems = JSON.parse(session.metadata?.order_items || '[]');
  } catch {
    console.error('Failed to parse order_items metadata');
    return { statusCode: 500, body: 'Metadata parse error' };
  }

  const optedIn = session.metadata?.marketing_opt_in === 'true';

  const printfulItems = orderItems.filter(
    i => i.fulfillment === 'printful' && i.printfulVariantId
  );
  const selfItems = orderItems.filter(i => i.fulfillment === 'self');

  console.log(`Order: ${selfItems.length} self-fulfilled, ${printfulItems.length} Printful items`);

  // ── Create Printful order ─────────────────────────────────
  let printfulOrderId = null;
  if (printfulItems.length > 0) {
    try {
      printfulOrderId = await createPrintfulOrder(session, printfulItems);
    } catch (err) {
      console.error('Printful order failed:', err.message);
      // Still send the email so you know to place it manually
      // Don't return an error — Stripe would retry and could cause duplicate emails
    }
  }

  // ── Send order notification email to you ─────────────────
  await sendOrderEmail(session, orderItems, printfulOrderId, optedIn);

  // ── Log to Google Sheets (all orders; marks opt-in status) ─
  await logToGoogleSheets(session, orderItems, optedIn);

  return {
    statusCode: 200,
    body: JSON.stringify({
      received: true,
      printfulOrderId,
      selfFulfilledCount: selfItems.length,
    }),
  };
};
