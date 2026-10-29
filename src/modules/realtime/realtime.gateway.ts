import { Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';
import { DomainEventPayload, DomainEvents } from '../../common/events';
import { REDIS } from '../../config/redis.module';
import { AccessTokenClaims, claimsToUser } from '../auth/jwt.strategy';
import { activeSessionKey } from '../auth/sessions.service';

const RELAYED = new Set<string>(Object.values(DomainEvents));
export const CAPACITY_ROOM = 'capacity';
export const facilityRoom = (code: string) => `facility:${code}`;

/**
 * Relays in-process domain events to socket rooms. A client authenticates in
 * the handshake (`auth: { token }`) and is joined to its facility's room.
 * Single instance for the pilot; scaling out is the Redis adapter, one line.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly relay = (event: string | string[], payload: DomainEventPayload) => this.forward(String(event), payload);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly jwt: JwtService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit() {
    this.emitter.onAny(this.relay);
  }

  onModuleDestroy() {
    this.emitter.offAny(this.relay);
  }

  async handleConnection(socket: Socket) {
    try {
      const raw =
        (socket.handshake.auth?.token as string | undefined) ??
        socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!raw) throw new Error('missing token');
      const claims = this.jwt.verify<AccessTokenClaims>(raw);
      if (!(await this.redis.exists(activeSessionKey(claims.sid)))) throw new Error('session ended');

      const user = claimsToUser(claims);
      socket.data.user = user;
      await socket.join([facilityRoom(user.facilityCode), `user:${user.userId}`, CAPACITY_ROOM]);
      socket.emit('ready', { facilityCode: user.facilityCode });
    } catch (err) {
      socket.emit('auth_error', { message: 'Sign in again to receive live updates.' });
      socket.disconnect(true);
      this.logger.debug(`socket refused: ${(err as Error).message}`);
    }
  }

  private forward(event: string, payload: DomainEventPayload) {
    if (!RELAYED.has(event) || !this.server) return;
    try {
      if (event === DomainEvents.CapacityUpdated) {
        this.server.to(CAPACITY_ROOM).emit(event, payload);
        return;
      }
      const rooms = (payload.facilities ?? []).map(facilityRoom);
      if (rooms.length) this.server.to(rooms).emit(event, payload);
    } catch (err) {
      // A socket hiccup must never fail the write that triggered it.
      this.logger.error(`relay ${event} failed: ${(err as Error).message}`);
    }
  }
}
