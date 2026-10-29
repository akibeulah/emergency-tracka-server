import { BullModule } from '@nestjs/bullmq';
import { Body, Controller, Get, Module, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { FeatureFlagGuard } from '../../common/feature-flags';
import { QUEUE_CASE_TIMERS } from '../../config/queue-names';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { BloodService } from './blood.service';
import {
  BLOOD_COMPONENTS,
  BLOOD_GROUPS,
  BLOOD_RH,
  BloodHold,
  BloodHoldSchema,
  BloodStock,
  BloodStockSchema,
  Donation,
  DonationSchema,
  Donor,
  DonorSchema,
} from './schemas/blood.schemas';

class StockRowDto {
  @IsIn(BLOOD_GROUPS) group: string;
  @IsIn(BLOOD_RH) rh: string;
  @IsIn(BLOOD_COMPONENTS) component: string;
  @IsInt() @Min(0) units: number;
  @IsOptional() @IsInt() @Min(0) minTarget?: number;
}

class SearchDto {
  @IsIn(BLOOD_GROUPS) group: string;
  @IsIn(BLOOD_RH) rh: string;
  @IsIn(BLOOD_COMPONENTS) component: string;
}

class HoldDto {
  @IsMongoId() stockId: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(20) units: number;
  @IsOptional() @IsMongoId() caseId?: string;
}

/** FeatureFlagGuard runs first: with the flag off, every route is a 404 (G2). */
@Controller('blood')
@UseGuards(FeatureFlagGuard('blood'), JwtAuthGuard, PermissionsGuard)
export class BloodController {
  constructor(private readonly blood: BloodService) {}

  @Get('stock')
  @RequirePermissions('blood.manage')
  mine(@CurrentUser() user: AuthUser) {
    return this.blood.listOwn(user.facilityCode);
  }

  @Put('stock')
  @RequirePermissions('blood.manage')
  set(@CurrentUser() user: AuthUser, @Body() dto: StockRowDto) {
    return this.blood.setStock(user.facilityCode, user, dto);
  }

  @Get('search')
  search(@Query() q: SearchDto) {
    return this.blood.search(q.group, q.rh, q.component);
  }

  @Post('holds')
  hold(@CurrentUser() user: AuthUser, @Body() dto: HoldDto) {
    return this.blood.hold(dto.stockId, dto.units, user, dto.caseId);
  }

  @Post('holds/:id/fulfil')
  @RequirePermissions('blood.manage')
  fulfil(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.blood.fulfil(id, user.facilityCode);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BloodStock.name, schema: BloodStockSchema },
      { name: BloodHold.name, schema: BloodHoldSchema },
      { name: Donor.name, schema: DonorSchema },
      { name: Donation.name, schema: DonationSchema },
    ]),
    BullModule.registerQueue({ name: QUEUE_CASE_TIMERS }),
  ],
  controllers: [BloodController],
  providers: [BloodService],
  exports: [BloodService],
})
export class BloodModule {}
