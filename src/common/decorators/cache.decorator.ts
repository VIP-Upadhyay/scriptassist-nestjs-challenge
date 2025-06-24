import { SetMetadata } from '@nestjs/common';

export interface CacheConfig {
  ttl?: number; // Time to live in seconds
  key?: string; // Custom cache key template
  namespace?: string; // Cache namespace
  condition?: string; // Condition to cache (SpEL-like expression)
}

export const CACHE_KEY = 'cache';
export const CACHE_TTL_KEY = 'cache_ttl';
export const CACHE_NAMESPACE_KEY = 'cache_namespace';

/**
 * Cache decorator for methods
 * @param config Cache configuration
 */
export const Cache = (config: CacheConfig = {}) => {
  return (target: any, propertyName: string, descriptor: PropertyDescriptor) => {
    SetMetadata(CACHE_KEY, {
      ...config,
      methodName: propertyName,
    })(target, propertyName, descriptor);
  };
};

/**
 * Cache invalidation decorator
 * @param patterns Array of cache key patterns to invalidate
 * @param namespace Cache namespace
 */
export const CacheEvict = (patterns: string[], namespace?: string) => {
  return SetMetadata('cache_evict', { patterns, namespace });
};