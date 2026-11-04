import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { EnquiryListDto, EnquiryStatusDto, SubmitEnquiryDto } from './dto/enquiries.dto';
import { EnquiriesService } from './enquiries.service';

/** The public website's contact form. No sign-in; limited per IP. */
@Controller('enquiries')
export class EnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  submit(@Body() dto: SubmitEnquiryDto, @Ip() ip: string) {
    return this.enquiries.submit(dto, ip);
  }
}

/** The enquiries inbox in the platform admin console. */
@Controller('admin/enquiries')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('platform.admin')
export class AdminEnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Get()
  list(@Query() query: EnquiryListDto) {
    return this.enquiries.list(query.status);
  }

  @Patch(':id')
  setStatus(@Param('id') id: string, @Body() dto: EnquiryStatusDto, @CurrentUser() admin: AuthUser) {
    return this.enquiries.setStatus(id, dto.status, admin);
  }
}
