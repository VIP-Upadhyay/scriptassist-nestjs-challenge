import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Not, In } from 'typeorm';
import { Task } from '../../modules/tasks/entities/task.entity';
import { TaskStatus } from '../../modules/tasks/enums/task-status.enum';
import { TaskPriority } from '../../modules/tasks/enums/task-priority.enum';
import { TasksService } from '../../modules/tasks/tasks.service';
import { CacheService } from '../../common/services/cache.service';
import { getErrorMessage } from '../../common/utils/error.util';

interface JobMetrics {
  startTime: number;
  endTime?: number;
  duration?: number;
  tasksProcessed: number;
  tasksSuccess: number;
  tasksFailed: number;
  errors: string[];
}

@Injectable()
@Processor('task-processing', {
  concurrency: 5, // Process up to 5 jobs concurrently
  limiter: {
    max: 10, // Max 10 jobs per duration
    duration: 1000, // 1 second
  },
})
export class TaskProcessorService extends WorkerHost {
  private readonly logger = new Logger(TaskProcessorService.name);
  private readonly BATCH_SIZE = 50; // Process tasks in batches
  private readonly MAX_RETRY_ATTEMPTS = 3;

  constructor(
    private readonly tasksService: TasksService,
    @InjectRepository(Task)
    private taskRepository: Repository<Task>,
    private cacheService: CacheService,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    const metrics: JobMetrics = {
      startTime: Date.now(),
      tasksProcessed: 0,
      tasksSuccess: 0,
      tasksFailed: 0,
      errors: [],
    };

    this.logger.log(`Processing job ${job.id} of type ${job.name} (attempt ${job.attemptsMade + 1}/${this.MAX_RETRY_ATTEMPTS})`);
    
    try {
      let result;
      
      switch (job.name) {
        case 'task-created':
          result = await this.handleTaskCreated(job, metrics);
          break;
        case 'task-status-updated':
          result = await this.handleTaskStatusUpdate(job, metrics);
          break;
        case 'task-status-update': // Legacy support
          result = await this.handleLegacyStatusUpdate(job, metrics);
          break;
        case 'process-overdue-tasks':
          result = await this.handleOverdueTasks(job, metrics);
          break;
        case 'overdue-tasks-notification': // Legacy support
          result = await this.handleLegacyOverdueTasks(job, metrics);
          break;
        case 'batch-task-update':
          result = await this.handleBatchTaskUpdate(job, metrics);
          break;
        case 'cleanup-completed-tasks':
          result = await this.handleCleanupCompletedTasks(job, metrics);
          break;
        default:
          const error = `Unknown job type: ${job.name}`;
          this.logger.warn(error);
          metrics.errors.push(error);
          return this.createJobResult(false, metrics, error);
      }

      metrics.endTime = Date.now();
      metrics.duration = metrics.endTime - metrics.startTime;
      
      this.logger.log(`Job ${job.id} completed successfully in ${metrics.duration}ms. Processed: ${metrics.tasksProcessed}, Success: ${metrics.tasksSuccess}, Failed: ${metrics.tasksFailed}`);
      
      return this.createJobResult(true, metrics, undefined, result);
      
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      metrics.errors.push(errorMessage);
      metrics.endTime = Date.now();
      metrics.duration = metrics.endTime - metrics.startTime;
      
      this.logger.error(`Job ${job.id} failed after ${metrics.duration}ms: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
      
      // Determine if job should be retried
      if (job.attemptsMade < this.MAX_RETRY_ATTEMPTS - 1) {
        this.logger.warn(`Job ${job.id} will be retried (attempt ${job.attemptsMade + 2}/${this.MAX_RETRY_ATTEMPTS})`);
        throw error; // Let BullMQ handle the retry
      } else {
        this.logger.error(`Job ${job.id} failed permanently after ${this.MAX_RETRY_ATTEMPTS} attempts`);
        return this.createJobResult(false, metrics, errorMessage);
      }
    }
  }

  private async handleTaskCreated(job: Job, metrics: JobMetrics): Promise<any> {
    const { taskId, userId, status } = job.data;
    
    if (!taskId || !userId) {
      throw new Error('Missing required data: taskId or userId');
    }

    metrics.tasksProcessed = 1;

    try {
      // Verify task exists and update any necessary computed fields
      const task = await this.taskRepository.findOne({
        where: { id: taskId, userId },
        relations: ['user'],
      });

      if (!task) {
        throw new Error(`Task ${taskId} not found for user ${userId}`);
      }

      // Update task priority based on due date if not already set
      if (task.dueDate && !task.priority) {
        const now = new Date();
        const dueDate = new Date(task.dueDate);
        const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        
        let priority: TaskPriority; // Fixed: Use proper enum type
        if (daysUntilDue <= 1) {
          priority = TaskPriority.HIGH;
        } else if (daysUntilDue <= 3) {
          priority = TaskPriority.MEDIUM;
        } else {
          priority = TaskPriority.LOW;
        }

        await this.taskRepository.update(taskId, { priority });
        this.logger.debug(`Updated task ${taskId} priority to ${priority} based on due date`);
      }

      // Invalidate relevant caches
      await this.invalidateUserCaches(userId, 'task created processing');

      metrics.tasksSuccess = 1;
      
      return {
        taskId,
        processed: true,
        message: 'Task creation processing completed',
      };
      
    } catch (error) {
      metrics.tasksFailed = 1;
      metrics.errors.push(getErrorMessage(error));
      throw error;
    }
  }

  private async handleTaskStatusUpdate(job: Job, metrics: JobMetrics): Promise<any> {
    const { taskId, oldStatus, newStatus, userId } = job.data;
    
    if (!taskId || !newStatus || !userId) {
      throw new Error('Missing required data for status update');
    }

    metrics.tasksProcessed = 1;

    try {
      // Perform any status-specific business logic
      if (newStatus === TaskStatus.COMPLETED) {
        // Fixed: Use proper update object without completedAt if it doesn't exist in entity
        const updateData: Partial<Task> = {
          updatedAt: new Date(),
        };

        // Only add completedAt if the entity has this field
        // Check if your Task entity has a completedAt field, if not remove this line
        // (updateData as any).completedAt = new Date();

        await this.taskRepository.update(taskId, updateData);
        
        this.logger.debug(`Task ${taskId} marked as completed`);
      }

      // Invalidate caches
      await this.invalidateUserCaches(userId, 'task status updated');

      metrics.tasksSuccess = 1;
      
      return {
        taskId,
        oldStatus,
        newStatus,
        processed: true,
      };
      
    } catch (error) {
      metrics.tasksFailed = 1;
      metrics.errors.push(getErrorMessage(error));
      throw error;
    }
  }

  // Legacy support for existing job types
  private async handleLegacyStatusUpdate(job: Job, metrics: JobMetrics): Promise<any> {
    const { taskId, status } = job.data;
    
    if (!taskId || !status) {
      throw new Error('Missing required data');
    }
    
    metrics.tasksProcessed = 1;

    try {
      const task = await this.tasksService.updateStatus(taskId, status);
      metrics.tasksSuccess = 1;
      
      return { 
        success: true,
        taskId: task.id,
        newStatus: task.status
      };
    } catch (error) {
      metrics.tasksFailed = 1;
      metrics.errors.push(getErrorMessage(error));
      throw error;
    }
  }

  private async handleLegacyOverdueTasks(job: Job, metrics: JobMetrics): Promise<any> {
    this.logger.debug('Processing legacy overdue tasks notification');
    
    try {
      // Fixed: Use only existing TaskStatus enum values
      const excludedStatuses = [TaskStatus.COMPLETED];
      
      // Add CANCELLED only if it exists in your enum
      // Check your TaskStatus enum and uncomment if you have CANCELLED status
      // excludedStatuses.push(TaskStatus.CANCELLED);

      const overdueTasks = await this.taskRepository.find({
        where: {
          dueDate: LessThan(new Date()),
          status: Not(In(excludedStatuses)),
        },
        take: this.BATCH_SIZE,
        order: { dueDate: 'ASC' },
      });

      metrics.tasksProcessed = overdueTasks.length;
      metrics.tasksSuccess = overdueTasks.length;

      if (overdueTasks.length > 0) {
        this.logger.log(`Processed ${overdueTasks.length} overdue tasks`);
      }

      return { 
        success: true, 
        message: `Processed ${overdueTasks.length} overdue tasks` 
      };
    } catch (error) {
      metrics.errors.push(getErrorMessage(error));
      throw error;
    }
  }

  private async handleOverdueTasks(job: Job, metrics: JobMetrics): Promise<any> {
    const { batchSize = this.BATCH_SIZE } = job.data;
    
    this.logger.log('Starting overdue tasks processing...');

    try {
      // Fixed: Use only existing TaskStatus enum values
      const excludedStatuses = [TaskStatus.COMPLETED];
      
      // Add additional statuses if they exist in your enum
      // Check your TaskStatus enum and add these if available:
      // if (TaskStatus.CANCELLED) excludedStatuses.push(TaskStatus.CANCELLED);
      // if (TaskStatus.DELETED) excludedStatuses.push(TaskStatus.DELETED);

      const overdueTasks = await this.taskRepository.find({
        where: {
          dueDate: LessThan(new Date()),
          status: Not(In(excludedStatuses)),
        },
        relations: ['user'],
        take: batchSize,
        order: { dueDate: 'ASC' },
      });

      metrics.tasksProcessed = overdueTasks.length;

      if (overdueTasks.length === 0) {
        this.logger.log('No overdue tasks found');
        return {
          processed: 0,
          message: 'No overdue tasks found',
        };
      }

      this.logger.log(`Found ${overdueTasks.length} overdue tasks to process`);

      const results = await Promise.allSettled(
        overdueTasks.map(task => this.processOverdueTask(task))
      );

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          metrics.tasksSuccess++;
        } else {
          metrics.tasksFailed++;
          metrics.errors.push(`Task ${overdueTasks[index].id}: ${result.reason}`);
          this.logger.error(`Failed to process overdue task ${overdueTasks[index].id}: ${result.reason}`);
        }
      });

      // Invalidate caches for affected users
      const userIds = [...new Set(overdueTasks.map(task => task.userId))];
      await Promise.allSettled(
        userIds.map(userId => this.invalidateUserCaches(userId, 'overdue tasks processed'))
      );

      this.logger.log(`Overdue tasks processing completed. Success: ${metrics.tasksSuccess}, Failed: ${metrics.tasksFailed}`);

      return {
        processed: metrics.tasksProcessed,
        success: metrics.tasksSuccess,
        failed: metrics.tasksFailed,
        message: `Processed ${metrics.tasksProcessed} overdue tasks`,
      };
      
    } catch (error) {
      this.logger.error(`Failed to process overdue tasks: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  private async processOverdueTask(task: Task): Promise<void> {
    try {
      // Update task with minimal changes to avoid entity issues
      const updateData: Partial<Task> = {
        updatedAt: new Date(),
      };

      // If you have an 'isOverdue' field in your Task entity, add it:
      // (updateData as any).isOverdue = true;

      await this.taskRepository.update(task.id, updateData);

      this.logger.debug(`Processed overdue task: ${task.id} (due: ${task.dueDate})`);
      
    } catch (error) {
      throw new Error(`Failed to process overdue task ${task.id}: ${getErrorMessage(error)}`);
    }
  }

  private async handleBatchTaskUpdate(job: Job, metrics: JobMetrics): Promise<any> {
    const { taskIds, updateData, userId } = job.data;
    
    if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
      throw new Error('Missing or invalid taskIds array');
    }

    metrics.tasksProcessed = taskIds.length;

    try {
      const tasks = await this.taskRepository.find({
        where: {
          id: In(taskIds),
          userId,
        },
      });

      if (tasks.length !== taskIds.length) {
        const foundIds = tasks.map(t => t.id);
        const missingIds = taskIds.filter(id => !foundIds.includes(id));
        throw new Error(`Tasks not found or access denied: ${missingIds.join(', ')}`);
      }

      // Ensure updateData includes updatedAt
      const safeUpdateData = {
        ...updateData,
        updatedAt: new Date(),
      };

      const result = await this.taskRepository.update(
        { id: In(taskIds), userId },
        safeUpdateData
      );

      await this.invalidateUserCaches(userId, 'batch task update');

      metrics.tasksSuccess = result.affected || 0;
      
      this.logger.log(`Batch updated ${result.affected} tasks for user ${userId}`);

      return {
        updated: result.affected,
        taskIds,
        processed: true,
      };
      
    } catch (error) {
      metrics.tasksFailed = taskIds.length;
      metrics.errors.push(getErrorMessage(error));
      throw error;
    }
  }

  private async handleCleanupCompletedTasks(job: Job, metrics: JobMetrics): Promise<any> {
    const { olderThanDays = 90 } = job.data;
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    try {
      // Use proper field for cleanup - adjust based on your Task entity
      const result = await this.taskRepository.delete({
        status: TaskStatus.COMPLETED,
        updatedAt: LessThan(cutoffDate), // Changed from completedAt to updatedAt
      });

      metrics.tasksProcessed = result.affected || 0;
      metrics.tasksSuccess = result.affected || 0;

      this.logger.log(`Cleaned up ${result.affected} completed tasks older than ${olderThanDays} days`);

      return {
        deleted: result.affected,
        cutoffDate,
        message: `Cleaned up ${result.affected} old completed tasks`,
      };
      
    } catch (error) {
      metrics.errors.push(getErrorMessage(error));
      throw error;
    }
  }

  private async invalidateUserCaches(userId: string, reason?: string): Promise<void> {
    try {
      await this.cacheService.delete(`stats:${userId}`, { namespace: 'tasks' });
      await this.cacheService.invalidatePattern(`tasks:${userId}:*`, 'tasks');
      
      this.logger.debug(`Cache invalidated for user: ${userId}${reason ? ` (${reason})` : ''}`);
    } catch (error) {
      this.logger.error(`Failed to invalidate cache for user ${userId}: ${getErrorMessage(error)}`);
    }
  }

  private createJobResult(
    success: boolean, 
    metrics: JobMetrics, 
    error?: string, 
    data?: any
  ): any {
    return {
      success,
      duration: metrics.duration,
      tasksProcessed: metrics.tasksProcessed,
      tasksSuccess: metrics.tasksSuccess,
      tasksFailed: metrics.tasksFailed,
      errors: metrics.errors,
      error,
      data,
      timestamp: new Date().toISOString(),
    };
  }
}