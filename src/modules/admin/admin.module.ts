import { Body, Controller, Get, Module, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { MongooseModule } from '@nestjs/mongoose';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AlertsService } from './alerts.service';
import { Alert, AlertSchema } from './schemas/alert.schema';

@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('platform.admin')
export class AdminController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly audit: AuditService,
  ) {}

  @Get('alerts')
  list(@Query('status') status?: string) {
    return this.alerts.list(status);
  }

  /** Recomputes the audit hash chain end to end (19-3). */
  @Get('audit/verify')
  verifyAudit() {
    return this.audit.verifyChain();
  }
}

class AlertStatusDto {
  @IsIn(['open', 'reviewing', 'resolved'])
  status: 'open' | 'reviewing' | 'resolved';
}

/** A facility's own alerts: beds reaching their threshold or running out. */
@Controller('facilities/me/alerts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FacilityAlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.alerts.listForFacility(user.facilityCode, status);
  }

  @Patch(':id')
  setStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AlertStatusDto) {
    return this.alerts.setFacilityAlertStatus(user.facilityCode, id, dto.status);
  }
}

@Module({
  imports: [MongooseModule.forFeature([{ name: Alert.name, schema: AlertSchema }])],
  controllers: [AdminController, FacilityAlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AdminModule {}
