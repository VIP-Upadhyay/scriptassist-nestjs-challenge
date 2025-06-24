import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CacheService } from '../services/cache.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private cacheService: CacheService) {}

  @Get()
  @ApiOperation({ summary: 'General health check' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  async healthCheck() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV,
    };
  }

  @Get('cache')
  @ApiOperation({ summary: 'Cache service health check' })
  @ApiResponse({ status: 200, description: 'Cache service status' })
  async cacheHealth() {
    const health = await this.cacheService.healthCheck();
    const stats = await this.cacheService.getStats();

    return {
      ...health,
      timestamp: new Date().toISOString(),
      performance: {
        hitRate: stats.hits / (stats.hits + stats.misses) || 0,
        totalOperations: stats.hits + stats.misses + stats.sets + stats.deletes,
        errorRate: stats.errors / (stats.hits + stats.misses + stats.sets + stats.deletes) || 0,
      },
    };
  }

  @Get('cache/stats')
  @ApiOperation({ summary: 'Detailed cache statistics' })
  @ApiResponse({ status: 200, description: 'Cache statistics' })
  async cacheStats() {
    return this.cacheService.getStats();
  }
}