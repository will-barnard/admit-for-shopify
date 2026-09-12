require('dotenv').config();
const { ensureWebhooksForAllShops } = require('../shopify/webhooks-registration');

ensureWebhooksForAllShops()
  .then(() => process.exit(0))
  .catch((error) => {
    // A Shopify API hiccup here shouldn't crash the boot chain and restart-loop
    // the container - migrate/seed already ran, the app is usable, and this
    // step will simply try again next boot.
    console.error('Webhook registration step failed (continuing boot):', error);
    process.exit(0);
  });
