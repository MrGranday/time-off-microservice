import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UsersService } from '../../src/modules/users/users.service';
import { User, UserRole } from '../../src/modules/users/user.entity';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('UsersService', () => {
  let service: UsersService;

  const mockUserRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepo,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create an employee without a manager', async () => {
      const dto = { email: 'a@a.com', name: 'A', password: 'p' };
      mockUserRepo.create.mockReturnValue({
        ...dto,
        id: '1',
        role: UserRole.EMPLOYEE,
      });
      mockUserRepo.save.mockResolvedValue({
        ...dto,
        id: '1',
        role: UserRole.EMPLOYEE,
      });

      const res = await service.create(dto);
      expect(res.id).toBe('1');
    });

    it('should throw BadRequestException if assigned manager does not exist', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      await expect(
        service.create({
          email: 'b@b.com',
          name: 'B',
          password: 'p',
          managerId: 'm1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if assigned manager is an EMPLOYEE', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'm1',
        role: UserRole.EMPLOYEE,
      });
      await expect(
        service.create({
          email: 'b@b.com',
          name: 'B',
          password: 'p',
          managerId: 'm1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create if assigned manager is a MANAGER', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'm1',
        role: UserRole.MANAGER,
      });
      const dto = {
        email: 'b@b.com',
        name: 'B',
        password: 'p',
        managerId: 'm1',
      };
      mockUserRepo.create.mockReturnValue(dto);
      mockUserRepo.save.mockResolvedValue({ ...dto, id: '2' });

      const res = await service.create(dto);
      expect(res.managerId).toBe('m1');
    });
  });

  describe('find', () => {
    it('should findById', async () => {
      mockUserRepo.findOne.mockResolvedValue({ id: '1' });
      const res = await service.findById('1');
      expect(res?.id).toBe('1');
    });

    it('should findByEmail', async () => {
      mockUserRepo.findOne.mockResolvedValue({ email: 'a@a.com' });
      const res = await service.findByEmail('a@a.com');
      expect(res?.email).toBe('a@a.com');
    });

    it('should findAll active', async () => {
      mockUserRepo.find.mockResolvedValue([{ id: '1' }]);
      const res = await service.findAll();
      expect(res.length).toBe(1);
    });

    it('should findByEmailWithPassword', async () => {
      const mockQb = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest
          .fn()
          .mockResolvedValue({ email: 'a@a.com', password: 'hash' }),
      };
      mockUserRepo.createQueryBuilder.mockReturnValue(mockQb);

      const res = await service.findByEmailWithPassword('a@a.com');
      expect(res?.password).toBe('hash');
    });
  });

  describe('update', () => {
    it('should throw NotFoundException if user not found', async () => {
      mockUserRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.update('1', { name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should update user without manager change', async () => {
      mockUserRepo.findOne.mockResolvedValueOnce({ id: '1', name: 'Old' });
      mockUserRepo.save.mockResolvedValueOnce({ id: '1', name: 'New' });
      const res = await service.update('1', { name: 'New' });
      expect(res.name).toBe('New');
    });

    it('should throw BadRequestException if new manager does not exist', async () => {
      mockUserRepo.findOne
        .mockResolvedValueOnce({ id: '1', name: 'Old' }) // The user
        .mockResolvedValueOnce(null); // The manager

      await expect(service.update('1', { managerId: '2' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if new manager is not MANAGER/ADMIN', async () => {
      mockUserRepo.findOne
        .mockResolvedValueOnce({ id: '1', name: 'Old' })
        .mockResolvedValueOnce({ id: '2', role: UserRole.EMPLOYEE });

      await expect(service.update('1', { managerId: '2' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for circular management', async () => {
      mockUserRepo.findOne
        .mockResolvedValueOnce({ id: '1', name: 'Old' })
        .mockResolvedValueOnce({ id: '1', role: UserRole.MANAGER });

      await expect(service.update('1', { managerId: '1' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('deactivate', () => {
    it('should deactivate user', async () => {
      mockUserRepo.findOne.mockResolvedValue({ id: '1', isActive: true });
      mockUserRepo.save.mockImplementation((u) => Promise.resolve(u));

      await service.deactivate('1');
      expect(mockUserRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false }),
      );
    });
  });

  describe('manager relations', () => {
    it('should get subordinates', async () => {
      mockUserRepo.find.mockResolvedValue([{ id: '2' }]);
      const res = await service.getSubordinates('m1');
      expect(res.length).toBe(1);
    });

    it('should return true if is manager of', async () => {
      mockUserRepo.findOne.mockResolvedValue({ managerId: 'm1' });
      const res = await service.isManagerOf('m1', 'e1');
      expect(res).toBe(true);
    });
  });
});
