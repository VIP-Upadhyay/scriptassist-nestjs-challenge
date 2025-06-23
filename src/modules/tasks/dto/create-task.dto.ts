import { IsNotEmpty, IsString, IsOptional, IsEnum, IsDateString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaskStatus } from '../enums/task-status.enum';
import { TaskPriority } from '../enums/task-priority.enum';

export class CreateTaskDto {
  @ApiProperty({ 
    description: 'Task title',
    example: 'Complete project documentation',
    minLength: 3,
    maxLength: 200
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  @Transform(({ value }) => value?.trim())
  title: string;

  @ApiPropertyOptional({ 
    description: 'Task description',
    example: 'Write comprehensive documentation for the API endpoints and data models',
    maxLength: 1000
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(({ value }) => value?.trim())
  description?: string;

  @ApiPropertyOptional({ 
    enum: TaskStatus, 
    description: 'Initial task status',
    default: TaskStatus.PENDING
  })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus = TaskStatus.PENDING;

  @ApiPropertyOptional({ 
    enum: TaskPriority, 
    description: 'Task priority level',
    default: TaskPriority.MEDIUM
  })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority = TaskPriority.MEDIUM;

  @ApiPropertyOptional({ 
    description: 'Task due date (ISO 8601 format)',
    example: '2025-06-30T10:00:00.000Z'
  })
  @IsOptional()
  @IsDateString()
  dueDate?: Date;

  // This will be set by the controller, not by the user
  userId?: string;
}