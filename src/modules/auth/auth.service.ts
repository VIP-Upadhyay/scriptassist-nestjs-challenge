import { 
  Injectable, 
  UnauthorizedException, 
  BadRequestException,
  Logger,
  ForbiddenException,
  NotFoundException
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RefreshToken } from './entities/refresh-token.entity';
import { getErrorMessage } from '@common/utils/error.util';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly JWT_EXPIRY = '15m'; // Short-lived access tokens
  private readonly REFRESH_EXPIRY = '7d'; // Longer refresh tokens
  private readonly MAX_REFRESH_TOKENS_PER_USER = 5; // Limit concurrent sessions

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectRepository(RefreshToken)
    private refreshTokenRepository: Repository<RefreshToken>,
  ) {}



  async login(loginDto: LoginDto, userAgent?: string, ipAddress?: string): Promise<AuthResponse> {
    const { email, password } = loginDto;

    try {
      // FIXED: Add timing attack protection
      const user = await this.usersService.findByEmail(email);
      
      let isValidPassword = false;
      if (user) {
        isValidPassword = await bcrypt.compare(password, user.password);
      } else {
        // FIXED: Prevent timing attacks by always running bcrypt
        await bcrypt.compare(password, '$2b$10$dummy.hash.to.prevent.timing.attacks');
      }

      if (!user || !isValidPassword) {
        this.logger.warn(`Failed login attempt for email: ${email} from IP: ${ipAddress}`);
        throw new UnauthorizedException('Invalid credentials');
      }

      // FIXED: Check for account lockout or suspension
      if (user.isLocked || user.suspendedUntil && user.suspendedUntil > new Date()) {
        this.logger.warn(`Login attempt for locked/suspended account: ${email}`);
        throw new UnauthorizedException('Account is temporarily locked');
      }

      // FIXED: Generate secure token pair with device tracking
      const tokenPair = await this.generateTokenPair(user, userAgent, ipAddress);
      
      // FIXED: Update last login timestamp
      await this.usersService.updateLastLogin(user.id, ipAddress);
      
      this.logger.log(`Successful login for user: ${user.id}`);

      return {
        ...tokenPair,
        expires_in: 900, // 15 minutes in seconds
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error(`Login error: ${getErrorMessage(error)}`);
      throw new UnauthorizedException('Authentication failed');
    }
  }

  async register(registerDto: RegisterDto): Promise<AuthResponse> {
    const { email, password, name } = registerDto;

    try {
      // FIXED: Check for existing user with better error handling
      const existingUser = await this.usersService.findByEmail(email);
      if (existingUser) {
        throw new BadRequestException('Email already registered');
      }

      // FIXED: Strong password validation
      this.validatePasswordStrength(password);

      // FIXED: Create user with proper validation
      const user = await this.usersService.create({
        email: email.toLowerCase().trim(),
        password,
        name: name.trim(),
        // role will default to 'user' in the service
      });

      // FIXED: Generate tokens for new user
      const tokenPair = await this.generateTokenPair(user);

      this.logger.log(`New user registered: ${user.id}`);

      return {
        ...tokenPair,
        expires_in: 900,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Registration error: ${getErrorMessage(error)}`);
      throw new BadRequestException('Registration failed');
    }
  }

  async refreshTokens(refreshTokenDto: RefreshTokenDto): Promise<TokenPair> {
    const { refresh_token } = refreshTokenDto;

    try {
      // FIXED: Validate refresh token and get stored token
      const storedToken = await this.refreshTokenRepository.findOne({
        where: { token: refresh_token },
        relations: ['user'],
      });

      if (!storedToken || storedToken.expiresAt < new Date()) {
        if (storedToken) {
          // Clean up expired token
          await this.refreshTokenRepository.remove(storedToken);
        }
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      // FIXED: Check if token has been revoked
      if (storedToken.isRevoked) {
        this.logger.warn(`Attempt to use revoked refresh token: ${storedToken.id}`);
        throw new UnauthorizedException('Token has been revoked');
      }

      const user = storedToken.user;

      // FIXED: Check user account status
      if (user.isLocked || user.suspendedUntil && user.suspendedUntil > new Date()) {
        throw new UnauthorizedException('Account is locked or suspended');
      }

      // FIXED: Implement refresh token rotation for security
      await this.refreshTokenRepository.remove(storedToken);

      // Generate new token pair
      const newTokenPair = await this.generateTokenPair(
        user,
        storedToken.userAgent,
        storedToken.ipAddress
      );

      this.logger.log(`Tokens refreshed for user: ${user.id}`);

      return newTokenPair;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error(`Token refresh error: ${getErrorMessage(error)}`);
      throw new UnauthorizedException('Token refresh failed');
    }
  }

  async logout(refreshToken: string): Promise<void> {
    try {
      const storedToken = await this.refreshTokenRepository.findOne({
        where: { token: refreshToken },
      });

      if (storedToken) {
        await this.refreshTokenRepository.remove(storedToken);
        this.logger.log(`User logged out, token revoked: ${storedToken.id}`);
      }
    } catch (error) {
      this.logger.error(`Logout error: ${getErrorMessage(error)}`);
      // Don't throw error for logout failures
    }
  }

  async logoutAllDevices(userId: string): Promise<void> {
    try {
      await this.refreshTokenRepository.delete({ user: { id: userId } });
      this.logger.log(`All devices logged out for user: ${userId}`);
    } catch (error) {
      this.logger.error(`Logout all devices error: ${getErrorMessage(error)}`);
      throw new BadRequestException('Failed to logout all devices');
    }
  }

  async validateUser(userId: string): Promise<any> {
    try {
      const user = await this.usersService.findOne(userId);
      
      if (!user) {
        return null;
      }

      // FIXED: Check account status during validation
      if (user.isLocked || user.suspendedUntil && user.suspendedUntil > new Date()) {
        return null;
      }
      
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      };
    } catch (error) {
      this.logger.error(`User validation error: ${getErrorMessage(error)}`);
      return null;
    }
  }

  async validateUserRoles(userId: string, requiredRoles: string[]): Promise<boolean> {
    try {
      // FIXED: Implement proper role validation instead of always returning true
      const user = await this.usersService.findOne(userId);
      
      if (!user) {
        return false;
      }

      // Check if user has any of the required roles
      const hasRequiredRole = requiredRoles.includes(user.role);
      
      if (!hasRequiredRole) {
        this.logger.warn(`Access denied for user ${userId}. Required roles: ${requiredRoles.join(', ')}, User role: ${user.role}`);
      }

      return hasRequiredRole;
    } catch (error) {
      this.logger.error(`Role validation error: ${getErrorMessage(error)}`);
      return false;
    }
  }

  private async generateTokenPair(
    user: any,
    userAgent?: string,
    ipAddress?: string
  ): Promise<TokenPair> {
    // FIXED: Generate access token with minimal payload
    const accessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      type: 'access',
    };

    const access_token = this.jwtService.sign(accessTokenPayload, {
      expiresIn: this.JWT_EXPIRY,
      secret: this.configService.get('jwt.secret'),
    });

    // FIXED: Generate refresh token with different secret
    const refreshTokenPayload = {
      sub: user.id,
      type: 'refresh',
      jti: crypto.randomBytes(16).toString('hex'), // Unique token ID
    };

    const refresh_token = this.jwtService.sign(refreshTokenPayload, {
      expiresIn: this.REFRESH_EXPIRY,
      secret: this.configService.get('jwt.refreshSecret') || this.configService.get('jwt.secret'),
    });

    // FIXED: Store refresh token securely with device info
    await this.storeRefreshToken(
      user.id,
      refresh_token,
      userAgent,
      ipAddress
    );

    return { access_token, refresh_token };
  }

  private async storeRefreshToken(
    userId: string,
    token: string,
    userAgent?: string,
    ipAddress?: string
  ): Promise<void> {
    // FIXED: Implement refresh token rotation and limits
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

    // Hash the token before storing (security best practice)
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const refreshToken = this.refreshTokenRepository.create({
      token: hashedToken,
      userId,
      expiresAt,
      userAgent: userAgent?.substring(0, 500), // Limit length
      ipAddress,
      isRevoked: false,
    });

    await this.refreshTokenRepository.save(refreshToken);

    // FIXED: Limit number of refresh tokens per user (prevent abuse)
    await this.cleanupOldTokens(userId);
  }

  private async cleanupOldTokens(userId: string): Promise<void> {
    // Remove expired tokens
    await this.refreshTokenRepository
      .createQueryBuilder()
      .delete()
      .where('userId = :userId AND expiresAt < :now', {
        userId,
        now: new Date(),
      })
      .execute();

    // Limit concurrent sessions
    const tokenCount = await this.refreshTokenRepository.count({
      where: { userId },
    });

    if (tokenCount > this.MAX_REFRESH_TOKENS_PER_USER) {
      const tokensToRemove = await this.refreshTokenRepository.find({
        where: { userId },
        order: { createdAt: 'ASC' },
        take: tokenCount - this.MAX_REFRESH_TOKENS_PER_USER,
      });

      if (tokensToRemove.length > 0) {
        await this.refreshTokenRepository.remove(tokensToRemove);
        this.logger.log(`Cleaned up ${tokensToRemove.length} old tokens for user: ${userId}`);
      }
    }
  }

  private validatePasswordStrength(password: string): void {
    // FIXED: Implement proper password validation
    const minLength = 8;
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);

    const errors: string[] = [];

    if (password.length < minLength) {
      errors.push(`Password must be at least ${minLength} characters long`);
    }

    if (!hasUpperCase) {
      errors.push('Password must contain at least one uppercase letter');
    }

    if (!hasLowerCase) {
      errors.push('Password must contain at least one lowercase letter');
    }

    if (!hasNumbers) {
      errors.push('Password must contain at least one number');
    }

    if (!hasSpecialChar) {
      errors.push('Password must contain at least one special character');
    }

    if (errors.length > 0) {
      throw new BadRequestException({
        message: 'Password does not meet requirements',
        errors,
      });
    }
  }

  async revokeToken(tokenId: string, userId: string): Promise<void> {
    // FIXED: Allow users to revoke specific tokens
    const token = await this.refreshTokenRepository.findOne({
      where: { id: tokenId, userId },
    });

    if (!token) {
      throw new NotFoundException('Token not found');
    }

    token.isRevoked = true;
    await this.refreshTokenRepository.save(token);
    
    this.logger.log(`Token revoked: ${tokenId} for user: ${userId}`);
  }

  async getUserSessions(userId: string): Promise<any[]> {
    // FIXED: Allow users to see their active sessions
    const tokens = await this.refreshTokenRepository.find({
      where: { userId, isRevoked: false },
      order: { createdAt: 'DESC' },
    });

    return tokens.map(token => ({
      id: token.id,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      userAgent: token.userAgent,
      ipAddress: token.ipAddress,
      isCurrent: false, // Could be determined by comparing with current request
    }));
  }
}