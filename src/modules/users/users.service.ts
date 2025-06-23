import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    const { password, ...userData } = createUserDto;
    
    // Hash password with salt
    const saltRounds = 12; // Increased from default 10 for better security
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const user = this.usersRepository.create({
      ...userData,
      password: hashedPassword,
      role: userData.role || 'user', // Default to 'user' if no role provided
    });

    return this.usersRepository.save(user);
  }

  async findAll(): Promise<User[]> {
    return this.usersRepository.find({
      select: ['id', 'email', 'name', 'role', 'createdAt', 'updatedAt'],
    });
  }

  async findOne(id: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { id },
      select: ['id', 'email', 'name', 'role', 'isLocked', 'suspendedUntil', 'lastLoginAt'],
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { email: email.toLowerCase() },
      // Include password for authentication
      select: ['id', 'email', 'name', 'password', 'role', 'isLocked', 'suspendedUntil', 'failedLoginAttempts', 'lockedUntil'],
    });
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    const updateData = { ...updateUserDto };

    // Hash password if provided
    if (updateUserDto.password) {
      const saltRounds = 12;
      updateData.password = await bcrypt.hash(updateUserDto.password, saltRounds);
    }

    await this.usersRepository.update(id, updateData);
    
    // Since we know the user exists and was just updated, we can safely assert it's not null
    const updatedUser = await this.findOne(id);
    if (!updatedUser) {
      throw new NotFoundException(`User with ID ${id} was deleted during update`);
    }
    
    return updatedUser;
  }

  async remove(id: string): Promise<void> {
    const user = await this.findOne(id);
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    await this.usersRepository.delete(id);
  }

  // ADDED: Security-related methods
  async updateLastLogin(userId: string, ipAddress?: string): Promise<void> {
    await this.usersRepository
      .createQueryBuilder()
      .update(User)
      .set({
        lastLoginAt: () => 'CURRENT_TIMESTAMP',
        lastLoginIp: ipAddress || undefined,
        failedLoginAttempts: 0, // Reset failed attempts on successful login
      })
      .where('id = :id', { id: userId })
      .execute();
  }

  async incrementFailedLoginAttempts(email: string): Promise<void> {
    const user = await this.findByEmail(email);
    if (!user) return;

    const failedAttempts = (user.failedLoginAttempts || 0) + 1;
    const maxAttempts = 5;
    const lockDuration = 30 * 60 * 1000; // 30 minutes

    const updateQuery = this.usersRepository
      .createQueryBuilder()
      .update(User)
      .set({
        failedLoginAttempts: failedAttempts,
      })
      .where('id = :id', { id: user.id });

    // Lock account after max attempts
    if (failedAttempts >= maxAttempts) {
      updateQuery.set({
        failedLoginAttempts: failedAttempts,
        isLocked: true,
        lockedUntil: new Date(Date.now() + lockDuration),
      });
    }

    await updateQuery.execute();
  }

  async unlockUser(userId: string): Promise<void> {
    await this.usersRepository
      .createQueryBuilder()
      .update(User)
      .set({
        isLocked: false,
        lockedUntil: () => 'NULL',
        failedLoginAttempts: 0,
      })
      .where('id = :id', { id: userId })
      .execute();
  }

  async suspendUser(userId: string, suspendUntil: Date): Promise<void> {
    await this.usersRepository
      .createQueryBuilder()
      .update(User)
      .set({
        suspendedUntil: suspendUntil,
      })
      .where('id = :id', { id: userId })
      .execute();
  }

  async changePassword(userId: string, newPassword: string): Promise<void> {
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    await this.usersRepository
      .createQueryBuilder()
      .update(User)
      .set({
        password: hashedPassword,
      })
      .where('id = :id', { id: userId })
      .execute();
  }

  async validatePassword(userId: string, password: string): Promise<boolean> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['password'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return bcrypt.compare(password, user.password);
  }
}