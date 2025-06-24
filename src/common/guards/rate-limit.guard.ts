import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitService } from '../services/rate-limit.service';
import { RATE_LIMIT_KEY } from '../decorators/rate-limit.decorator';
import { getErrorMessage } from '@common/utils/error.util';

export interface RateLimitResponse {
  statusCode: number;
  error: string;
  message: string;
  retryAfter: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private rateLimitService: RateLimitService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Get rate limit configuration from decorator
    const rateLimitConfig = this.reflector.getAllAndOverride(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!rateLimitConfig) {
      // No rate limiting configured, allow request
      return true;
    }

    // Generate secure identifier for rate limiting
    const identifier = this.generateSecureIdentifier(request, rateLimitConfig);
    
    try {
      const result = await this.rateLimitService.checkRateLimit(
        identifier,
        {
          limit: rateLimitConfig.limit,
          windowMs: rateLimitConfig.windowMs,
          keyPrefix: rateLimitConfig.keyPrefix || 'rl',
          message: rateLimitConfig.message,
        }
      );

      // Add rate limit headers
      this.addRateLimitHeaders(response, result);

      if (!result.allowed) {
        const resetTime = Math.ceil((result.resetTime.getTime() - Date.now()) / 1000);
        
        this.logger.warn(`Rate limit exceeded for ${identifier.substring(0, 20)}... Reset in ${resetTime}s`);
        
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            message: rateLimitConfig.message || 'Rate limit exceeded. Please try again later.',
            retryAfter: resetTime,
            // FIXED: Don't expose sensitive information
            remaining: 0,
          } as RateLimitResponse,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      this.logger.debug(`Rate limit check passed: ${result.remaining} remaining`);
      return true;

    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(`Rate limit check failed: ${getErrorMessage(error)}`);
      // FIXED: Fail open - allow request if rate limiting fails
      return true;
    }
  }

  private generateSecureIdentifier(request: any, config: any): string {
    const user = request.user;
    const ip = this.getClientIp(request);
    const route = request.route?.path || request.url;

    // FIXED: Create compound identifier based on available data
    const parts = [config.keyPrefix || 'rl'];

    // FIXED: Prefer user ID over IP for authenticated requests
    if (user?.id) {
      parts.push('user', user.id);
    } else {
      // FIXED: Hash IP for privacy compliance
      const hashedIp = this.hashIp(ip);
      parts.push('ip', hashedIp);
    }

    // Add route for endpoint-specific limiting
    if (route) {
      parts.push('route', route.replace(/[^a-zA-Z0-9]/g, '_'));
    }

    return parts.join(':');
  }

  private getClientIp(request: any): string {
    // FIXED: Better IP detection with proxy support
    return (
      request.headers['x-forwarded-for']?.split(',')[0] ||
      request.headers['x-real-ip'] ||
      request.connection?.remoteAddress ||
      request.socket?.remoteAddress ||
      request.ip ||
      'unknown'
    );
  }

  private hashIp(ip: string): string {
    // FIXED: Simple hash for IP privacy (you could use crypto for production)
    let hash = 0;
    for (let i = 0; i < ip.length; i++) {
      const char = ip.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  private addRateLimitHeaders(response: any, result: any): void {
    response.setHeader('X-RateLimit-Limit', result.limit);
    response.setHeader('X-RateLimit-Remaining', result.remaining);
    response.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime.getTime() / 1000));
    
    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetTime.getTime() - Date.now()) / 1000);
      response.setHeader('Retry-After', retryAfter);
    }
  }
}