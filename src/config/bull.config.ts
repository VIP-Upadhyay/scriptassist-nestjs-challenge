import { registerAs } from '@nestjs/config';

export default registerAs('bull', () => ({
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_QUEUE_DB || '1', 10),
    
    // FIXED: Optimize timeouts to prevent errors
    connectTimeout: 60000,    // 60 seconds
    commandTimeout: 30000,    // 30 seconds  
    lazyConnect: false,       // Connect immediately
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    keepAlive: 30000,
    family: 4,
    enableOfflineQueue: false,
    
    // Additional optimizations
    maxLoadingTimeout: 5000,
    enableReadyCheck: true,
  },
  
  // Optimize job settings
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 5,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    // Add job timeout
    timeout: 30000, // 30 seconds
  },
  
  // Optimize worker settings
  settings: {
    stalledInterval: 30 * 1000,
    maxStalledCount: 1,
    // Reduce polling frequency
    delay: 5000, // 5 seconds between polls
  },
  
  // Worker-specific settings
  workerOptions: {
    concurrency: 1,           // Process one job at a time
    stalledInterval: 30000,   // Check for stalled jobs every 30s
    maxStalledCount: 1,       // Max stalled jobs before failing
    removeOnComplete: 10,
    removeOnFail: 5,
    
    // IMPORTANT: Add connection settings for workers
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_QUEUE_DB || '1', 10),
      commandTimeout: 30000,
      maxRetriesPerRequest: null,
    },
  },
}));