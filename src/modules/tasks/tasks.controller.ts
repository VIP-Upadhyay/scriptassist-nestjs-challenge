import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Patch, 
  Param, 
  Delete, 
  UseGuards, 
  Query, 
  HttpException, 
  HttpStatus,
  ParseUUIDPipe,
  HttpCode
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TaskFilterDto } from './dto/task-filter.dto';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'; // FIXED: Import real guard
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('tasks')
@Controller('tasks')
@UseGuards(JwtAuthGuard, RateLimitGuard) // FIXED: Using real JWT guard
@RateLimit({ limit: 100, windowMs: 60000 })
@ApiBearerAuth()
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    // FIXED: Removed direct repository injection - proper architecture
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new task' })
  @ApiResponse({ status: 201, description: 'Task created successfully' })
  create(
    @Body() createTaskDto: CreateTaskDto,
    @CurrentUser() user: any
  ) {
    // FIXED: Add user context to task creation
    return this.tasksService.create({ ...createTaskDto, userId: user.id });
  }

  @Get()
  @ApiOperation({ summary: 'Find all tasks with filtering and pagination' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false })
  async findAll(
    @Query() filterDto: TaskFilterDto,
    @CurrentUser() user: any
  ) {
    // FIXED: Use service method with proper filtering and pagination
    return this.tasksService.findAllWithFilters(filterDto, user);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get task statistics' })
  async getStats(@CurrentUser() user: any) {
    // FIXED: Use service method for efficient statistics
    return this.tasksService.getStatistics(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Find a task by ID' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any
  ) {
    // FIXED: Proper error handling without exposing internal details
    const task = await this.tasksService.findOne(id, user);
    
    if (!task) {
      throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
    }
    
    return task;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a task' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  update(
    @Param('id', ParseUUIDPipe) id: string, 
    @Body() updateTaskDto: UpdateTaskDto,
    @CurrentUser() user: any
  ) {
    // FIXED: Add user context for authorization
    return this.tasksService.update(id, updateTaskDto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a task' })
  @ApiResponse({ status: 204, description: 'Task deleted successfully' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any
  ) {
    // FIXED: Proper status code and user context
    await this.tasksService.remove(id, user);
  }

  @Post('batch')
  @ApiOperation({ summary: 'Batch process multiple tasks' })
  @ApiResponse({ status: 200, description: 'Batch operation completed' })
  async batchProcess(
    @Body() operations: { taskIds: string[], action: string },
    @CurrentUser() user: any
  ) {
    // FIXED: Use service method for efficient bulk operations
    return this.tasksService.batchProcess(operations, user);
  }
}