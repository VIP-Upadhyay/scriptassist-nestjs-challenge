import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
    timestamp: string;
    path: string;
    method: string;
    statusCode: number;
    requestId: string;
  };
  meta: {
    version: string;
    environment: string;
  };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    
    // Generate or get request ID for tracing
    const requestId = (request as any).requestId || 
                     request.headers['x-request-id'] as string || 
                     uuidv4();

    let status: number;
    let errorCode: string;
    let message: string;
    let details: any = null;

    // Handle different types of exceptions
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const errorResponse = exception.getResponse();
      
      if (typeof errorResponse === 'object' && errorResponse !== null) {
        const errorObj = errorResponse as any;
        message = this.extractMessage(errorObj.message) || exception.message;
        errorCode = this.getErrorCode(status, errorObj.error);
        details = this.sanitizeDetails(errorObj.details || errorObj.errors);
      } else {
        message = errorResponse as string;
        errorCode = this.getErrorCode(status);
      }
    } else if (exception instanceof Error) {
      // Handle non-HTTP errors
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = this.isProduction() ? 'Internal server error occurred' : exception.message;
      errorCode = 'INTERNAL_SERVER_ERROR';
      
      // Log full error details for debugging (only in non-production)
      this.logInternalError(exception, request, requestId);
    } else {
      // Handle unknown error types
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'An unexpected error occurred';
      errorCode = 'UNKNOWN_ERROR';
      
      this.logger.error(
        `Unknown error type encountered`,
        {
          error: String(exception),
          requestId,
          path: request.url,
          method: request.method,
        }
      );
    }

    // Create standardized error response
    const errorResponse: ErrorResponse = {
      success: false,
      error: {
        code: errorCode,
        message,
        details: this.isProduction() ? this.sanitizeDetailsForProduction(details) : details,
        timestamp: new Date().toISOString(),
        path: request.url,
        method: request.method,
        statusCode: status,
        requestId,
      },
      meta: {
        version: process.env.npm_package_version || '1.0.0',
        environment: process.env.NODE_ENV || 'development',
      },
    };

    // Log based on error severity
    this.logError(status, errorCode, message, request, requestId, details);

    // Add security headers
    response.setHeader('X-Request-ID', requestId);
    response.setHeader('X-Content-Type-Options', 'nosniff');

    // Send response
    response.status(status).json(errorResponse);
  }

  private extractMessage(message: any): string {
    if (Array.isArray(message)) {
      return message.join(', ');
    }
    if (typeof message === 'string') {
      return message;
    }
    if (typeof message === 'object' && message !== null) {
      return JSON.stringify(message);
    }
    return String(message);
  }

  private getErrorCode(status: number, customError?: string): string {
    if (customError) {
      return customError.toUpperCase().replace(/\s+/g, '_');
    }

    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.METHOD_NOT_ALLOWED:
        return 'METHOD_NOT_ALLOWED';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'VALIDATION_ERROR';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMIT_EXCEEDED';
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return 'INTERNAL_SERVER_ERROR';
      case HttpStatus.BAD_GATEWAY:
        return 'BAD_GATEWAY';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'SERVICE_UNAVAILABLE';
      case HttpStatus.GATEWAY_TIMEOUT:
        return 'GATEWAY_TIMEOUT';
      default:
        return 'HTTP_ERROR';
    }
  }

  private sanitizeDetails(details: any): any {
    if (!details) return null;
    
    if (typeof details === 'object') {
      const sanitized = Array.isArray(details) ? [...details] : { ...details };
      this.removeSensitiveFields(sanitized);
      return sanitized;
    }
    
    return details;
  }

  private sanitizeDetailsForProduction(details: any): any {
    if (!details) return null;
    
    // In production, be more restrictive about what details we expose
    if (Array.isArray(details)) {
      return details.map(detail => {
        if (typeof detail === 'object' && detail !== null) {
          return {
            field: detail.field || detail.property,
            message: detail.message || detail.constraints,
          };
        }
        return String(detail);
      });
    }
    
    if (typeof details === 'object' && details !== null) {
      return {
        type: details.type || 'validation_error',
        count: Array.isArray(details.errors) ? details.errors.length : 1,
      };
    }
    
    return null;
  }

  private removeSensitiveFields(obj: any): void {
    if (!obj || typeof obj !== 'object') return;

    const sensitiveFields = [
      'password', 'token', 'secret', 'key', 'authorization',
      'jwt', 'refresh_token', 'access_token', 'apiKey', 'privateKey',
      'ssn', 'creditCard', 'cvv', 'pin', 'hash'
    ];

    if (Array.isArray(obj)) {
      obj.forEach(item => this.removeSensitiveFields(item));
    } else {
      Object.keys(obj).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (sensitiveFields.some(field => lowerKey.includes(field))) {
          obj[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object') {
          this.removeSensitiveFields(obj[key]);
        }
      });
    }
  }

  private logError(
    status: number, 
    errorCode: string, 
    message: string, 
    request: Request, 
    requestId: string,
    details?: any
  ): void {
    const logContext = {
      requestId,
      path: request.url,
      method: request.method,
      statusCode: status,
      userAgent: request.headers['user-agent'],
      ip: this.getClientIp(request),
      userId: (request as any).user?.id,
    };

    const logMessage = `${status} ${errorCode}: ${message}`;

    if (status >= 500) {
      // Server errors - always log as error
      this.logger.error(logMessage, {
        ...logContext,
        details: this.isProduction() ? undefined : details,
      });
    } else if (status >= 400) {
      // Client errors - log as warning
      this.logger.warn(logMessage, logContext);
    } else {
      // Other status codes - log as info
      this.logger.log(logMessage, logContext);
    }
  }

  private logInternalError(error: Error, request: Request, requestId: string): void {
    this.logger.error(
      `Internal server error: ${error.message}`,
      {
        stack: error.stack,
        requestId,
        path: request.url,
        method: request.method,
        userAgent: request.headers['user-agent'],
        ip: this.getClientIp(request),
        userId: (request as any).user?.id,
        timestamp: new Date().toISOString(),
      }
    );
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

  private isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  }
}