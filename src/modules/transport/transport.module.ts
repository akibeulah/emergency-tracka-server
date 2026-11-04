import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Module, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Type } from 'class-transformer';
import { IsIn, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CasesModule } from '../cases/cases.module';
import { LocationDto } from '../facilities/dto/facilities.dto';
import { UsersModule } from '../users/users.module';
import { VEHICLE_CLASSES, VehicleClass } from './fares';
import { AmbulanceRequest, AmbulanceRequestSchema } from './schemas/ambulance-request.schema';
import { Ambulance, AmbulanceSchema } from './schemas/ambulance.schema';
import { CREW_STEPS, CrewStep, TransportService } from './transport.service';

class RegisterAmbulanceDto {
  @IsString() @IsNotEmpty() @MaxLength(40) label: string;
  @IsIn(['bls', 'als']) level: 'bls' | 'als';
  @IsOptional() @IsIn(VEHICLE_CLASSES) vehicleClass?: VehicleClass;
  @IsOptional() @IsMongoId() driverUserId?: string;
}

class UpdateAmbulanceDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) label?: string;
  @IsOptional() @IsIn(['bls', 'als']) level?: 'bls' | 'als';
  @IsOptional() @IsIn(VEHICLE_CLASSES) vehicleClass?: VehicleClass;
  /** null or '' clears the driver. */
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @IsMongoId() driverUserId?: string | null;
}

class SetAmbulanceStatusDto {
  @IsIn(['available', 'offline']) status: 'available' | 'offline';
  @IsOptional() @ValidateNested() @Type(() => LocationDto) location?: LocationDto;
}

class PickAmbulanceDto {
  @IsMongoId() ambulanceId: string;
}

class ProgressDto {
  @IsIn(CREW_STEPS) step: CrewStep;
}

/** Fleet: the facility's ambulances, the maximum it set, and who can toggle them. */
@Controller('ambulances')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AmbulancesController {
  constructor(private readonly transport: TransportService) {}

  @Get()
  @RequirePermissions('transport.respond')
  mine(@CurrentUser() user: AuthUser) {
    return this.transport.listOwn(user.facilityCode);
  }

  /** The fixed fare tiers, for showing a price before anyone accepts. */
  @Get('fares')
  fares() {
    return this.transport.fares();
  }

  @Get('crew')
  @RequirePermissions('transport.manage')
  crew(@CurrentUser() user: AuthUser) {
    return this.transport.listCrew(user.facilityCode);
  }

  @Post()
  @RequirePermissions('transport.manage')
  register(@CurrentUser() user: AuthUser, @Body() dto: RegisterAmbulanceDto) {
    return this.transport.register(user, dto);
  }

  @Patch(':id')
  @RequirePermissions('transport.manage')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateAmbulanceDto) {
    return this.transport.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('transport.manage')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transport.remove(user, id);
  }

  /** Staff toggle availability (available / offline). */
  @Patch(':id/status')
  @RequirePermissions('transport.respond')
  setStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SetAmbulanceStatusDto) {
    return this.transport.setStatus(user, id, dto.status, dto.location);
  }
}

/** Rides: open broadcasts, this facility's jobs, and the crew's steps. */
@Controller('ambulance-requests')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AmbulanceRequestsController {
  constructor(private readonly transport: TransportService) {}

  @Get('open')
  @RequirePermissions('transport.respond')
  open(@CurrentUser() user: AuthUser) {
    return this.transport.listOpen(user.facilityCode);
  }

  @Get('jobs')
  @RequirePermissions('transport.respond')
  jobs(@CurrentUser() user: AuthUser) {
    return this.transport.listJobs(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transport.getJob(user, id);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('transport.respond')
  accept(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PickAmbulanceDto) {
    return this.transport.accept(user, id, dto.ambulanceId);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('transport.respond')
  assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PickAmbulanceDto) {
    return this.transport.assign(user, id, dto.ambulanceId);
  }

  @Post(':id/progress')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('transport.respond')
  progress(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ProgressDto) {
    return this.transport.progress(user, id, dto.step);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ambulance.name, schema: AmbulanceSchema },
      { name: AmbulanceRequest.name, schema: AmbulanceRequestSchema },
    ]),
    CasesModule,
    UsersModule,
  ],
  controllers: [AmbulancesController, AmbulanceRequestsController],
  providers: [TransportService],
  exports: [TransportService, MongooseModule],
})
export class TransportModule {}
