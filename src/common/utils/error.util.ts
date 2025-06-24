/**
 * Utility functions for error handling across the application
 */

export class ErrorUtil {
  /**
   * Safely extract error message from unknown error type
   * @param error - Unknown error object
   * @returns Error message string
   */
  static getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    
    if (typeof error === 'string') {
      return error;
    }
    
    if (error && typeof error === 'object' && 'message' in error) {
      return String((error as any).message);
    }
    
    return 'Unknown error occurred';
  }

  /**
   * Extract error stack trace safely
   * @param error - Unknown error object
   * @returns Stack trace string or undefined
   */
  static getErrorStack(error: unknown): string | undefined {
    if (error instanceof Error) {
      return error.stack;
    }
    
    if (error && typeof error === 'object' && 'stack' in error) {
      return String((error as any).stack);
    }
    
    return undefined;
  }

  /**
   * Get error name/type safely
   * @param error - Unknown error object
   * @returns Error name or 'UnknownError'
   */
  static getErrorName(error: unknown): string {
    if (error instanceof Error) {
      return error.name;
    }
    
    if (error && typeof error === 'object' && 'name' in error) {
      return String((error as any).name);
    }
    
    return 'UnknownError';
  }

  /**
   * Create a formatted error object for logging
   * @param error - Unknown error object
   * @param context - Additional context information
   * @returns Formatted error object
   */
  static formatError(error: unknown, context?: Record<string, any>) {
    return {
      message: ErrorUtil.getErrorMessage(error),
      name: ErrorUtil.getErrorName(error),
      stack: ErrorUtil.getErrorStack(error),
      timestamp: new Date().toISOString(),
      ...context,
    };
  }

  /**
   * Check if error is of a specific type
   * @param error - Error to check
   * @param errorClass - Error class to check against
   * @returns True if error is instance of errorClass
   */
  static isErrorOfType<T extends Error>(
    error: unknown,
    errorClass: new (...args: any[]) => T
  ): error is T {
    return error instanceof errorClass;
  }

  /**
   * Handle async errors with proper logging
   * @param fn - Async function to execute
   * @param context - Context for logging
   * @param fallback - Fallback value on error
   * @returns Result or fallback value
   */
  static async handleAsync<T>(
    fn: () => Promise<T>,
    context: string,
    fallback?: T
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      console.error(`Error in ${context}:`, ErrorUtil.formatError(error, { context }));
      return fallback;
    }
  }

  /**
   * Wrap sync function with error handling
   * @param fn - Function to execute
   * @param context - Context for logging
   * @param fallback - Fallback value on error
   * @returns Result or fallback value
   */
  static handleSync<T>(
    fn: () => T,
    context: string,
    fallback?: T
  ): T | undefined {
    try {
      return fn();
    } catch (error) {
      console.error(`Error in ${context}:`, ErrorUtil.formatError(error, { context }));
      return fallback;
    }
  }

  /**
   * Extract HTTP status code from error if available
   * @param error - Error object
   * @returns HTTP status code or 500
   */
  static getHttpStatus(error: unknown): number {
    if (error && typeof error === 'object') {
      // NestJS HttpException
      if ('getStatus' in error && typeof (error as any).getStatus === 'function') {
        return (error as any).getStatus();
      }
      
      // Custom status property
      if ('status' in error && typeof (error as any).status === 'number') {
        return (error as any).status;
      }
      
      // HTTP status code property
      if ('statusCode' in error && typeof (error as any).statusCode === 'number') {
        return (error as any).statusCode;
      }
    }
    
    return 500; // Internal Server Error
  }

  /**
   * Check if error indicates a temporary failure that might be retryable
   * @param error - Error to check
   * @returns True if error might be retryable
   */
  static isRetryableError(error: unknown): boolean {
    const message = ErrorUtil.getErrorMessage(error).toLowerCase();
    const status = ErrorUtil.getHttpStatus(error);
    
    // Network/connection errors
    if (message.includes('timeout') || 
        message.includes('connection') || 
        message.includes('network') ||
        message.includes('econnreset') ||
        message.includes('enotfound')) {
      return true;
    }
    
    // HTTP status codes that might be retryable
    const retryableStatuses = [408, 429, 500, 502, 503, 504];
    return retryableStatuses.includes(status);
  }

  /**
   * Sanitize error for safe logging (remove sensitive information)
   * @param error - Error to sanitize
   * @returns Sanitized error object
   */
  static sanitizeError(error: unknown): Record<string, any> {
    const formatted = ErrorUtil.formatError(error);
    
    // Remove sensitive information from error messages
    const sensitivePatterns = [
      /password[=:]\s*\S+/gi,
      /token[=:]\s*\S+/gi,
      /key[=:]\s*\S+/gi,
      /secret[=:]\s*\S+/gi,
      /authorization[=:]\s*\S+/gi,
    ];
    
    if (formatted.message) {
      sensitivePatterns.forEach(pattern => {
        formatted.message = formatted.message.replace(pattern, '[REDACTED]');
      });
    }
    
    
    return formatted;
  }
}

// Convenience functions for common use cases
export const getErrorMessage = ErrorUtil.getErrorMessage;
export const formatError = ErrorUtil.formatError;
export const isRetryableError = ErrorUtil.isRetryableError;
export const sanitizeError = ErrorUtil.sanitizeError;