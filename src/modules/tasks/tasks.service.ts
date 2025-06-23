import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
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
    private dataSource: DataSource, // For transactions
  ) {}

  async create(createTaskDto: CreateTaskDto): Promise<Task> {
    // FIXED: Use proper transaction for atomicity
    return this.dataSource.transaction(async manager => {
      try {
        const task = manager.create(Task, createTaskDto);
        const savedTask = await manager.save(task);

        // FIXED: Add to queue with proper error handling
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

        this.logger.log(`Task created: ${savedTask.id}`);
        return savedTask;
      } catch (error) {
        let message = 'Unknown error';
        if (error instanceof Error) {
          message = error.message;
        }  
        this.logger.error(`Failed to create task: ${message}`);
        throw error;
      }
    });
  }

  async findAllWithFilters(
    filterDto: TaskFilterDto,
    user: any
  ): Promise<PaginatedResult<Task>> {
    // FIXED: Efficient database filtering and pagination
    const { page = 1, limit = 10, status, priority, search, sortBy = 'createdAt', sortOrder = 'DESC' } = filterDto;
    
    const queryBuilder = this.tasksRepository
      .createQueryBuilder('task')
      .leftJoinAndSelect('task.user', 'user') // FIXED: Efficient join instead of N+1
      .where('task.userId = :userId', { userId: user.id }); // User can only see their tasks

    // FIXED: Database-level filtering instead of in-memory
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

    // FIXED: Proper sorting and pagination
    queryBuilder
      .orderBy(`task.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    const [tasks, total] = await queryBuilder.getManyAndCount();

    // FIXED: Don't expose password hashes in user data
    const sanitizedTasks = tasks.map(task => ({
      ...task,
      user: task.user ? {
        id: task.user.id,
        email: task.user.email,
        name: task.user.name,
        role: task.user.role,
      } : null,
    }));

    return {
      data: sanitizedTasks as Task[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string, user: any): Promise<Task | null> {
    // FIXED: Single efficient query with authorization
    const task = await this.tasksRepository
      .createQueryBuilder('task')
      .leftJoinAndSelect('task.user', 'user')
      .where('task.id = :id', { id })
      .andWhere('task.userId = :userId', { userId: user.id })
      .getOne();

    if (!task) {
      return null;
    }

    // FIXED: Don't expose password hash
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
    // FIXED: Use transaction with proper authorization
    return this.dataSource.transaction(async manager => {
      // Check if task exists and user owns it
      const task = await manager.findOne(Task, {
        where: { id, userId: user.id },
      });

      if (!task) {
        throw new NotFoundException('Task not found');
      }

      const originalStatus = task.status;

      // FIXED: Efficient update using QueryBuilder
      await manager
        .createQueryBuilder()
        .update(Task)
        .set({
          ...updateTaskDto,
          updatedAt: new Date(),
        })
        .where('id = :id', { id })
        .execute();

      // Get updated task
      const updatedTask = await manager.findOne(Task, {
        where: { id },
        relations: ['user'],
      });

      // Add to queue if status changed
      if (originalStatus !== updatedTask!.status) {
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
      }

      this.logger.log(`Task updated: ${id}`);
      return updatedTask!;
    });
  }

  async remove(id: string, user: any): Promise<void> {
    // FIXED: Proper authorization and transaction
    return this.dataSource.transaction(async manager => {
      const task = await manager.findOne(Task, {
        where: { id, userId: user.id },
      });

      if (!task) {
        throw new NotFoundException('Task not found');
      }

      await manager.remove(task);

      // Add to queue for cleanup
      await this.taskQueue.add(
        'task-deleted',
        {
          taskId: id,
          userId: user.id,
        },
        {
          attempts: 2,
          delay: 1000,
        }
      );

      this.logger.log(`Task deleted: ${id}`);
    });
  }

  async getStatistics(user: any): Promise<TaskStatistics> {
    // FIXED: Single efficient SQL query instead of N+1
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

    return {
      total: parseInt(result.total),
      completed: parseInt(result.completed),
      inProgress: parseInt(result.inProgress),
      pending: parseInt(result.pending),
      overdue: parseInt(result.overdue),
      highPriority: parseInt(result.highPriority),
      mediumPriority: parseInt(result.mediumPriority),
      lowPriority: parseInt(result.lowPriority),
    };
  }

  async batchProcess(
    operations: { taskIds: string[], action: string },
    user: any
  ): Promise<{ success: number; failed: number; results: any[] }> {
    // FIXED: Efficient bulk operations instead of N+1 queries
    const { taskIds, action } = operations;
    
    if (!taskIds || taskIds.length === 0) {
      return { success: 0, failed: 0, results: [] };
    }

    return this.dataSource.transaction(async manager => {
      // Verify all tasks belong to the user
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
      const results: { taskId: string; success: boolean; error?: any; action?: string; }[] = [];

      // Add failed results for not found tasks
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
              // FIXED: Bulk update instead of individual updates
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
              // FIXED: Bulk delete
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

          // Add batch operation to queue for processing
          if (successCount > 0) {
            await this.taskQueue.add(
              'batch-operation-completed',
              {
                action,
                taskIds: foundTaskIds,
                userId: user.id,
                successCount,
              },
              {
                attempts: 2,
                delay: 1000,
              }
            );
          }

        } catch (error) {
          let message = 'Unknown error';
          if (error instanceof Error) {
            message = error.message;
          }

          this.logger.error(`Batch operation failed: ${message}`);
          failedCount += foundTaskIds.length;
          foundTaskIds.forEach(id => {
            results.push({
              taskId: id,
              success: false,
              error: message,
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

  // Legacy methods (keeping for backward compatibility but fixed)
  async findAll(): Promise<Task[]> {
    // FIXED: This should not be used but keeping for compatibility
    this.logger.warn('Using deprecated findAll method - use findAllWithFilters instead');
    return this.tasksRepository.find({
      relations: ['user'],
      take: 100, // Limit to prevent memory issues
    });
  }

  async findByStatus(status: TaskStatus): Promise<Task[]> {
    // FIXED: Use proper repository methods instead of raw SQL
    return this.tasksRepository.find({
      where: { status },
      relations: ['user'],
    });
  }

  async updateStatus(id: string, status: string): Promise<Task> {
    // FIXED: Add proper error handling
    const task = await this.tasksRepository.findOne({
      where: { id },
      relations: ['user'],
    });

    if (!task) {
      throw new NotFoundException(`Task with ID ${id} not found`);
    }

    task.status = status as TaskStatus;
    return this.tasksRepository.save(task);
  }
}