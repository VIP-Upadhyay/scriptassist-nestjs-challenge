import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheService } from '../services/cache.service';
import { HealthController } from '@common/controllers/health.controller';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [CacheService],
  exports: [CacheService],
  controllers: [HealthController]
})
export class CacheModule {}