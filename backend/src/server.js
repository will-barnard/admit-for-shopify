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
const { authRouteLimiter } = require('./middleware/rate-limit');
const emailJobs = require('./services/email-jobs');

const app = express();
const PORT = process.env.PORT || 3000;

// How many proxies sit in front of this process. In the deployed topology that
// is Beachhead's nginx-proxy and then this app's own nginx, so two. Express
// uses it to pick the real client address out of X-Forwarded-For, which is what
// the rate limiters key on. Set TRUST_PROXY_HOPS to match a different setup -
// running the backend directly with nothing in front of it wants 0.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 2));

// Middleware
app.use(cors());

// Shopify webhooks MUST be mounted before express.json(): HMAC verification
// needs the raw, unparsed body. Once express.json() has parsed and
// re-serialised it, the digest no longer matches.
app.use('/api/shopify/webhooks', express.raw({ type: '*/*', limit: '5mb' }), shopifyWebhookRoutes);

app.use(express.json());
// Uploaded files are user-supplied content served from this app's own origin.
// The upload filter no longer accepts SVG, but files uploaded before that
// change are still on disk, so serve everything here under a CSP that permits
// no script, no network and no framing - which neuters an SVG that carries one.
// nosniff stops a mislabelled file being re-interpreted as HTML.
app.use('/uploads', (req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}, express.static('uploads'));

// Identity, then tenant. shopifyAuth sets req.shopDomain from an App Bridge
// session token when there is one; shopContext turns that into req.shopId, and
// falls back to the single default shop for legacy JWT auth.
app.use('/api', shopifyAuth);
app.use('/api', shopContext);

// Routes
// Both login endpoints are unauthenticated and run a bcrypt comparison per
// attempt, so they are the brute-force and CPU-exhaustion surface.
app.use('/api/auth', authRouteLimiter);
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

  // Drains bulk email jobs, and requeues any left mid-flight by a restart.
  // Started after listen so a slow database cannot delay accepting requests.
  emailJobs.startWorker();
});
