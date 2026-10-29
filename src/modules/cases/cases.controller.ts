import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireOnDuty, RequirePermissions } from '../../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RosterGuard } from '../auth/guards/roster.guard';
import { CasesService, toActor } from './cases.service';
import { AdvanceStageDto, CreateCaseDto, DeclineDto, ListCasesDto, OptionalNoteDto, ReasonNoteDto, ReceivedDto, SendCaseDto } from './dto/cases.dto';
import { ReferralEngine } from './referral-engine.service';

@Controller('cases')
@UseGuards(JwtAuthGuard, PermissionsGuard, RosterGuard)
export class CasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly engine: ReferralEngine,
  ) {}

  @Post()
  @RequirePermissions('referral.send')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCaseDto) {
    return this.cases.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListCasesDto) {
    if (q.direction === 'incoming') return this.cases.listIncoming(user.facilityCode);
    if (q.direction === 'accepted') return this.cases.listAccepted(user.facilityCode);
    return this.cases.listOutgoing(user.facilityCode);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.get(id, user);
  }

  @Get(':id/events')
  events(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.timeline(id, user);
  }

  @Get(':id/handover')
  handover(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.handover(id, user);
  }

  @Post(':id/handover/received')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('handover.accept')
  received(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReceivedDto) {
    return this.cases.confirmReceived(id, user, dto.clinicianName);
  }

  @Get(':id/matches')
  @RequirePermissions('referral.send')
  matches(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.matches(id, user);
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('referral.send')
  @RequireOnDuty('referral.send')
  send(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SendCaseDto) {
    return this.engine.send(id, toActor(user), dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('referral.send')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonNoteDto) {
    return this.cases.cancel(id, user, dto.reason);
  }

  @Post(':id/cancel-acceptance')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('referral.accept')
  cancelAcceptance(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonNoteDto) {
    return this.engine.cancelAcceptance(id, toActor(user), dto.reason);
  }

  @Post(':id/stage')
  @HttpCode(HttpStatus.OK)
  advance(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AdvanceStageDto) {
    return this.cases.advance(id, user, dto.to);
  }
}

/** The receiving side: respond to referral requests. */
@Controller('offers')
@UseGuards(JwtAuthGuard, PermissionsGuard, RosterGuard)
export class OffersController {
  constructor(
    private readonly cases: CasesService,
    private readonly engine: ReferralEngine,
  ) {}

  @Get('incoming')
  @RequirePermissions('referral.incoming')
  incoming(@CurrentUser() user: AuthUser) {
    return this.cases.listIncoming(user.facilityCode);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('referral.accept')
  @RequireOnDuty('referral.accept')
  accept(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.engine.accept(id, toActor(user), user.permissions.includes('referral.finalApprove'));
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('referral.accept')
  decline(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DeclineDto) {
    return this.engine.decline(id, toActor(user), dto.reason, dto.note);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('referral.finalApprove')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.engine.approve(id, toActor(user));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('referral.finalApprove')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: OptionalNoteDto) {
    return this.engine.rejectApproval(id, toActor(user), dto.note);
  }
}
