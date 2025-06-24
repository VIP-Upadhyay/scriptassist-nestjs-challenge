import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { Task } from './entities/task.entity';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TaskFilterDto } from './dto/task-filter.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TaskStatus } from './enums/task-status.enum';
import { TaskPriority } from './enums/task-priority.enum';
import { CacheService } from '../../common/services/cache.service';
import { getErrorMessage } from '@common/utils/error.util';

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface TaskStatistics {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  overdue: number;
  highPriority: number;
  mediumPriority: number;
  lowPriority: number;
}

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
    @InjectQueue('task-processing')
    private taskQueue: Queue,
    private dataSource: DataSource,
    private cacheService: CacheService,
  ) {}

  async create(createTaskDto: CreateTaskDto): Promise<Task> {
    return this.dataSource.transaction(async manager => {
      try {
        const task = manager.create(Task, createTaskDto);
        const savedTask = await manager.save(task);

        // Invalidate user's cache after task creation
        await this.invalidateUserCache(savedTask.userId, 'task created');

        // Add to queue with proper error handling
        try {
          await this.taskQueue.add(
            'task-created',
            {
              taskId: savedTask.id,
              userId: savedTask.userId,
              status: savedTask.status,
            },
            {
              attempts: 3,
              backoff: {
                type: 'exponential',
                delay: 2000,
              },
            }
          );
        } catch (queueError) {
          this.logger.warn(`Failed to add task to queue: ${getErrorMessage(queueError)}`);
        }

        this.logger.log(`Task created: ${savedTask.id}`);
        return savedTask;
      } catch (error) {
        this.logger.error(`Failed to create task: ${getErrorMessage(error)}`);
        throw error;
      }
    });
  }

  async findAllWithFilters(
    filterDto: TaskFilterDto,
    user: any
  ): Promise<PaginatedResult<Task>> {
    const { page = 1, limit = 10, status, priority, search, sortBy = 'createdAt', sortOrder = 'DESC' } = filterDto;
    
    // Create cache key based on filters
    const cacheKey = `tasks:${user.id}:${JSON.stringify(filterDto)}`;
    
    // Try cache first
    const cached = await this.cacheService.get<PaginatedResult<Task>>(cacheKey, { 
      namespace: 'tasks' 
    });
    
    if (cached) {
      this.logger.debug(`Task list cache hit for user: ${user.id}`);
      return cached;
    }

    this.logger.debug(`Task list cache miss for user: ${user.id}`);
    
    const queryBuilder = this.tasksRepository
      .createQueryBuilder('task')
      .leftJoinAndSelect('task.user', 'user')
      .where('task.userId = :userId', { userId: user.id });

    if (status) {
      queryBuilder.andWhere('task.status = :status', { status });
    }

    if (priority) {
      queryBuilder.andWhere('task.priority = :priority', { priority });
    }

    if (search) {
      queryBuilder.andWhere(
        '(task.title ILIKE :search OR task.description ILIKE :search)',
        { search: `%${search}%` }
      );
    }

    queryBuilder
      .orderBy(`task.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    const [tasks, total] = await queryBuilder.getManyAndCount();

    const sanitizedTasks = tasks.map(task => ({
      ...task,
      user: task.user ? {
        id: task.user.id,
        email: task.user.email,
        name: task.user.name,
        role: task.user.role,
      } : null,
    }));

    const result = {
      data: sanitizedTasks as Task[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    // Cache for 2 minutes
    await this.cacheService.set(cacheKey, result, {
      ttl: 120,
      namespace: 'tasks',
    });

    this.logger.debug(`Task list computed and cached for user: ${user.id}`);
    return result;
  }

  async findOne(id: string, user: any): Promise<Task | null> {
    const task = await this.tasksRepository
      .createQueryBuilder('task')
      .leftJoinAndSelect('task.user', 'user')
      .where('task.id = :id', { id })
      .andWhere('task.userId = :userId', { userId: user.id })
      .getOne();

    if (!task) {
      return null;
    }

    return {
      ...task,
      user: task.user ? {
        id: task.user.id,
        email: task.user.email,
        name: task.user.name,
        role: task.user.role,
      } : null,
    } as Task;
  }

  async update(id: string, updateTaskDto: UpdateTaskDto, user: any): Promise<Task> {
    return this.dataSource.transaction(async manager => {
      const task = await manager.findOne(Task, {
        where: { id, userId: user.id },
      });

      if (!task) {
        throw new NotFoundException('Task not found');
      }

      const originalStatus = task.status;
      const originalPriority = task.priority;

      await manager
        .createQueryBuilder()
        .update(Task)
        .set({
          ...updateTaskDto,
          updatedAt: new Date(),
        })
        .where('id = :id', { id })
        .execute();

      const updatedTask = await manager.findOne(Task, {
        where: { id },
        relations: ['user'],
      });

      // Invalidate cache if important fields changed
      const statusChanged = originalStatus !== updatedTask!.status;
      const priorityChanged = originalPriority !== updatedTask!.priority;
      
      if (statusChanged || priorityChanged) {
        await this.invalidateUserCache(user.id, 'task updated');
      }

      // Add to queue if status changed
      if (statusChanged) {
        try {
          await this.taskQueue.add(
            'task-status-updated',
            {
              taskId: updatedTask!.id,
              oldStatus: originalStatus,
              newStatus: updatedTask!.status,
              userId: user.id,
            },
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 2000 },
            }
          );
        } catch (queueError) {
          this.logger.warn(`Failed to add status update to queue: ${getErrorMessage(queueError)}`);
        }
      }

      this.logger.log(`Task updated: ${id}`);
      return updatedTask!;
    });
  }

  async remove(id: string, user: any): Promise<void> {
    return this.dataSource.transaction(async manager => {
      const task = await manager.findOne(Task, {
        where: { id, userId: user.id },
      });

      if (!task) {
        throw new NotFoundException('Task not found');
      }

      await manager.remove(task);

      // Invalidate cache after deletion
      await this.invalidateUserCache(user.id, 'task deleted');

      this.logger.log(`Task deleted: ${id}`);
    });
  }

  async getStatistics(user: any): Promise<TaskStatistics> {
    const cacheKey = `stats:${user.id}`;
    
    // Try cache first
    const cached = await this.cacheService.get<TaskStatistics>(cacheKey, { 
      namespace: 'tasks' 
    });
    
    if (cached) {
      this.logger.debug(`Stats cache hit for user: ${user.id}`);
      return cached;
    }

    this.logger.debug(`Stats cache miss - computing for user: ${user.id}`);
    
    const result = await this.tasksRepository
      .createQueryBuilder('task')
      .select([
        'COUNT(*) as total',
        'COUNT(CASE WHEN task.status = :completed THEN 1 END) as completed',
        'COUNT(CASE WHEN task.status = :inProgress THEN 1 END) as inProgress',
        'COUNT(CASE WHEN task.status = :pending THEN 1 END) as pending',
        'COUNT(CASE WHEN task.dueDate < NOW() AND task.status != :completedStatus THEN 1 END) as overdue',
        'COUNT(CASE WHEN task.priority = :high THEN 1 END) as highPriority',
        'COUNT(CASE WHEN task.priority = :medium THEN 1 END) as mediumPriority',
        'COUNT(CASE WHEN task.priority = :low THEN 1 END) as lowPriority',
      ])
      .where('task.userId = :userId', { userId: user.id })
      .setParameters({
        completed: TaskStatus.COMPLETED,
        inProgress: TaskStatus.IN_PROGRESS,
        pending: TaskStatus.PENDING,
        completedStatus: TaskStatus.COMPLETED,
        high: TaskPriority.HIGH,
        medium: TaskPriority.MEDIUM,
        low: TaskPriority.LOW,
      })
      .getRawOne();

    const stats: TaskStatistics = {
      total: parseInt(result.total),
      completed: parseInt(result.completed),
      inProgress: parseInt(result.inProgress),
      pending: parseInt(result.pending),
      overdue: parseInt(result.overdue),
      highPriority: parseInt(result.highPriority),
      mediumPriority: parseInt(result.mediumPriority),
      lowPriority: parseInt(result.lowPriority),
    };

    // Cache for 5 minutes
    await this.cacheService.set(cacheKey, stats, {
      ttl: 300,
      namespace: 'tasks',
    });

    this.logger.debug(`Stats computed and cached for user: ${user.id}`);
    return stats;
  }

  async batchProcess(
    operations: { taskIds: string[], action: string },
    user: any
  ): Promise<{ success: number; failed: number; results: any[] }> {
    const { taskIds, action } = operations;
    
    if (!taskIds || taskIds.length === 0) {
      return { success: 0, failed: 0, results: [] };
    }

    return this.dataSource.transaction(async manager => {
      const tasks = await manager.find(Task, {
        where: {
          id: In(taskIds),
          userId: user.id,
        },
      });

      const foundTaskIds = tasks.map(task => task.id);
      const notFoundIds = taskIds.filter(id => !foundTaskIds.includes(id));

      let successCount = 0;
      let failedCount = notFoundIds.length;
      const results: { taskId: string; success: boolean; error?: string; action?: string; }[] = [];

      notFoundIds.forEach(id => {
        results.push({
          taskId: id,
          success: false,
          error: 'Task not found or access denied',
        });
      });

      if (foundTaskIds.length > 0) {
        try {
          switch (action) {
            case 'complete':
              await manager
                .createQueryBuilder()
                .update(Task)
                .set({ 
                  status: TaskStatus.COMPLETED,
                  updatedAt: new Date(),
                })
                .where('id IN (:...ids)', { ids: foundTaskIds })
                .execute();
              
              successCount = foundTaskIds.length;
              foundTaskIds.forEach(id => {
                results.push({ taskId: id, success: true, action: 'completed' });
              });
              break;

            case 'delete':
              await manager
                .createQueryBuilder()
                .delete()
                .from(Task)
                .where('id IN (:...ids)', { ids: foundTaskIds })
                .execute();
              
              successCount = foundTaskIds.length;
              foundTaskIds.forEach(id => {
                results.push({ taskId: id, success: true, action: 'deleted' });
              });
              break;

            default:
              failedCount += foundTaskIds.length;
              foundTaskIds.forEach(id => {
                results.push({
                  taskId: id,
                  success: false,
                  error: `Unknown action: ${action}`,
                });
              });
          }

          // Invalidate cache after successful batch operations
          if (successCount > 0) {
            await this.invalidateUserCache(user.id, `batch ${action} operation`);
          }

        } catch (error) {
          this.logger.error(`Batch operation failed: ${getErrorMessage(error)}`);
          failedCount += foundTaskIds.length;
          foundTaskIds.forEach(id => {
            results.push({
              taskId: id,
              success: false,
              error: getErrorMessage(error),
            });
          });
        }
      }

      this.logger.log(`Batch operation completed: ${successCount} success, ${failedCount} failed`);

      return {
        success: successCount,
        failed: failedCount,
        results,
      };
    });
  }

  // Helper method to invalidate all user caches
  private async invalidateUserCache(userId: string, reason?: string): Promise<void> {
    try {
      // Invalidate stats cache
      await this.cacheService.delete(`stats:${userId}`, { namespace: 'tasks' });
      
      // Invalidate all task list caches for this user
      await this.cacheService.invalidatePattern(`tasks:${userId}:*`, 'tasks');
      
      this.logger.debug(`Cache invalidated for user: ${userId}${reason ? ` (${reason})` : ''}`);
    } catch (error) {
      this.logger.error(`Failed to invalidate cache for user ${userId}: ${getErrorMessage(error)}`);
    }
  }

  // Legacy methods (keeping for backward compatibility)
  async findAll(): Promise<Task[]> {
    this.logger.warn('Using deprecated findAll method - use findAllWithFilters instead');
    return this.tasksRepository.find({
      relations: ['user'],
      take: 100,
    });
  }

  async findByStatus(status: TaskStatus): Promise<Task[]> {
    return this.tasksRepository.find({
      where: { status },
      relations: ['user'],
    });
  }

  async updateStatus(id: string, status: string): Promise<Task> {
    const task = await this.tasksRepository.findOne({
      where: { id },
      relations: ['user'],
    });

    if (!task) {
      throw new NotFoundException(`Task with ID ${id} not found`);
    }

    task.status = status as TaskStatus;
    const updatedTask = await this.tasksRepository.save(task);
    
    // Invalidate cache
    await this.invalidateUserCache(task.userId, 'status updated');
    
    return updatedTask;
  }
}