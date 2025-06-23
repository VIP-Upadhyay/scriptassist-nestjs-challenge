import { 
  Body, 
  Controller, 
  Post, 
  Get,
  Delete,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { Request } from 'express';

@ApiTags('auth')
@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'User login with enhanced security' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  @RateLimit({ limit: 5, windowMs: 60000 }) // 5 attempts per minute
  async login(@Body() loginDto: LoginDto, @Req() req: Request) {
    const userAgent = req.headers['user-agent'];
    const ipAddress = req.ip || req.connection.remoteAddress;
    
    return this.authService.login(loginDto, userAgent, ipAddress);
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'User registration with validation' })
  @ApiResponse({ status: 201, description: 'Registration successful' })
  @ApiResponse({ status: 400, description: 'Invalid data or email already exists' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  @RateLimit({ limit: 3, windowMs: 300000 }) // 3 registrations per 5 minutes
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token with token rotation' })
  @ApiResponse({ status: 200, description: 'Token refreshed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  @RateLimit({ limit: 10, windowMs: 60000 }) // 10 refreshes per minute
  async refreshToken(@Body() refreshTokenDto: RefreshTokenDto) {
    return this.authService.refreshTokens(refreshTokenDto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout and revoke refresh token' })
  @ApiResponse({ status: 204, description: 'Logout successful' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async logout(@Body() refreshTokenDto: RefreshTokenDto) {
    await this.authService.logout(refreshTokenDto.refresh_token);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout from all devices' })
  @ApiResponse({ status: 204, description: 'Logged out from all devices' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async logoutAll(@CurrentUser() user: any) {
    await this.authService.logoutAllDevices(user.id);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'User profile retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async getProfile(@CurrentUser() user: any) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Get active sessions for current user' })
  @ApiResponse({ status: 200, description: 'Active sessions retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async getSessions(@CurrentUser() user: any) {
    return this.authService.getUserSessions(user.id);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a specific session' })
  @ApiResponse({ status: 204, description: 'Session revoked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async revokeSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: any
  ) {
    await this.authService.revokeToken(sessionId, user.id);
  }

  @Post('verify-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify if access token is valid' })
  @ApiResponse({ status: 200, description: 'Token is valid' })
  @ApiResponse({ status: 401, description: 'Token is invalid' })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async verifyToken(@CurrentUser() user: any) {
    return {
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    };
  }
}