import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from './user.entity';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async create(dto: CreateUserDto): Promise<User> {
    if (dto.managerId) {
      const manager = await this.userRepo.findOne({
        where: { id: dto.managerId },
      });
      if (!manager) {
        throw new BadRequestException(
          `Manager with ID ${dto.managerId} does not exist`,
        );
      }
      if (
        manager.role !== UserRole.MANAGER &&
        manager.role !== UserRole.ADMIN
      ) {
        throw new BadRequestException(
          'The assigned manager must have the MANAGER or ADMIN role',
        );
      }
    }

    const user = this.userRepo.create({
      email: dto.email,
      name: dto.name,
      password: dto.password,
      role: dto.role ?? UserRole.EMPLOYEE,
      managerId: dto.managerId ?? null,
      locationId: dto.locationId ?? null,
    });

    return this.userRepo.save(user);
  }

  async findById(id: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { email } });
  }

  /** Loads user with password field (select: false) for login verification only. */
  async findByEmailWithPassword(email: string): Promise<User | null> {
    return this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.email = :email', { email })
      .getOne();
  }

  async findAll(): Promise<User[]> {
    return this.userRepo.find({ where: { isActive: true } });
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.findByIdOrThrow(id);

    if (dto.managerId) {
      const manager = await this.userRepo.findOne({
        where: { id: dto.managerId },
      });
      if (!manager) {
        throw new BadRequestException(
          `Manager with ID ${dto.managerId} does not exist`,
        );
      }
      if (
        manager.role !== UserRole.MANAGER &&
        manager.role !== UserRole.ADMIN
      ) {
        throw new BadRequestException(
          'Assigned manager must have MANAGER or ADMIN role',
        );
      }
      // Prevent circular management chain
      if (dto.managerId === id) {
        throw new BadRequestException('A user cannot be their own manager');
      }
    }

    Object.assign(user, dto);
    return this.userRepo.save(user);
  }

  async deactivate(id: string): Promise<void> {
    const user = await this.findByIdOrThrow(id);
    user.isActive = false;
    await this.userRepo.save(user);
  }

  /** Returns all employees that directly report to this manager. */
  async getSubordinates(managerId: string): Promise<User[]> {
    return this.userRepo.find({ where: { managerId, isActive: true } });
  }

  async isManagerOf(managerId: string, employeeId: string): Promise<boolean> {
    const employee = await this.userRepo.findOne({ where: { id: employeeId } });
    return employee?.managerId === managerId;
  }

  private async findByIdOrThrow(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }
}
