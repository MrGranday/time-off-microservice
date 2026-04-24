import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Req,
  DefaultValuePipe,
  ParseIntPipe,
  Headers,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequestsService } from './requests.service';
import { CreateRequestDto, ReviewRequestDto } from './dto/request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/user.entity';

@Controller('requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RequestsController {
  constructor(private readonly requestsService: RequestsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() dto: CreateRequestDto,
    @CurrentUser() user: { id: string },
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
  ) {
    return this.requestsService.create(
      dto,
      user.id,
      idempotencyKey,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Get()
  findAll(
    @Query('employeeId') employeeId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @CurrentUser() user: { id: string; role: string },
  ) {
    // Employees can only see their own requests
    const effectiveEmployeeId =
      user.role === UserRole.EMPLOYEE ? user.id : employeeId;
    return this.requestsService.findAll({ employeeId: effectiveEmployeeId, status }, page, limit);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.requestsService.findById(id);
  }

  @Patch(':id/approve')
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRequestDto,
    @CurrentUser() user: { id: string },
    @Req() req: Request,
  ) {
    return this.requestsService.approve(id, user.id, dto, req.ip, req.headers['user-agent']);
  }

  @Patch(':id/reject')
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRequestDto,
    @CurrentUser() user: { id: string },
    @Req() req: Request,
  ) {
    return this.requestsService.reject(id, user.id, dto, req.ip, req.headers['user-agent']);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() req: Request,
  ) {
    return this.requestsService.cancel(id, user.id, req.ip, req.headers['user-agent']);
  }
}
