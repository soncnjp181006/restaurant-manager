'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const trackingRoutes = require('./src/routes/tracking.routes');
const { mirrorStatus, mirrorFailures, closeMirror } = require('./src/postgres-store');
const {
  createSessionAuthMiddleware,
  createCorsOriginDelegate,
} = require('./src/session-auth.middleware');

const app = express();
const PORT = Number(process.env.TRACKING_PORT || 3138);
const HOST = process.env.TRACKING_HOST || '0.0.0.0';
const requireSession = createSessionAuthMiddleware();

app.use(cors({ origin: createCorsOriginDelegate() }));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'restaurant-manager-tracking-api',
    // Analytical mirror only — SurrealDB is the store every report reads.
    pgMirror: mirrorStatus(),
    pgMirrorFailures: mirrorFailures(),
  });
});

app.use('/tracking', requireSession, trackingRoutes);

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('Tracking API error:', err);
  res.status(500).json({
    success: false,
    error: err instanceof Error ? err.message : 'Unexpected server error',
  });
});

const server = app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Tracking API listening on http://${HOST}:${PORT}`);
  // eslint-disable-next-line no-console
  console.log('POST /tracking');
  // eslint-disable-next-line no-console
  console.log(`PostgreSQL mirror: ${mirrorStatus()}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      closeMirror().catch(() => {
        // eslint-disable-next-line no-console
        console.error('Failed to close the PostgreSQL mirror pool');
      });
    });
  });
}
