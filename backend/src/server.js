require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { reportEnvironment } = require('./config/env-check');
reportEnvironment();

const authRoutes = require('./routes/auth');
const verifierAuthRoutes = require('./routes/verifier-auth');
const ticketRoutes = require('./routes/tickets');
const verifyRoutes = require('./routes/verify');
const userRoutes = require('./routes/user');
const settingsRoutes = require('./routes/settings');
const statsRoutes = require('./routes/stats');
const shopifyRoutes = require('./routes/shopify');
const migrationRoutes = require('./routes/migration');
const webhookRoutes = require('./routes/webhooks');
const bulkEmailRoutes = require('./routes/bulk-email');
const eventRoutes = require('./routes/events');
const shopContext = require('./middleware/shop-context');
const shopifyAuth = require('./middleware/shopify-auth');
const shopifyWebhookRoutes = require('./routes/shopify-webhooks');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());

// Shopify webhooks MUST be mounted before express.json(): HMAC verification
// needs the raw, unparsed body. Once express.json() has parsed and
// re-serialised it, the digest no longer matches.
app.use('/api/shopify/webhooks', express.raw({ type: '*/*', limit: '5mb' }), shopifyWebhookRoutes);

app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Identity, then tenant. shopifyAuth sets req.shopDomain from an App Bridge
// session token when there is one; shopContext turns that into req.shopId, and
// falls back to the single default shop for legacy JWT auth.
app.use('/api', shopifyAuth);
app.use('/api', shopContext);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/auth', verifierAuthRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/verify', verifyRoutes);
app.use('/api/user', userRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/shopify', shopifyRoutes);
app.use('/api/migration', migrationRoutes); // retired - responds 410, see routes/migration.js
app.use('/api/webhooks', webhookRoutes);
app.use('/api/bulk-email', bulkEmailRoutes);
app.use('/api/events', eventRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
