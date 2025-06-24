import { registerAs } from '@nestjs/config';

export default registerAs('bull', () => ({
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_QUEUE_DB || '1', 10),
    
    // Enhanced connection settings for reliability
    connectTimeout: 60000,     // 60 seconds
    commandTimeout: 30000,     // 30 seconds  
    lazyConnect: false,        // Connect immediately
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    keepAlive: 30000,
    family: 4,
    enableOfflineQueue: false,
    
    // Additional optimizations
    maxLoadingTimeout: 5000,
    enableReadyCheck: true,
    
    // Connection pool settings
    maxMemoryPolicy: 'noeviction',
  },
  
  // Enhanced job settings with dead letter queue support
  defaultJobOptions: {
    removeOnComplete: 20,      // Keep more completed jobs for monitoring
    removeOnFail: false,       // Don't auto-remove failed jobs - we'll handle via DLQ
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    timeout: 60000,            // 60 seconds job timeout
    
    // Dead letter queue settings
    failedJob: {
      removeOnComplete: 50,    // Keep failed jobs longer in DLQ
      removeOnFail: 20,
    },
  },
  
  // Enhanced worker settings
  settings: {
    stalledInterval: 30 * 1000,  // Check for stalled jobs every 30s
    maxStalledCount: 1,          // Max stalled jobs before marking as failed
    delay: 5000,                 // 5 seconds between polls
    
    // Concurrency settings
    concurrency: 5,              // Process 5 jobs concurrently
    
    // Rate limiting
    limiter: {
      max: 10,                   // Max 10 jobs
      duration: 1000,            // Per second
    },
  },
  
  // Worker-specific settings
  workerOptions: {
    concurrency: 3,              // Process 3 jobs at a time per worker
    stalledInterval: 30000,      // Check for stalled jobs every 30s
    maxStalledCount: 1,          // Max stalled jobs before failing
    
    // Enhanced connection settings for workers
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_QUEUE_DB || '1', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      commandTimeout: 30000,
      maxRetriesPerRequest: null,
      retryDelayOnFailover: 100,
      enableOfflineQueue: false,
    },
    
    // Job processing settings
    settings: {
      stalledInterval: 30000,
      delay: 1000,               // Reduced delay for faster processing
    },
  },
  
  // Dead Letter Queue configuration
  deadLetterQueue: {
    name: 'dead-letter-queue',
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_QUEUE_DB || '1', 10),
      password: process.env.REDIS_PASSWORD || undefined,
    },
    defaultJobOptions: {
      removeOnComplete: 100,     // Keep DLQ jobs longer for analysis
      removeOnFail: 50,
      attempts: 1,               // Don't retry jobs in DLQ
    },
  },
  
  // Queue-specific configurations
  queues: {
    'task-processing': {
      defaultJobOptions: {
        removeOnComplete: 15,
        removeOnFail: false,     // Don't remove failed jobs - move to DLQ
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        timeout: 45000,          // 45 seconds for task processing
      },
      settings: {
        stalledInterval: 30000,
        maxStalledCount: 1,
      },
    },
    
    'dead-letter-queue': {
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 25,
        attempts: 1,
        timeout: 30000,
      },
    },
  },
  
  // Monitoring and metrics settings
  monitoring: {
    enabled: process.env.NODE_ENV === 'production',
    maxEvents: 1000,           // Keep last 1000 events for monitoring
    
    // Metrics collection
    collectMetrics: true,
    metricsInterval: 30000,    // Collect metrics every 30 seconds
  },
  
  // Health check settings
  healthCheck: {
    enabled: true,
    interval: 60000,           // Check health every minute
    timeout: 5000,             // 5 second timeout for health checks
  },
}));