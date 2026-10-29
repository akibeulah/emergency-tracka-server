import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { InviteStaffDto, SetPermissionsDto, SetRosterDto, SetStatusDto } from './dto/users.dto';
import { UsersService } from './users.service';

/** Staff and roster of the caller's own facility. */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('staff')
  @RequirePermissions('staff.manage')
  list(@CurrentUser() user: AuthUser) {
    return this.users.listStaff(user.facilityCode);
  }

  /** The escort-nurse picker on a new referral; senders don't hold `staff.manage`. */
  @Get('staff/escorts')
  @RequirePermissions('referral.send')
  escorts(@CurrentUser() user: AuthUser) {
    return this.users.listEscorts(user.facilityCode);
  }

  @Post('staff')
  @RequirePermissions('staff.manage')
  invite(@CurrentUser() user: AuthUser, @Body() dto: InviteStaffDto) {
    return this.users.invite(user.facilityCode, dto);
  }

  @Patch('staff/:id/permissions')
  @RequirePermissions('staff.manage')
  setPermissions(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SetPermissionsDto) {
    return this.users.setPermissions(user.facilityCode, id, dto.permissions);
  }

  @Patch('staff/:id/status')
  @RequirePermissions('staff.manage')
  setStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.users.setStatus(user.facilityCode, id, dto.status);
  }

  @Get('rosters/current')
  getRoster(@CurrentUser() user: AuthUser) {
    return this.users.getRoster(user.facilityCode);
  }

  @Put('rosters/current')
  @RequirePermissions('roster.manage')
  setRoster(@CurrentUser() user: AuthUser, @Body() dto: SetRosterDto) {
    return this.users.setRoster(user.facilityCode, user.userId, dto.entries);
  }
}
