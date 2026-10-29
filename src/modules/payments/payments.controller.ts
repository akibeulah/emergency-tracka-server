import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';
import { Request } from 'express';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaymentOrchestrator } from './payment-orchestrator.service';

class InitPaymentDto {
  /** The relative's email, for Paystack's receipt. The OTP-bound public link (15-4) is not wired yet. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  payerEmail: string;
}

@Controller()
export class PaymentsController {
  constructor(private readonly orchestrator: PaymentOrchestrator) {}

  @Post('cases/:id/payments')
  @UseGuards(JwtAuthGuard)
  initialize(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: InitPaymentDto) {
    return this.orchestrator.initialize(id, user, dto.payerEmail);
  }

  /** Called after the gateway redirect. Asks the gateway; never trusts the caller. */
  @Get('payments/verify/:reference')
  verify(@Param('reference') reference: string) {
    return this.orchestrator.verify(reference);
  }

  /** Unauthenticated by design: the gateway's signature is the authentication. */
  @Post('payments/webhook/:gatewayType')
  @HttpCode(HttpStatus.OK)
  webhook(
    @Param('gatewayType') gatewayType: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    return this.orchestrator.handleWebhook(gatewayType, req.rawBody, headers);
  }
}
