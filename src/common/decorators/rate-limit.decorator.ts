import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate_limit';

export interface RateLimitOptions {
  limit: number;           // Max requests
  windowMs: number;        // Time window in milliseconds
  keyPrefix?: string;      // Custom key prefix
  message?: string;        // Custom error message
}

// FIXED: Decorator that actually works with the guard
export const RateLimit = (options: RateLimitOptions) => {
  return SetMetadata(RATE_LIMIT_KEY, options);
};

// FIXED: Predefined rate limiting configurations
export const RateLimitPresets = {
  // Very strict for auth endpoints
  AUTH: { 
    limit: 5, 
    windowMs: 60000, 
    keyPrefix: 'auth',
    message: 'Too many authentication attempts' 
  },
  
  // Moderate for API endpoints
  API: { 
    limit: 100, 
    windowMs: 60000, 
    keyPrefix: 'api',
    message: 'API rate limit exceeded' 
  },
  
  // Lenient for general endpoints
  GENERAL: { 
    limit: 1000, 
    windowMs: 60000, 
    keyPrefix: 'general',
    message: 'Rate limit exceeded' 
  },
  
  // Strict for expensive operations
  EXPENSIVE: { 
    limit: 10, 
    windowMs: 60000, 
    keyPrefix: 'expensive',
    message: 'Too many requests for expensive operation' 
  },
};