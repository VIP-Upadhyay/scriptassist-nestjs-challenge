import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { CacheService } from '../services/cache.service';
import { CACHE_KEY, CacheConfig } from '../decorators/cache.decorator';
import { getErrorMessage } from '@common/utils/error.util';

@Injectable()
export class CacheInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CacheInterceptor.name);

  constructor(
    private cacheService: CacheService,
    private reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const cacheConfig = this.reflector.get<CacheConfig>(CACHE_KEY, context.getHandler());

    if (!cacheConfig) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const cacheKey = this.generateCacheKey(context, cacheConfig, request);

    try {
      // Try to get from cache
      const cachedResult = await this.cacheService.get(cacheKey, {
        namespace: cacheConfig.namespace,
      });

      if (cachedResult !== null) {
        this.logger.debug(`Cache hit for key: ${cacheKey}`);
        return of(cachedResult);
      }

      // Cache miss, execute method and cache result
      return next.handle().pipe(
        tap(async (result) => {
          if (result !== undefined && result !== null) {
            await this.cacheService.set(cacheKey, result, {
              ttl: cacheConfig.ttl,
              namespace: cacheConfig.namespace,
            });
            this.logger.debug(`Cached result for key: ${cacheKey}`);
          }
        }),
      );
    } catch (error) {
      this.logger.error(`Cache operation failed: ${getErrorMessage(error)}`);
      // Graceful degradation - continue without cache
      return next.handle();
    }
  }

  private generateCacheKey(
    context: ExecutionContext,
    config: CacheConfig,
    request: any,
  ): string {
    if (config.key) {
      // Use custom key template
      return this.interpolateKey(config.key, context, request);
    }

    // Default key generation
    const className = context.getClass().name;
    const methodName = context.getHandler().name;
    const args = context.getArgs();

    // Create a hash of the arguments for the key
    const argsHash = this.hashArguments(args);

    return `${className}:${methodName}:${argsHash}`;
  }

  private interpolateKey(template: string, context: ExecutionContext, request: any): string {
    return template
      .replace('{className}', context.getClass().name)
      .replace('{methodName}', context.getHandler().name)
      .replace('{userId}', request.user?.id || 'anonymous')
      .replace('{path}', request.route?.path || request.url);
  }

  private hashArguments(args: any[]): string {
    try {
      // Filter out non-serializable arguments (like response objects)
      const serializableArgs = args.filter((arg) => {
        return arg !== null && 
               arg !== undefined && 
               typeof arg !== 'function' &&
               !this.isHttpObject(arg);
      });

      const argsString = JSON.stringify(serializableArgs);
      
      // Simple hash function
      let hash = 0;
      for (let i = 0; i < argsString.length; i++) {
        const char = argsString.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      
      return Math.abs(hash).toString(36);
    } catch (error) {
      // Fallback to timestamp if hashing fails
      return Date.now().toString(36);
    }
  }

  private isHttpObject(obj: any): boolean {
    return obj && (
      obj.constructor?.name === 'IncomingMessage' ||
      obj.constructor?.name === 'ServerResponse' ||
      obj.constructor?.name === 'FastifyRequest' ||
      obj.constructor?.name === 'FastifyReply'
    );
  }
}