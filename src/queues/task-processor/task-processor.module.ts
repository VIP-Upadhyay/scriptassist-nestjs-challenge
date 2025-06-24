import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaskProcessorService } from './task-processor.service';
import { TasksModule } from '../../modules/tasks/tasks.module';
import { Task } from '../../modules/tasks/entities/task.entity';
import { CacheModule } from '../../common/modules/cache.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'task-processing',
    }),
    TypeOrmModule.forFeature([Task]),
    TasksModule,
    CacheModule,
  ],
  providers: [TaskProcessorService],
  exports: [TaskProcessorService],
})
export class TaskProcessorModule {} 