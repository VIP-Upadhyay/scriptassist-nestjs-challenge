import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
// import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { UsersModule } from './modules/users/users.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { AuthModule } from './modules/auth/auth.module';
import { TaskProcessorModule } from './queues/task-processor/task-processor.module';
import { ScheduledTasksModule } from './queues/scheduled-tasks/scheduled-tasks.module';
import { CacheModule } from './common/modules/cache.module'; // FIXED: Use proper cache module
import { RateLimitModule } from '@common/modules/rate-limit.module';


// Import the config files
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import appConfig from './config/app.config';
import bullConfig from './config/bull.config';

@Module({
  imports: [
    // Configuration - FIXED: Load all config files
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, jwtConfig, appConfig, bullConfig], // Add config files here
    }),
    
    // Database
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DB_HOST'),
        port: configService.get('DB_PORT'),
        username: configService.get('DB_USERNAME'),
        password: configService.get('DB_PASSWORD'),
        database: configService.get('DB_DATABASE'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: configService.get('NODE_ENV') === 'development',
        logging: configService.get('NODE_ENV') === 'development',
      }),
    }),
    
    // Scheduling
    ScheduleModule.forRoot(),
    
    // Queue - OPTIMIZED: Use enhanced Bull config
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: configService.get('bull.connection'),
        defaultJobOptions: configService.get('bull.defaultJobOptions'),
        settings: configService.get('bull.settings'),
      }),
    }),

     // Register individual queues
    BullModule.registerQueueAsync({
      name: 'task-processing',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: configService.get('bull.connection'),
        defaultJobOptions: configService.get('bull.queues.task-processing.defaultJobOptions'),
        settings: configService.get('bull.queues.task-processing.settings'),
      }),
    }),
    
    BullModule.registerQueueAsync({
      name: 'dead-letter-queue',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: configService.get('bull.deadLetterQueue.connection'),
        defaultJobOptions: configService.get('bull.deadLetterQueue.defaultJobOptions'),
      }),
    }),
    
    // Rate limiting
    // ThrottlerModule.forRootAsync({
    //   imports: [ConfigModule],
    //   inject: [ConfigService],
    //   useFactory: (configService: ConfigService) => ([
    //     {
    //       ttl: 60,
    //       limit: 10,
    //     },
    //   ]),
    // }),

    // ADD NEW RATE LIMITING MODULE:
    RateLimitModule,

    // FIXED: Proper cache module instead of direct service
    CacheModule,
    // Feature modules
    UsersModule,
    TasksModule,
    AuthModule,
    
    // Queue processing modules
    TaskProcessorModule,
    ScheduledTasksModule,
  ],
  // FIXED: Removed global cache service - now handled by CacheModule
  
})
export class AppModule {}