import { Controller, Get, Module, Query, UseGuards } from '@nestjs/common';
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

@Module({
  imports: [MongooseModule.forFeature([{ name: Alert.name, schema: AlertSchema }])],
  controllers: [AdminController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AdminModule {}
