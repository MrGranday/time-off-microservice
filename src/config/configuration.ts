export default () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiPrefix: process.env.API_PREFIX || 'api/v1',

  database: {
    path: process.env.DB_PATH || './data/time-off.sqlite',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION_MUST_BE_32_CHARS_MIN',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  hcm: {
    baseUrl: process.env.HCM_BASE_URL || 'http://localhost:4000',
    apiKey: process.env.HCM_API_KEY || 'mock-hcm-api-key',
    timeoutMs: parseInt(process.env.HCM_TIMEOUT_MS || '10000', 10),
    retryAttempts: parseInt(process.env.HCM_RETRY_ATTEMPTS || '3', 10),
    retryDelayMs: parseInt(process.env.HCM_RETRY_DELAY_MS || '500', 10),
    webhookSecret: process.env.HCM_WEBHOOK_SECRET || 'CHANGE_ME_WEBHOOK_SECRET',
  },

  sync: {
    staleThresholdMs: parseInt(process.env.STALE_THRESHOLD_MS || '300000', 10),
    batchSyncCron: process.env.BATCH_SYNC_CRON || '0 2 * * *',
  },

  throttle: {
    ttlMs: parseInt(process.env.THROTTLE_TTL_MS || '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),
  },
});
