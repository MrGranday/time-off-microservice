import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SyncService } from './sync.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/user.entity';
import { SyncTrigger } from './sync-log.entity';
import {
  IsArray,
  IsNotEmpty,
  IsString,
  IsNumber,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class HcmBatchRecordDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  leaveType: string;

  @IsNumber()
  totalDays: number;

  @IsNumber()
  usedDays: number;

  @IsString()
  @IsNotEmpty()
  lastModifiedAt: string;
}

class BatchSyncDto {
  @IsArray()
  @IsNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => HcmBatchRecordDto)
  records: HcmBatchRecordDto[];
}

@Controller('sync')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /** Admin triggers a full batch sync by posting the HCM corpus. */
  @Post('batch')
  @HttpCode(HttpStatus.OK)
  async runBatchSync(@Body() dto: BatchSyncDto) {
    return this.syncService.runBatchSync(
      dto.records,
      SyncTrigger.MANUAL,
      'ADMIN',
    );
  }

  @Get('logs')
  getLogs(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.syncService.getLogs(page, limit);
  }
}
