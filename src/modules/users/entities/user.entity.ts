import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Task } from '../../tasks/entities/task.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Index()
  email: string;

  @Column()
  name: string;

  @Column()
  password: string;

  @Column({ default: 'user' })
  role: string;

  @Column({ default: false })
  isLocked: boolean;

  @Column({ nullable: true, type: 'timestamp' })
  suspendedUntil?: Date;

  @Column({ nullable: true, type: 'timestamp' })
  lastLoginAt?: Date;

  @Column({ nullable: true, length: 45 })
  lastLoginIp?: string;

  @Column({ default: 0 })
  failedLoginAttempts: number;

  @Column({ nullable: true, type: 'timestamp' })
  lockedUntil?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Task, task => task.user)
  tasks: Task[];

  @OneToMany(() => RefreshToken, refreshToken => refreshToken.user)
  refreshTokens: RefreshToken[];
}