import { 
  Injectable, 
  NestInterceptor, 
  ExecutionContext, 
  CallHandler, 
  Logger 
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

interface RequestLog {
  requestId: string;
  method: string;
  url: string;
  path: string;
  query: any;
  headers: Record<string, any>;
  userAgent: string;
  ip: string;
  userId?: string;
  userEmail?: string;
  timestamp: string;
  body?: any;
}

interface ResponseLog {
  requestId: string;
  method: string;
  url: string;
  statusCode: number;
  responseTime: number;
  contentLength?: number;
  userId?: string;
  timestamp: string;
  success: boolean;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);
  private readonly MAX_BODY_LOG_SIZE = 1000; // Maximum characters to log from request body
  private readonly SENSITIVE_HEADERS = ['authorization', 'cookie', 'x-api-key'];
  private readonly SENSITIVE_FIELDS = ['password', 'token', 'secret', 'key'];

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();
    
    // Generate or get request ID for tracing
    const requestId = this.getOrCreateRequestId(request);
    
    // Attach request ID to request for use in other parts of the application
    (request as any).requestId = requestId;
    
    // Set response header for tracing
    response.setHeader('X-Request-ID', requestId);

    const startTime = Date.now();

    // Log incoming request
    this.logIncomingRequest(request, requestId);

    return next.handle().pipe(
      tap((data) => {
        // Log successful response
        this.logSuccessfulResponse(request, response, requestId, startTime, data);
      }),
      catchError((error) => {
        // Log error response
        this.logErrorResponse(request, response, requestId, startTime, error);
        throw error; // Re-throw the error
      })
    );
  }

  private getOrCreateRequestId(request: Request): string {
    return (
      (request as any).requestId ||
      request.headers['x-request-id'] as string ||
      uuidv4()
    );
  }

  private logIncomingRequest(request: Request, requestId: string): void {
    const user = (request as any).user;
    const sanitizedHeaders = this.sanitizeHeaders(request.headers);
    const sanitizedBody = this.sanitizeRequestBody(request.body);

    const requestLog: RequestLog = {
      requestId,
      method: request.method,
      url: request.url,
      path: request.route?.path || request.url,
      query: this.sanitizeQuery(request.query),
      headers: sanitizedHeaders,
      userAgent: request.headers['user-agent'] || 'unknown',
      ip: this.getClientIp(request),
      userId: user?.id,
      userEmail: user?.email,
      timestamp: new Date().toISOString(),
      body: this.shouldLogBody(request) ? sanitizedBody : undefined,
    };

    // Use different log levels based on the endpoint
    if (this.isHealthCheck(request)) {
      // Don't log health checks to avoid noise
      return;
    }

    if (this.isAuthEndpoint(request)) {
      // Log auth endpoints with less detail for security
      this.logger.log(
        `${request.method} ${request.url}`,
        {
          requestId,
          ip: requestLog.ip,
          userAgent: requestLog.userAgent,
        }
      );
    } else {
      // Log regular endpoints with full detail
      this.logger.log(
        `${request.method} ${request.url}`,
        requestLog
      );
    }
  }

  private logSuccessfulResponse(
    request: Request, 
    response: Response, 
    requestId: string, 
    startTime: number,
    data: any
  ): void {
    const responseTime = Date.now() - startTime;
    const user = (request as any).user;

    const responseLog: ResponseLog = {
      requestId,
      method: request.method,
      url: request.url,
      statusCode: response.statusCode,
      responseTime,
      contentLength: this.getContentLength(response, data),
      userId: user?.id,
      timestamp: new Date().toISOString(),
      success: true,
    };

    // Skip health check logging
    if (this.isHealthCheck(request)) {
      return;
    }

    // Use different log levels based on response time and status
    const logMessage = `${request.method} ${request.url} ${response.statusCode} - ${responseTime}ms`;

    if (responseTime > 5000) {
      // Very slow responses
      this.logger.warn(`${logMessage}`, responseLog);
    } else if (responseTime > 1000) {
      // Slow responses
      this.logger.log(`${logMessage}`, responseLog);
    } else {
      // Fast responses
      this.logger.log(logMessage, responseLog);
    }

    // Additional metrics logging for monitoring
    if (this.shouldLogMetrics()) {
      this.logMetrics(request, response, responseTime, true);
    }
  }

  private logErrorResponse(
    request: Request, 
    response: Response, 
    requestId: string, 
    startTime: number, 
    error: any
  ): void {
    const responseTime = Date.now() - startTime;
    const user = (request as any).user;

    const responseLog: ResponseLog = {
      requestId,
      method: request.method,
      url: request.url,
      statusCode: error.status || 500,
      responseTime,
      userId: user?.id,
      timestamp: new Date().toISOString(),
      success: false,
    };

    // Skip health check error logging
    if (this.isHealthCheck(request)) {
      return;
    }

    const logMessage = `${request.method} ${request.url} ${error.status || 500} - ${responseTime}ms`;

    // Log with appropriate level based on error type
    if (error.status >= 500) {
      this.logger.error(`${logMessage}`, {
        ...responseLog,
        error: error.message,
        stack: error.stack,
      });
    } else if (error.status >= 400) {
      this.logger.warn(`${logMessage}`, responseLog);
    } else {
      this.logger.log(logMessage, responseLog);
    }

    // Log metrics for errors
    if (this.shouldLogMetrics()) {
      this.logMetrics(request, response, responseTime, false);
    }
  }

  private sanitizeHeaders(headers: any): Record<string, any> {
    const sanitized = { ...headers };
    
    this.SENSITIVE_HEADERS.forEach(header => {
      if (sanitized[header]) {
        sanitized[header] = this.maskSensitiveValue(sanitized[header]);
      }
    });

    // Remove or mask other potentially sensitive headers
    if (sanitized.authorization) {
      sanitized.authorization = this.maskAuthHeader(sanitized.authorization);
    }

    return sanitized;
  }

  private sanitizeRequestBody(body: any): any {
    if (!body || typeof body !== 'object') {
      return body;
    }

    const sanitized = Array.isArray(body) ? [...body] : { ...body };
    this.removeSensitiveFields(sanitized);
    
    // Limit body size for logging
    const bodyString = JSON.stringify(sanitized);
    if (bodyString.length > this.MAX_BODY_LOG_SIZE) {
      return {
        ...sanitized,
        _truncated: true,
        _originalSize: bodyString.length,
      };
    }

    return sanitized;
  }

  private sanitizeQuery(query: any): any {
    if (!query || typeof query !== 'object') {
      return query;
    }

    const sanitized = { ...query };
    this.removeSensitiveFields(sanitized);
    return sanitized;
  }

  private removeSensitiveFields(obj: any): void {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      obj.forEach(item => this.removeSensitiveFields(item));
    } else {
      Object.keys(obj).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (this.SENSITIVE_FIELDS.some(field => lowerKey.includes(field))) {
          obj[key] = this.maskSensitiveValue(obj[key]);
        } else if (typeof obj[key] === 'object') {
          this.removeSensitiveFields(obj[key]);
        }
      });
    }
  }

  private maskSensitiveValue(value: any): string {
    if (typeof value !== 'string') {
      return '[REDACTED]';
    }
    
    if (value.length <= 4) {
      return '***';
    }
    
    return value.substring(0, 4) + '***' + value.substring(value.length - 4);
  }

  private maskAuthHeader(authHeader: string): string {
    if (!authHeader) return '[REDACTED]';
    
    const parts = authHeader.split(' ');
    if (parts.length === 2) {
      return `${parts[0]} ${this.maskSensitiveValue(parts[1])}`;
    }
    
    return '[REDACTED]';
  }

  private getClientIp(request: Request): string {
    return (
      request.headers['x-forwarded-for'] as string ||
      request.headers['x-real-ip'] as string ||
      request.connection?.remoteAddress ||
      request.socket?.remoteAddress ||
      'unknown'
    );
  }

  private getContentLength(response: Response, data: any): number | undefined {
    const contentLength = response.getHeader('content-length');
    if (contentLength) {
      return parseInt(contentLength as string, 10);
    }
    
    if (data) {
      try {
        return JSON.stringify(data).length;
      } catch {
        return undefined;
      }
    }
    
    return undefined;
  }

  private shouldLogBody(request: Request): boolean {
    // Don't log body for certain endpoints
    if (this.isAuthEndpoint(request)) {
      return false; // Never log auth request bodies
    }
    
    if (request.method === 'GET') {
      return false; // GET requests typically don't have meaningful bodies
    }
    
    // Don't log large payloads
    const contentLength = request.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > this.MAX_BODY_LOG_SIZE * 2) {
      return false;
    }
    
    return true;
  }

  private isHealthCheck(request: Request): boolean {
    return (
      request.url === '/health' ||
      request.url === '/health/check' ||
      request.url.includes('/health')
    );
  }

  private isAuthEndpoint(request: Request): boolean {
    return (
      request.url.includes('/auth/') ||
      request.url === '/auth/login' ||
      request.url === '/auth/register' ||
      request.url === '/auth/refresh'
    );
  }

  private shouldLogMetrics(): boolean {
    return process.env.NODE_ENV === 'production' || process.env.LOG_METRICS === 'true';
  }

  private logMetrics(
    request: Request, 
    response: Response, 
    responseTime: number, 
    success: boolean
  ): void {
    // This could be enhanced to send metrics to external monitoring services
    // like DataDog, New Relic, CloudWatch, etc.
    
    const metrics = {
      endpoint: `${request.method} ${request.route?.path || request.url}`,
      responseTime,
      statusCode: response.statusCode,
      success,
      timestamp: Date.now(),
    };

    // In production, you might send this to a metrics service
    this.logger.debug('Metrics', metrics);
  }
}