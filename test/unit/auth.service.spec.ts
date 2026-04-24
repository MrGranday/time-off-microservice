import { Test } from '@nestjs/testing';
import { AuthService } from '../../src/modules/auth/auth.service';
import { UsersService } from '../../src/modules/users/users.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UserRole } from '../../src/modules/users/user.entity';

const mockUsersService = () => ({
  findByEmail: jest.fn(),
  findByEmailWithPassword: jest.fn(),
  create: jest.fn(),
});

const mockJwtService = () => ({
  sign: jest.fn().mockReturnValue('mock.jwt.token'),
});

const mockConfigService = () => ({
  get: jest.fn((key: string) => {
    if (key === 'jwt.expiresIn') return '15m';
    return undefined;
  }),
});

describe('AuthService', () => {
  let service: AuthService;
  let usersService: ReturnType<typeof mockUsersService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useFactory: mockUsersService },
        { provide: JwtService, useFactory: mockJwtService },
        { provide: ConfigService, useFactory: mockConfigService },
      ],
    }).compile();

    service = module.get(AuthService);
    usersService = module.get(UsersService);
  });

  describe('register', () => {
    it('throws ConflictException when email already exists', async () => {
      usersService.findByEmail.mockResolvedValue({ id: 'existing-user' });
      await expect(
        service.register({ email: 'test@test.com', name: 'Test', password: 'password123' }),
      ).rejects.toThrow(ConflictException);
    });

    it('creates a user and returns tokens on success', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue({
        id: 'user-1',
        email: 'test@test.com',
        name: 'Test',
        role: UserRole.EMPLOYEE,
      });

      const result = await service.register({
        email: 'test@test.com',
        name: 'Test',
        password: 'password123',
      });

      expect(result.accessToken).toBe('mock.jwt.token');
      expect(result.tokenType).toBe('Bearer');
      expect(result.user.email).toBe('test@test.com');
    });

    it('hashes the password (never stores plaintext)', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue({
        id: 'u1', email: 'a@a.com', name: 'A', role: UserRole.EMPLOYEE,
      });

      await service.register({ email: 'a@a.com', name: 'A', password: 'plaintext' });

      const createCall = usersService.create.mock.calls[0][0];
      expect(createCall.password).not.toBe('plaintext');
      const isHashed = await bcrypt.compare('plaintext', createCall.password);
      expect(isHashed).toBe(true);
    });
  });

  describe('login', () => {
    it('throws UnauthorizedException for non-existent user', async () => {
      usersService.findByEmailWithPassword.mockResolvedValue(null);
      await expect(
        service.login({ email: 'nobody@test.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException for wrong password', async () => {
      const hashed = await bcrypt.hash('correct-password', 10);
      usersService.findByEmailWithPassword.mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        name: 'Test',
        role: UserRole.EMPLOYEE,
        password: hashed,
        isActive: true,
      });

      await expect(
        service.login({ email: 'test@test.com', password: 'wrong-password' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('returns tokens on valid credentials', async () => {
      const hashed = await bcrypt.hash('correct-password', 10);
      usersService.findByEmailWithPassword.mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        name: 'Test',
        role: UserRole.EMPLOYEE,
        password: hashed,
        isActive: true,
      });

      const result = await service.login({
        email: 'test@test.com',
        password: 'correct-password',
      });

      expect(result.accessToken).toBe('mock.jwt.token');
      expect(result.user.email).toBe('test@test.com');
    });

    it('throws UnauthorizedException for inactive user', async () => {
      usersService.findByEmailWithPassword.mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        name: 'Test',
        role: UserRole.EMPLOYEE,
        password: 'hashed',
        isActive: false,
      });

      await expect(
        service.login({ email: 'test@test.com', password: 'any' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
