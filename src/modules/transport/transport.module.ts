import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Model, Types } from 'mongoose';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { LocationDto } from '../facilities/dto/facilities.dto';
import { AmbulanceRequest, AmbulanceRequestSchema } from './schemas/ambulance-request.schema';
import { Ambulance, AmbulanceDocument, AmbulanceSchema } from './schemas/ambulance.schema';

class RegisterAmbulanceDto {
  @IsString() @IsNotEmpty() @MaxLength(40) label: string;
  @IsIn(['bls', 'als']) level: 'bls' | 'als';
}

class CheckInDto {
  @IsIn(['available', 'busy', 'offline']) status: 'available' | 'busy' | 'offline';
  @IsOptional() @ValidateNested() @Type(() => LocationDto) location?: LocationDto;
}

/**
 * Ambulance fleet with manual check-in (Epic 13, G7 — core). Dispatch tiers,
 * costing and the request flow are next; ambulance_requests is schema only.
 */
@Injectable()
export class AmbulancesService {
  constructor(@InjectModel(Ambulance.name) private readonly ambulances: Model<AmbulanceDocument>) {}

  register(user: AuthUser, dto: RegisterAmbulanceDto) {
    return this.ambulances.create({ ...dto, ownerFacility: user.facilityCode, registeredBy: new Types.ObjectId(user.userId) });
  }

  listOwn(facilityCode: string) {
    return this.ambulances.find({ ownerFacility: facilityCode }).sort({ label: 1 }).lean();
  }

  listAvailable() {
    return this.ambulances.find({ status: 'available' }, { ownerFacility: 1, label: 1, level: 1, location: 1 }).lean();
  }

  async checkIn(user: AuthUser, id: string, dto: CheckInDto) {
    const updated = await this.ambulances.findOneAndUpdate(
      { _id: id, ownerFacility: user.facilityCode },
      { $set: { status: dto.status, ...(dto.location ? { location: { ...dto.location, updatedAt: new Date() } } : {}) } },
      { new: true },
    );
    if (!updated) throw new NotFoundException('No such ambulance in your fleet.');
    return updated;
  }
}

@Controller('ambulances')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AmbulancesController {
  constructor(private readonly ambulances: AmbulancesService) {}

  @Get()
  @RequirePermissions('transport.manage')
  mine(@CurrentUser() user: AuthUser) {
    return this.ambulances.listOwn(user.facilityCode);
  }

  @Get('available')
  available() {
    return this.ambulances.listAvailable();
  }

  @Post()
  @RequirePermissions('transport.manage')
  register(@CurrentUser() user: AuthUser, @Body() dto: RegisterAmbulanceDto) {
    return this.ambulances.register(user, dto);
  }

  @Patch(':id/check-in')
  @RequirePermissions('transport.manage')
  checkIn(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CheckInDto) {
    return this.ambulances.checkIn(user, id, dto);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ambulance.name, schema: AmbulanceSchema },
      { name: AmbulanceRequest.name, schema: AmbulanceRequestSchema },
    ]),
  ],
  controllers: [AmbulancesController],
  providers: [AmbulancesService],
  exports: [AmbulancesService],
})
export class TransportModule {}
