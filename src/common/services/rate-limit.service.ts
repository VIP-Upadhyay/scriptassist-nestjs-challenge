import { getErrorMessage } from '@common/utils/error.util';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
  keyPrefix?: string;
  message?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTime: Date;
  totalHits: number;
}

@Injectable()
export class RateLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private redis: Redis;
  private isRedisAvailable = false;
  // FIXED: Proper cleanup for fallback storage
  private fallbackStorage = new Map<string, { count: number; resetTime: number }>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(private configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.initializeRedis();
    this.startCleanup();
    this.logger.log('Rate limiting service initialized');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.redis) {
      await this.redis.quit();
    }
    this.fallbackStorage.clear();
    this.logger.log('Rate limiting service destroyed');
  }

  private async initializeRedis(): Promise<void> {
    try {
      // FIXED: Use dedicated Redis database for rate limiting
      this.redis = new Redis({
        host: this.configService.get('REDIS_HOST', 'localhost'),
        port: this.configService.get('REDIS_PORT', 6379),
        password: this.configService.get('REDIS_PASSWORD'),
        db: this.configService.get('REDIS_RATE_LIMIT_DB', 3),
        commandTimeout: 5000,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });

      this.redis.on('connect', () => {
        this.isRedisAvailable = true;
        this.logger.log('Redis rate limiting connected');
      });

      this.redis.on('error', (error) => {
        this.isRedisAvailable = false;
        this.logger.warn(`Redis rate limiting error: ${getErrorMessage(error)}. Using fallback.`);
      });

      await this.redis.ping();
      this.isRedisAvailable = true;
    } catch (error) {
      this.isRedisAvailable = false;
      this.logger.warn(`Failed to initialize Redis rate limiting: ${getErrorMessage(error)}`);
    }
  }

  private startCleanup(): void {
    // FIXED: Automatic cleanup every 60 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanupFallbackStorage();
    }, 60000);
  }

  private cleanupFallbackStorage(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, data] of this.fallbackStorage.entries()) {
      if (data.resetTime <= now) {
        this.fallbackStorage.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned ${cleaned} expired rate limit entries`);
    }
  }

  async checkRateLimit(
    identifier: string,
    config: RateLimitConfig
  ): Promise<RateLimitResult> {
    const { limit, windowMs, keyPrefix = 'rl' } = config;
    const key = `${keyPrefix}:${identifier}`;
    const now = Date.now();

    try {
      if (this.isRedisAvailable) {
        return this.checkRedisRateLimit(key, limit, windowMs, now);
      } else {
        return this.checkFallbackRateLimit(key, limit, windowMs, now);
      }
    } catch (error) {
      this.logger.error(`Rate limit check failed: ${getErrorMessage(error)}`);
      // FIXED: Fail open on errors
      return {
        allowed: true,
        limit,
        remaining: limit - 1,
        resetTime: new Date(now + windowMs),
        totalHits: 1,
      };
    }
  }

  private async checkRedisRateLimit(
    key: string,
    limit: number,
    windowMs: number,
    now: number
  ): Promise<RateLimitResult> {
    // FIXED: Atomic Redis operations using Lua script
    const luaScript = `
      local key = KEYS[1]
      local window_start = ARGV[1]
      local now = ARGV[2]
      local limit = tonumber(ARGV[3])
      local window_ms = tonumber(ARGV[4])
      
      -- Remove expired entries
      redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
      
      -- Count current requests in window
      local current_requests = redis.call('ZCARD', key)
      
      -- Check if limit exceeded
      if current_requests >= limit then
        local oldest_entry = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2]
        local reset_time = oldest_entry and (oldest_entry + window_ms) or (now + window_ms)
        return {0, limit, 0, reset_time, current_requests}
      end
      
      -- Add current request
      redis.call('ZADD', key, now, now)
      redis.call('EXPIRE', key, math.ceil(window_ms / 1000))
      
      local remaining = limit - current_requests - 1
      local reset_time = now + window_ms
      
      return {1, limit, remaining, reset_time, current_requests + 1}
    `;

    const windowStart = now - windowMs;
    const result = await this.redis.eval(
      luaScript,
      1,
      key,
      windowStart.toString(),
      now.toString(),
      limit.toString(),
      windowMs.toString()
    ) as number[];

    return {
      allowed: result[0] === 1,
      limit: result[1],
      remaining: result[2],
      resetTime: new Date(result[3]),
      totalHits: result[4],
    };
  }

  private checkFallbackRateLimit(
    key: string,
    limit: number,
    windowMs: number,
    now: number
  ): RateLimitResult {
    const data = this.fallbackStorage.get(key);
    
    if (!data || data.resetTime <= now) {
      // FIXED: New window or expired
      this.fallbackStorage.set(key, {
        count: 1,
        resetTime: now + windowMs,
      });
      
      return {
        allowed: true,
        limit,
        remaining: limit - 1,
        resetTime: new Date(now + windowMs),
        totalHits: 1,
      };
    }

    // FIXED: Within existing window
    if (data.count >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetTime: new Date(data.resetTime),
        totalHits: data.count,
      };
    }

    // FIXED: Thread-safe increment
    data.count++;
    return {
      allowed: true,
      limit,
      remaining: limit - data.count,
      resetTime: new Date(data.resetTime),
      totalHits: data.count,
    };
  }

  // Additional helper methods...
  async clearRateLimit(identifier: string, keyPrefix = 'rl'): Promise<boolean> {
    const key = `${keyPrefix}:${identifier}`;

    try {
      if (this.isRedisAvailable) {
        const result = await this.redis.del(key);
        return result > 0;
      } else {
        return this.fallbackStorage.delete(key);
      }
    } catch (error) {
      this.logger.error(`Failed to clear rate limit: ${getErrorMessage(error)}`);
      return false;
    }
  }

  async getHealthStatus(): Promise<any> {
    return {
      redis: this.isRedisAvailable,
      fallbackActive: !this.isRedisAvailable,
      totalKeys: this.isRedisAvailable ? await this.redis.dbsize() : this.fallbackStorage.size,
    };
  }
}