import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { BalancesService } from './balances.service';
import { SyncService } from '../sync/sync.service';
import { LeaveType } from './balance.entity';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/user.entity';
import { SyncTrigger } from '../sync/sync-log.entity';

@Controller('balances')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BalancesController {
  constructor(
    private readonly balancesService: BalancesService,
    private readonly syncService: SyncService,
  ) {}

  /** Employee views their own balances. Admin/Manager can view anyone's. */
  @Get(':employeeId')
  async getBalances(
    @Param('employeeId') employeeId: string,
    @CurrentUser() user: { id: string; role: string },
  ) {
    this.assertCanViewEmployee(user, employeeId);
    return this.balancesService.findAll(employeeId);
  }

  @Get(':employeeId/:locationId/:leaveType')
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Param('leaveType') leaveType: string,
    @CurrentUser() user: { id: string; role: string },
  ) {
    this.assertCanViewEmployee(user, employeeId);
    return this.balancesService.findOne(employeeId, locationId, leaveType as LeaveType);
  }

  /** Manually trigger a real-time HCM sync for an employee's balance. */
  @Post('sync/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async syncEmployee(
    @Param('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
    @Query('leaveType') leaveType: string,
  ) {
    await this.syncService.syncEmployeeBalance(
      employeeId,
      locationId,
      leaveType,
      SyncTrigger.MANUAL,
    );
    return { message: 'Sync triggered successfully' };
  }

  private assertCanViewEmployee(
    user: { id: string; role: string },
    employeeId: string,
  ): void {
    if (
      user.role !== UserRole.ADMIN &&
      user.role !== UserRole.MANAGER &&
      user.id !== employeeId
    ) {
      throw new Error('Forbidden');
    }
  }
}
