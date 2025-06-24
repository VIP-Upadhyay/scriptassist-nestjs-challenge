import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Not, In } from 'typeorm';
import { Task } from '../../modules/tasks/entities/task.entity';
import { TaskStatus } from '../../modules/tasks/enums/task-status.enum';
import { getErrorMessage } from '../../common/utils/error.util';

@Injectable()
export class OverdueTasksService {
  private readonly logger = new Logger(OverdueTasksService.name);
  private readonly BATCH_SIZE = 100;
  private isProcessing = false;

  constructor(
    @InjectQueue('task-processing')
    private taskQueue: Queue,
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
  ) {}

  // Run every hour to check for overdue tasks
  @Cron(CronExpression.EVERY_HOUR, {
    name: 'process-overdue-tasks',
    timeZone: 'UTC',
  })
  async handleOverdueTasksScheduled(): Promise<void> {
    if (this.isProcessing) {
      this.logger.warn('Overdue tasks processing already in progress, skipping this run');
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      this.logger.log('Starting scheduled overdue tasks check...');

      // Get count of overdue tasks
      const overdueCount = await this.getOverdueTasksCount();
      
      if (overdueCount === 0) {
        this.logger.log('No overdue tasks found');
        return;
      }

      this.logger.log(`Found ${overdueCount} overdue tasks. Starting batch processing...`);

      // Process in batches to avoid overwhelming the queue
      const batchCount = Math.ceil(overdueCount / this.BATCH_SIZE);
      let totalQueued = 0;

      for (let batch = 0; batch < batchCount; batch++) {
        try {
          const job = await this.taskQueue.add(
            'process-overdue-tasks',
            {
              batchNumber: batch + 1,
              totalBatches: batchCount,
              batchSize: this.BATCH_SIZE,
              timestamp: new Date().toISOString(),
            },
            {
              attempts: 3,
              backoff: {
                type: 'exponential',
                delay: 5000, // Start with 5 seconds
              },
              removeOnComplete: 10,
              removeOnFail: 5,
              delay: batch * 1000, // Stagger jobs by 1 second
            }
          );

          totalQueued++;
          this.logger.debug(`Queued overdue tasks job ${batch + 1}/${batchCount} (Job ID: ${job.id})`);
          
        } catch (error) {
          this.logger.error(`Failed to queue batch ${batch + 1}: ${getErrorMessage(error)}`);
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(`Overdue tasks scheduling completed in ${duration}ms. Queued ${totalQueued} batch jobs for ${overdueCount} overdue tasks`);

    } catch (error) {
      this.logger.error(`Error in overdue tasks scheduled job: ${getErrorMessage(error)}`);
    } finally {
      this.isProcessing = false;
    }
  }

  // Legacy method - keeping for backward compatibility
  @Cron(CronExpression.EVERY_HOUR)
  async checkOverdueTasks() {
    this.logger.debug('Legacy overdue tasks check - delegating to new implementation');
    
    try {
      const now = new Date();
      
      // Fixed: Use only existing TaskStatus enum values
      const excludedStatuses = this.getExcludedStatuses();
      
      const overdueTasks = await this.tasksRepository.find({
        where: {
          dueDate: LessThan(now),
          status: excludedStatuses.length > 1 ? Not(In(excludedStatuses)) : Not(excludedStatuses[0]),
        },
        take: this.BATCH_SIZE,
      });
      
      this.logger.log(`Found ${overdueTasks.length} overdue tasks (legacy check)`);
      
      if (overdueTasks.length > 0) {
        // Add tasks to the queue using new job type
        const job = await this.taskQueue.add(
          'overdue-tasks-notification', // Legacy job type
          {
            taskIds: overdueTasks.map(t => t.id),
            timestamp: new Date().toISOString(),
          },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          }
        );
        
        this.logger.debug(`Legacy overdue tasks job queued: ${job.id}`);
      }
      
      this.logger.debug('Legacy overdue tasks check completed');
    } catch (error) {
      this.logger.error(`Error in legacy overdue tasks check: ${getErrorMessage(error)}`);
    }
  }

  // Run daily at 2 AM to clean up old completed tasks
  @Cron('0 2 * * *', {
    name: 'cleanup-completed-tasks',
    timeZone: 'UTC',
  })
  async handleCleanupCompletedTasks(): Promise<void> {
    try {
      this.logger.log('Starting cleanup of old completed tasks...');

      const job = await this.taskQueue.add(
        'cleanup-completed-tasks',
        {
          olderThanDays: 90,
          timestamp: new Date().toISOString(),
        },
        {
          attempts: 2,
          backoff: {
            type: 'fixed',
            delay: 10000,
          },
          removeOnComplete: 5,
          removeOnFail: 3,
        }
      );

      this.logger.log(`Cleanup job queued (Job ID: ${job.id})`);

    } catch (error) {
      this.logger.error(`Error scheduling cleanup job: ${getErrorMessage(error)}`);
    }
  }

  // Run every 6 hours to process any stuck or failed tasks
  @Cron('0 */6 * * *', {
    name: 'process-stale-tasks',
    timeZone: 'UTC',
  })
  async handleStaleTasksCheck(): Promise<void> {
    try {
      this.logger.log('Starting stale tasks check...');

      const staleCutoff = new Date();
      staleCutoff.setHours(staleCutoff.getHours() - 24);

      const staleTasks = await this.tasksRepository.find({
        where: {
          status: TaskStatus.IN_PROGRESS,
          updatedAt: LessThan(staleCutoff),
        },
        take: 50,
      });

      if (staleTasks.length > 0) {
        this.logger.warn(`Found ${staleTasks.length} stale tasks that have been in progress for >24h`);

        const job = await this.taskQueue.add(
          'review-stale-tasks',
          {
            taskIds: staleTasks.map(t => t.id),
            staleThreshold: 24,
            timestamp: new Date().toISOString(),
          },
          {
            attempts: 2,
            backoff: { type: 'fixed', delay: 5000 },
          }
        );

        this.logger.log(`Stale tasks review job queued (Job ID: ${job.id})`);
      } else {
        this.logger.log('No stale tasks found');
      }

    } catch (error) {
      this.logger.error(`Error in stale tasks check: ${getErrorMessage(error)}`);
    }
  }

  // Manual trigger for overdue tasks processing
  async triggerOverdueProcessing(batchSize?: number): Promise<{ jobId: string; message: string }> {
    try {
      const overdueCount = await this.getOverdueTasksCount();
      
      if (overdueCount === 0) {
        return {
          jobId: '',
          message: 'No overdue tasks found',
        };
      }

      const job = await this.taskQueue.add(
        'process-overdue-tasks',
        {
          batchSize: batchSize || this.BATCH_SIZE,
          manual: true,
          timestamp: new Date().toISOString(),
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          priority: 10, // Higher priority for manual triggers
        }
      );

      this.logger.log(`Manual overdue processing triggered (Job ID: ${job.id}) for ${overdueCount} tasks`);

      return {
        jobId: job.id!,
        message: `Queued processing for ${overdueCount} overdue tasks`,
      };

    } catch (error) {
      this.logger.error(`Error triggering manual overdue processing: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  // Get statistics about overdue tasks
  async getOverdueTasksStats(): Promise<{
    count: number;
    byPriority: { high: number; medium: number; low: number };
    oldestOverdue: Date | null;
  }> {
    try {
      const now = new Date();
      const excludedStatuses = this.getExcludedStatuses();
      
      const [countResult, priorityResult, oldestResult] = await Promise.all([
        // Total count
        this.tasksRepository.count({
          where: {
            dueDate: LessThan(now),
            status: excludedStatuses.length > 1 ? Not(In(excludedStatuses)) : Not(excludedStatuses[0]),
          },
        }),
        
        // Count by priority
        this.tasksRepository
          .createQueryBuilder('task')
          .select([
            'task.priority',
            'COUNT(*) as count',
          ])
          .where('task.dueDate < :now', { now })
          .andWhere(
            excludedStatuses.length > 1 
              ? 'task.status NOT IN (:...statuses)'
              : 'task.status != :status',
            excludedStatuses.length > 1 
              ? { statuses: excludedStatuses }
              : { status: excludedStatuses[0] }
          )
          .groupBy('task.priority')
          .getRawMany(),
        
        // Oldest overdue task
        this.tasksRepository.findOne({
          where: {
            dueDate: LessThan(now),
            status: excludedStatuses.length > 1 ? Not(In(excludedStatuses)) : Not(excludedStatuses[0]),
          },
          order: { dueDate: 'ASC' },
          select: ['dueDate'],
        }),
      ]);

      const byPriority = { high: 0, medium: 0, low: 0 };
      priorityResult.forEach(result => {
        const priority = result.task_priority?.toLowerCase();
        if (['high', 'medium', 'low'].includes(priority)) {
          byPriority[priority as keyof typeof byPriority] = parseInt(result.count);
        }
      });

      return {
        count: countResult,
        byPriority,
        oldestOverdue: oldestResult?.dueDate || null,
      };

    } catch (error) {
      this.logger.error(`Error getting overdue tasks stats: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  private async getOverdueTasksCount(): Promise<number> {
    const excludedStatuses = this.getExcludedStatuses();
    
    return this.tasksRepository.count({
      where: {
        dueDate: LessThan(new Date()),
        status: excludedStatuses.length > 1 ? Not(In(excludedStatuses)) : Not(excludedStatuses[0]),
      },
    });
  }

  // Helper method to get excluded statuses based on what's available in your TaskStatus enum
  private getExcludedStatuses(): TaskStatus[] {
    const excludedStatuses: TaskStatus[] = [TaskStatus.COMPLETED];
    
    // Dynamically check if additional statuses exist in your enum
    // Only add them if they're defined
    if ((TaskStatus as any).CANCELLED) {
      excludedStatuses.push((TaskStatus as any).CANCELLED);
    }
    
    if ((TaskStatus as any).DELETED) {
      excludedStatuses.push((TaskStatus as any).DELETED);
    }
    
    if ((TaskStatus as any).ARCHIVED) {
      excludedStatuses.push((TaskStatus as any).ARCHIVED);
    }
    
    return excludedStatuses;
  }

  // Health check method
  async getSchedulerHealth(): Promise<{
    isHealthy: boolean;
    lastRun?: Date;
    nextRun?: Date;
    queueStats: any;
  }> {
    try {
      const [waiting, active, completed, failed] = await Promise.all([
        this.taskQueue.getWaiting(),
        this.taskQueue.getActive(),
        this.taskQueue.getCompleted(),
        this.taskQueue.getFailed(),
      ]);

      return {
        isHealthy: true,
        queueStats: {
          waiting: waiting.length,
          active: active.length,
          completed: completed.length,
          failed: failed.length,
        },
      };

    } catch (error) {
      this.logger.error(`Error checking scheduler health: ${getErrorMessage(error)}`);
      return {
        isHealthy: false,
        queueStats: null,
      };
    }
  }

  // Additional utility methods for monitoring and maintenance

  // Get detailed queue information
  async getQueueInfo(): Promise<{
    overdueTasksCount: number;
    queuedJobsCount: number;
    activeJobsCount: number;
    failedJobsCount: number;
    lastProcessingTime?: string;
  }> {
    try {
      const [overdueCount, waiting, active, failed] = await Promise.all([
        this.getOverdueTasksCount(),
        this.taskQueue.getWaiting(),
        this.taskQueue.getActive(),
        this.taskQueue.getFailed(),
      ]);

      return {
        overdueTasksCount: overdueCount,
        queuedJobsCount: waiting.length,
        activeJobsCount: active.length,
        failedJobsCount: failed.length,
        lastProcessingTime: new Date().toISOString(),
      };

    } catch (error) {
      this.logger.error(`Error getting queue info: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  // Manual cleanup method for admin use
  async cleanupOldCompletedTasks(olderThanDays: number = 90): Promise<{
    jobId: string;
    message: string;
  }> {
    try {
      const job = await this.taskQueue.add(
        'cleanup-completed-tasks',
        {
          olderThanDays,
          manual: true,
          timestamp: new Date().toISOString(),
        },
        {
          attempts: 2,
          backoff: { type: 'fixed', delay: 5000 },
          priority: 5, // Medium priority for manual cleanup
        }
      );

      this.logger.log(`Manual cleanup job queued (Job ID: ${job.id}) for tasks older than ${olderThanDays} days`);

      return {
        jobId: job.id!,
        message: `Queued cleanup for tasks older than ${olderThanDays} days`,
      };

    } catch (error) {
      this.logger.error(`Error triggering manual cleanup: ${getErrorMessage(error)}`);
      throw error;
    }
  }
}