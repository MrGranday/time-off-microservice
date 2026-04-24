import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { LeaveType } from '../../balances/balance.entity';

export class CreateRequestDto {
  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsEnum(LeaveType)
  @IsNotEmpty()
  leaveType: LeaveType;

  @IsDateString()
  @IsNotEmpty()
  startDate: string;

  @IsDateString()
  @IsNotEmpty()
  endDate: string;

  @IsNumber()
  @IsPositive()
  @Min(0.5)
  @Max(365)
  daysRequested: number;

  @IsString()
  @IsOptional()
  reason?: string;
}

export class ReviewRequestDto {
  @IsString()
  @IsOptional()
  managerNote?: string;
}

export class ListRequestsQueryDto {
  @IsUUID('4')
  @IsOptional()
  employeeId?: string;

  @IsString()
  @IsOptional()
  status?: string;

  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;
}
