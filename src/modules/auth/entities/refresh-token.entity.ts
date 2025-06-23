import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('refresh_tokens')
@Index(['userId', 'isRevoked'])
@Index(['expiresAt'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  @Index()
  token: string;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => User, user => user.refreshTokens, { onDelete: 'CASCADE' })
  user: User;

  @Column('timestamp')
  expiresAt: Date;

  @Column({ default: false })
  isRevoked: boolean;

  @Column({ nullable: true, length: 500 })
  userAgent?: string;

  @Column({ nullable: true, length: 45 })
  ipAddress?: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}