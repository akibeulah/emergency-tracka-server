import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseEnumPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CapacityService } from './capacity.service';
import { ConfigureBedCategoryDto, SetOccupancyDto, SetOxygenDto, SetSecondaryMarkerDto, SetSpecialistsDto } from './dto/capacity.dto';
import { BED_CATEGORY_NAMES, BedCategoryName } from './schemas/bed-category.schema';

const bedName = new ParseEnumPipe(Object.fromEntries(BED_CATEGORY_NAMES.map((n) => [n, n])));

@Controller('capacity')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CapacityController {
  constructor(private readonly capacity: CapacityService) {}

  @Get()
  overview() {
    return this.capacity.overview();
  }

  @Get('beds')
  mine(@CurrentUser() user: AuthUser) {
    return this.capacity.listOwn(user.facilityCode);
  }

  @Put('beds/:name')
  @RequirePermissions('beds.configure')
  configure(
    @CurrentUser() user: AuthUser,
    @Param('name', bedName) name: BedCategoryName,
    @Body() dto: ConfigureBedCategoryDto,
  ) {
    return this.capacity.configure(user.facilityCode, name, dto.maxSpaces, dto.limitedThreshold, user);
  }

  @Patch('beds/:name')
  @RequirePermissions('beds.update')
  setOccupancy(
    @CurrentUser() user: AuthUser,
    @Param('name', bedName) name: BedCategoryName,
    @Body() dto: SetOccupancyDto,
  ) {
    return this.capacity.setOccupancy(user.facilityCode, name, dto.occupied, user);
  }

  @Post('still-correct')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('beds.update')
  stillCorrect(@CurrentUser() user: AuthUser) {
    return this.capacity.confirmStillCorrect(user.facilityCode, user);
  }

  @Put('oxygen')
  @RequirePermissions('beds.update')
  oxygen(@CurrentUser() user: AuthUser, @Body() dto: SetOxygenDto) {
    return this.capacity.setOxygen(user.facilityCode, dto.state, dto.source, user);
  }

  @Put('specialists')
  @RequirePermissions('beds.update')
  specialists(@CurrentUser() user: AuthUser, @Body() dto: SetSpecialistsDto) {
    return this.capacity.setSpecialists(user.facilityCode, dto.specialists, user);
  }

  @Put('secondary')
  @RequirePermissions('beds.update')
  secondary(@CurrentUser() user: AuthUser, @Body() dto: SetSecondaryMarkerDto) {
    return this.capacity.setSecondaryMarker(user.facilityCode, dto.name, dto.available, user);
  }
}
