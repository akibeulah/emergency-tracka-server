import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReasonDto, RegistrySearchDto, SubmitClaimDto, UpdateProfileDto } from './dto/facilities.dto';
import { FacilitiesService } from './facilities.service';

@Controller('facilities')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FacilitiesController {
  constructor(private readonly facilities: FacilitiesService) {}

  /** Verified facilities (name, code, location, duty line). */
  @Get()
  directory() {
    return this.facilities.directory();
  }

  @Get('registry')
  searchRegistry(@Query() query: RegistrySearchDto) {
    return this.facilities.searchRegistry(query.q);
  }

  @Post(':id/claim')
  submitClaim(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: SubmitClaimDto) {
    return this.facilities.submitClaim(id, user, dto);
  }

  @Get('me')
  mine(@CurrentUser() user: AuthUser) {
    return this.facilities.getByCode(user.facilityCode);
  }

  @Patch('me/profile')
  @RequirePermissions('facility.manage')
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.facilities.updateProfile(user.facilityCode, dto);
  }
}

/** Onboarding queue and suspension for platform administrators (Epic 1, 14). */
@Controller('admin/facilities')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('platform.admin')
export class AdminFacilitiesController {
  constructor(private readonly facilities: FacilitiesService) {}

  @Get('claims')
  claims() {
    return this.facilities.listClaims();
  }

  @Post(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() admin: AuthUser) {
    return this.facilities.approveClaim(id, admin);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentUser() admin: AuthUser, @Body() dto: ReasonDto) {
    return this.facilities.rejectClaim(id, admin, dto.reason);
  }

  @Post(':id/suspend')
  suspend(@Param('id') id: string, @CurrentUser() admin: AuthUser, @Body() dto: ReasonDto) {
    return this.facilities.suspend(id, admin, dto.reason);
  }

  @Post(':id/reinstate')
  reinstate(@Param('id') id: string, @CurrentUser() admin: AuthUser) {
    return this.facilities.reinstate(id, admin);
  }
}
