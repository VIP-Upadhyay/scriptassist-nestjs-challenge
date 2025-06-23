import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { Task } from './entities/task.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Task]),
    BullModule.registerQueue({
      name: 'task-processing',
    }),
    AuthModule, // Import AuthModule to use JwtAuthGuard
  ],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [
    TasksService,
    TypeOrmModule, // This exports the Task repository
  ],
})
export class TasksModule {} 