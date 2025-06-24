
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OverdueTasksService } from './overdue-tasks.service';
import { TasksModule } from '../../modules/tasks/tasks.module';
import { Task } from '../../modules/tasks/entities/task.entity';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.registerQueue({
      name: 'task-processing',
    }),
    TypeOrmModule.forFeature([Task]),
    TasksModule,
  ],
  providers: [OverdueTasksService],
  exports: [OverdueTasksService],
})
export class ScheduledTasksModule {} 