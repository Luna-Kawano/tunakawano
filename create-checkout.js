// ================================================================
// netlify/functions/create-checkout.js
// ================================================================
// WHERE THIS FILE LIVES IN YOUR REPO:
//   netlify/
//     functions/
//       create-checkout.js   ← this file
//   index.html
//   images/
//
// WHAT IT DOES:
//   1. Receives the cart from the browser (POST /create-checkout)
//   2. Creates a Stripe Checkout Session
//   3. Returns the Stripe-hosted payment URL
//   4. After payment, Stripe calls your webhook (see STEP 4 below)
//      which triggers Printful/Gelato for POD items automatically
//
// ================================================================
// STEP 1 — STRIPE SETUP (do this first, ~15 min)
// ================================================================
// a) Create a free Stripe account at stripe.com
// b) Go to Developers → API keys
//    Copy your SECRET key (starts with sk_live_ or sk_test_)
// c) In Netlify: Site settings → Environment variables → Add variable
//    Key:   STRIPE_SECRET_KEY
//    Value: sk_live_xxxxxxxxxxxx   (or sk_test_ for testing)
// d) In Stripe dashboard, create a Product + Price for each item:
//    Products → Add product → set name & price → Save
//    Copy the Price ID (looks like price_1Pxyz...)
//    Paste each Price ID into the stripePrice field in index.html
//
// ================================================================
// STEP 2 — DEPLOY TO NETLIFY (replaces GitHub Pages)
// ================================================================
// Your site needs to move from GitHub Pages to Netlify because
// GitHub Pages is static only — it can't run this function.
// Netlify is also free and just as easy:
//
// a) Push your repo to GitHub (if not already there)
// b) Go to netlify.com → Add new site → Import from GitHub
// c) Select your repo → Deploy site
// d) Custom domain: Site settings → Domain management → Add domain
//    Add tunakawano.com (same DNS steps as GitHub Pages)
// e) Add STRIPE_SECRET_KEY env variable (see Step 1c)
//
// ================================================================
// STEP 3 — HOW PRINTFUL WORKS (add when ready)
// ================================================================
// Printful is triggered AFTER payment via a Stripe webhook.
// You don't need to change this file for Printful — see Step 4.
//
// To set up Printful products:
// a) Create account at printful.com
// b) Go to Stores → Connect → Manual order platform
// c) Add products (t-shirts, totes, etc.) and get their Variant IDs
// d) In index.html, fill in printfulVariantId for each POD product
//    e.g. { id: "tshirt-01", fulfillment: "printful", printfulVariantId: 12345678 }
//
// ================================================================
// STEP 4 — STRIPE WEBHOOK → PRINTFUL (after first sale)
// ================================================================
// Create a second Netlify function: netlify/functions/webhook.js
// (I can write that file for you when you're ready)
//
// It will:
//   1. Receive checkout.session.completed from Stripe
//   2. Look at each line item's fulfillment field
//   3. For fulfillment: "printful" → call Printful API to create order
//   4. For fulfillment: "self"     → send you an email via SendGrid/Resend
//
// ================================================================

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let items;
  try {
    ({ items } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: 'Invalid request body' };
  }

  if (!items || items.length === 0) {
    return { statusCode: 400, body: 'Cart is empty' };
  }

  // Validate that no placeholder Price IDs snuck through
  const hasPlaceholder = items.some(i => i.stripePrice === 'price_PLACEHOLDER');
  if (hasPlaceholder) {
    return {
      statusCode: 400,
      body: 'One or more products are missing a real Stripe Price ID. Update stripePrice in index.html.',
    };
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',

      // ── LINE ITEMS ──────────────────────────────────────────
      // Each item uses its Stripe Price ID (created in your dashboard).
      // We also attach fulfillment metadata so the webhook knows
      // which items to send to Printful after payment.
      line_items: items.map(item => ({
        price:    item.stripePrice,
        quantity: item.quantity,
      })),

      // ── METADATA ────────────────────────────────────────────
      // Store the full cart as JSON so the webhook can read it.
      // This is how the webhook knows which items are Printful POD.
      metadata: {
        cart: JSON.stringify(items.map(item => ({
          productId:         item.productId,
          quantity:          item.quantity,
          fulfillment:       item.fulfillment,
          printfulVariantId: item.printfulVariantId,
        }))),
      },

      // ── SHIPPING ────────────────────────────────────────────
      // Collect the customer's shipping address for self-fulfilled orders.
      // For Printful orders, Printful also needs this — the webhook
      // will read session.shipping_details and forward it to Printful.
      shipping_address_collection: {
        allowed_countries: [
          'CA', 'US', 'GB', 'AU', 'NZ', 'DE', 'FR', 'NL',
          'SE', 'NO', 'DK', 'FI', 'JP', 'KR', 'SG',
          // Add or remove countries as needed
        ],
      },

      // ── SHIPPING OPTIONS ────────────────────────────────────
      // Option A (simple): flat rate — uncomment and set your price
      // shipping_options: [
      //   { shipping_rate_data: {
      //       type: 'fixed_amount',
      //       fixed_amount: { amount: 1200, currency: 'cad' }, // $12.00 CAD
      //       display_name: 'Standard shipping',
      //       delivery_estimate: { minimum: { unit: 'business_day', value: 5 },
      //                            maximum: { unit: 'business_day', value: 10 } },
      //   }},
      // ],
      //
      // Option B: let Stripe calculate shipping — leave blank and
      // configure Stripe Shipping Rates in your dashboard instead

      // ── REDIRECT URLS ───────────────────────────────────────
      success_url: 'https://tunakawano.com/success.html?session={CHECKOUT_SESSION_ID}',
      cancel_url:  'https://tunakawano.com/#shop',

      // ── OPTIONAL: Collect customer email for order confirmation ─
      // customer_email: 'prefill@example.com', // or leave blank
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };

  } catch (err) {
    console.error('Stripe error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
