import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { UserRole } from '../user.entity';

export class CreateUserDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @IsUUID('4')
  @IsOptional()
  managerId?: string;

  @IsString()
  @IsOptional()
  locationId?: string;
}

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @IsUUID('4')
  @IsOptional()
  managerId?: string;

  @IsString()
  @IsOptional()
  locationId?: string;
}

export class AssignManagerDto {
  @IsUUID('4')
  @IsNotEmpty()
  managerId: string;
}
