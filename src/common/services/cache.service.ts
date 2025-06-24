import { getErrorMessage } from '@common/utils/error.util';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

interface CacheOptions {
  ttl?: number; // Time to live in seconds
  namespace?: string; // Key namespace for organization
  compress?: boolean; // Enable compression for large values
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
  totalKeys: number;
  memoryUsage: string;
}

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis;
  private fallbackCache = new Map<string, { value: any; expiresAt: number }>();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    errors: 0,
    totalKeys: 0,
    memoryUsage: '0KB',
  };
  
  private readonly DEFAULT_TTL = 300; // 5 minutes
  private readonly MAX_FALLBACK_SIZE = 1000; // Limit fallback cache size
  private readonly KEY_PREFIX = 'taskflow:';
  private cleanupInterval: NodeJS.Timeout;
  private isRedisAvailable = false;

  constructor(private configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.initializeRedis();
    this.startCleanupInterval();
    this.logger.log('Cache service initialized');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    if (this.redis) {
      await this.redis.quit();
    }
    
    this.fallbackCache.clear();
    this.logger.log('Cache service destroyed');
  }

  private async initializeRedis(): Promise<void> {
    try {
      // Use the same Redis connection settings as Bull but with cache-specific DB
      const redisConfig = {
        host: this.configService.get('REDIS_HOST', 'localhost'),
        port: this.configService.get('REDIS_PORT', 6379),
        password: this.configService.get('REDIS_PASSWORD'),
        db: this.configService.get('REDIS_CACHE_DB', 0), // Use cache-specific DB
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
        lazyConnect: true,
        keepAlive: 30000,
        connectTimeout: 10000,
        commandTimeout: 5000,
      };

      this.redis = new Redis(redisConfig);

      this.redis.on('connect', () => {
        this.isRedisAvailable = true;
        this.logger.log(`Redis cache connected (DB: ${redisConfig.db})`);
      });

      this.redis.on('error', (error) => {
        this.isRedisAvailable = false;
        this.logger.warn(`Redis cache error: ${getErrorMessage(error)}. Falling back to in-memory cache.`);
      });

      this.redis.on('reconnecting', () => {
        this.logger.log('Redis cache reconnecting...');
      });

      // Test connection
      await this.redis.ping();
      this.isRedisAvailable = true;
      
    } catch (error) {
      this.isRedisAvailable = false;
      this.logger.warn(`Failed to initialize Redis cache: ${getErrorMessage(error)}. Using in-memory fallback.`);
    }
  }

  private startCleanupInterval(): void {
    // Clean up expired fallback cache entries every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupFallbackCache();
      this.updateStats();
    }, 5 * 60 * 1000);
  }

  private cleanupFallbackCache(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, item] of this.fallbackCache.entries()) {
      if (item.expiresAt < now) {
        this.fallbackCache.delete(key);
        cleaned++;
      }
    }

    // Enforce size limit with LRU eviction
    if (this.fallbackCache.size > this.MAX_FALLBACK_SIZE) {
      const sortedEntries = Array.from(this.fallbackCache.entries())
        .sort(([, a], [, b]) => a.expiresAt - b.expiresAt);
      
      const toRemove = this.fallbackCache.size - this.MAX_FALLBACK_SIZE;
      for (let i = 0; i < toRemove; i++) {
        this.fallbackCache.delete(sortedEntries[i][0]);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired cache entries`);
    }
  }

  private buildKey(key: string, namespace?: string): string {
    const ns = namespace || 'default';
    return `${this.KEY_PREFIX}${ns}:${key}`;
  }

  private serializeValue(value: any, compress = false): string {
    try {
      const serialized = JSON.stringify(value);
      
      if (compress && serialized.length > 1024) {
        // For large values, you could implement compression here
        // For now, just return the serialized value
        return serialized;
      }
      
      return serialized;
    } catch (error) {
      this.logger.error(`Failed to serialize cache value: ${getErrorMessage(error)}`);
      throw new Error('Cache serialization failed');
    }
  }

  private deserializeValue<T>(value: string): T {
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      this.logger.error(`Failed to deserialize cache value: ${getErrorMessage(error)}`);
      throw new Error('Cache deserialization failed');
    }
  }

  async set<T>(key: string, value: T, options: CacheOptions = {}): Promise<void> {
    const { ttl = this.DEFAULT_TTL, namespace, compress = false } = options;
    const cacheKey = this.buildKey(key, namespace);

    try {
      const serializedValue = this.serializeValue(value, compress);

      if (this.isRedisAvailable) {
        await this.redis.setex(cacheKey, ttl, serializedValue);
      } else {
        // Fallback to in-memory cache
        const expiresAt = Date.now() + ttl * 1000;
        this.fallbackCache.set(cacheKey, {
          value: this.deepClone(value), // Clone to prevent mutations
          expiresAt,
        });
      }

      this.stats.sets++;
      this.logger.debug(`Cache set: ${cacheKey} (TTL: ${ttl}s)`);
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error(`Cache set failed for key ${cacheKey}: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async get<T>(key: string, options: CacheOptions = {}): Promise<T | null> {
    const { namespace } = options;
    const cacheKey = this.buildKey(key, namespace);

    try {
      let value: string | null = null;

      if (this.isRedisAvailable) {
        value = await this.redis.get(cacheKey);
      } else {
        // Check fallback cache
        const item = this.fallbackCache.get(cacheKey);
        
        if (item) {
          if (item.expiresAt < Date.now()) {
            this.fallbackCache.delete(cacheKey);
            value = null;
          } else {
            value = this.serializeValue(item.value);
          }
        }
      }

      if (value !== null) {
        this.stats.hits++;
        this.logger.debug(`Cache hit: ${cacheKey}`);
        return this.deserializeValue<T>(value);
      } else {
        this.stats.misses++;
        this.logger.debug(`Cache miss: ${cacheKey}`);
        return null;
      }
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error(`Cache get failed for key ${cacheKey}: ${getErrorMessage(error)}`);
      return null; // Graceful degradation
    }
  }

  async delete(key: string, options: CacheOptions = {}): Promise<boolean> {
    const { namespace } = options;
    const cacheKey = this.buildKey(key, namespace);

    try {
      let deleted = false;

      if (this.isRedisAvailable) {
        const result = await this.redis.del(cacheKey);
        deleted = result > 0;
      } else {
        deleted = this.fallbackCache.delete(cacheKey);
      }

      if (deleted) {
        this.stats.deletes++;
        this.logger.debug(`Cache delete: ${cacheKey}`);
      }

      return deleted;
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error(`Cache delete failed for key ${cacheKey}: ${getErrorMessage(error)}`);
      return false;
    }
  }

  async clear(namespace?: string): Promise<void> {
    try {
      if (this.isRedisAvailable) {
        if (namespace) {
          const pattern = this.buildKey('*', namespace);
          const keys = await this.redis.keys(pattern);
          
          if (keys.length > 0) {
            await this.redis.del(...keys);
          }
        } else {
          const pattern = `${this.KEY_PREFIX}*`;
          const keys = await this.redis.keys(pattern);
          
          if (keys.length > 0) {
            await this.redis.del(...keys);
          }
        }
      } else {
        if (namespace) {
          const prefix = this.buildKey('', namespace);
          for (const key of this.fallbackCache.keys()) {
            if (key.startsWith(prefix)) {
              this.fallbackCache.delete(key);
            }
          }
        } else {
          this.fallbackCache.clear();
        }
      }

      this.logger.log(`Cache cleared${namespace ? ` for namespace: ${namespace}` : ''}`);
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error(`Cache clear failed: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async has(key: string, options: CacheOptions = {}): Promise<boolean> {
    const { namespace } = options;
    const cacheKey = this.buildKey(key, namespace);

    try {
      if (this.isRedisAvailable) {
        const exists = await this.redis.exists(cacheKey);
        return exists === 1;
      } else {
        const item = this.fallbackCache.get(cacheKey);
        
        if (item) {
          if (item.expiresAt < Date.now()) {
            this.fallbackCache.delete(cacheKey);
            return false;
          }
          return true;
        }
        
        return false;
      }
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error(`Cache has failed for key ${cacheKey}: ${getErrorMessage(error)}`);
      return false;
    }
  }

  async mget<T>(keys: string[], options: CacheOptions = {}): Promise<(T | null)[]> {
    const { namespace } = options;
    const cacheKeys = keys.map(key => this.buildKey(key, namespace));

    try {
      if (this.isRedisAvailable) {
        const values = await this.redis.mget(...cacheKeys);
        return values.map(value => 
          value ? this.deserializeValue<T>(value) : null
        );
      } else {
        // Fallback implementation
        return cacheKeys.map(cacheKey => {
          const item = this.fallbackCache.get(cacheKey);
          
          if (item && item.expiresAt >= Date.now()) {
            return item.value as T;
          }
          
          return null;
        });
      }
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error(`Cache mget failed: ${getErrorMessage(error)}`);
      return keys.map(() => null);
    }
  }

  async mset<T>(keyValuePairs: Record<string, T>, options: CacheOptions = {}): Promise<void> {
    const { ttl = this.DEFAULT_TTL, namespace } = options;

    try {
      if (this.isRedisAvailable) {
        const pipeline = this.redis.pipeline();
        
        for (const [key, value] of Object.entries(keyValuePairs)) {
          const cacheKey = this.buildKey(key, namespace);
          const serializedValue = this.serializeValue(value);
          pipeline.setex(cacheKey, ttl, serializedValue);
        }
        
        await pipeline.exec();
      } else {
        // Fallback implementation
        const expiresAt = Date.now() + ttl * 1000;
        
        for (const [key, value] of Object.entries(keyValuePairs)) {
          const cacheKey = this.buildKey(key, namespace);
          this.fallbackCache.set(cacheKey, {
            value: this.deepClone(value),
            expiresAt,
          });
        }
      }

      this.stats.sets += Object.keys(keyValuePairs).length;
      this.logger.debug(`Cache mset: ${Object.keys(keyValuePairs).length} keys`);
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error(`Cache mset failed: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async expire(key: string, ttl: number, options: CacheOptions = {}): Promise<boolean> {
    const { namespace } = options;
    const cacheKey = this.buildKey(key, namespace);

    try {
      if (this.isRedisAvailable) {
        const result = await this.redis.expire(cacheKey, ttl);
        return result === 1;
      } else {
        const item = this.fallbackCache.get(cacheKey);
        
        if (item) {
          item.expiresAt = Date.now() + ttl * 1000;
          return true;
        }
        
        return false;
      }
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error(`Cache expire failed for key ${cacheKey}: ${getErrorMessage(error)}`);
      return false;
    }
  }

  async getStats(): Promise<CacheStats> {
    await this.updateStats();
    return { ...this.stats };
  }

  private async updateStats(): Promise<void> {
    try {
      if (this.isRedisAvailable) {
        const info = await this.redis.info('memory');
        const memoryMatch = info.match(/used_memory_human:([^\r\n]+)/);
        this.stats.memoryUsage = memoryMatch ? memoryMatch[1].trim() : 'Unknown';
        
        // Get total keys
        const dbSize = await this.redis.dbsize();
        this.stats.totalKeys = dbSize;
      } else {
        this.stats.totalKeys = this.fallbackCache.size;
        
        // Estimate memory usage for fallback cache
        const estimatedSize = this.fallbackCache.size * 100; // Rough estimate
        this.stats.memoryUsage = `${Math.round(estimatedSize / 1024)}KB`;
      }
    } catch (error) {
      this.logger.warn(`Failed to update cache stats: ${getErrorMessage(error)}`);
    }
  }

  private deepClone<T>(obj: T): T {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return obj; // Return original if cloning fails
    }
  }

  // Health check method
  async healthCheck(): Promise<{ status: string; details: any }> {
    const details = {
      redis: this.isRedisAvailable ? 'connected' : 'disconnected',
      fallbackCacheSize: this.fallbackCache.size,
      stats: await this.getStats(),
    };

    const status = this.isRedisAvailable ? 'healthy' : 'degraded';

    return { status, details };
  }

  // Utility methods for common caching patterns
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    let value = await this.get<T>(key, options);
    
    if (value === null) {
      value = await factory();
      await this.set(key, value, options);
    }
    
    return value;
  }

  async invalidatePattern(pattern: string, namespace?: string): Promise<number> {
    try {
      if (this.isRedisAvailable) {
        const searchPattern = this.buildKey(pattern, namespace);
        const keys = await this.redis.keys(searchPattern);
        
        if (keys.length > 0) {
          await this.redis.del(...keys);
          return keys.length;
        }
        
        return 0;
      } else {
        const prefix = this.buildKey('', namespace);
        let deleted = 0;
        
        for (const key of this.fallbackCache.keys()) {
          if (key.startsWith(prefix) && key.includes(pattern)) {
            this.fallbackCache.delete(key);
            deleted++;
          }
        }
        
        return deleted;
      }
    } catch (error) {
      this.logger.error(`Failed to invalidate pattern ${pattern}: ${getErrorMessage(error)}`);
      return 0;
    }
  }
}