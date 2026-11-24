import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from '../redis/redis.service';
import { deviceDeadKey, userDeadKey } from './device.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      throw new UnauthorizedException('未登录');
    }
    let sub: string;
    let did: string;
    try {
      const payload = this.jwt.verify(token);
      sub = String(payload.sub);
      // did：这次登录用的是设备表里的哪一行（2026-11 之前发的令牌没有）
      did = payload.did ? String(payload.did) : '';
      req.userId = BigInt(sub);
      if (did) req.deviceRowId = BigInt(did);
    } catch {
      throw new UnauthorizedException('登录已过期');
    }
    // 这台设备被移除了、或者这个号并号后作废了：令牌还没过期也不认
    if (await this.dead(sub, did)) throw new UnauthorizedException('这台设备已退出登录');
    return true;
  }

  private async dead(sub: string, did: string): Promise<boolean> {
    try {
      const keys = did ? [userDeadKey(sub), deviceDeadKey(did)] : [userDeadKey(sub)];
      return (await this.redis.client.exists(...keys)) > 0;
    } catch {
      // Redis 一时连不上：放行，不因为这个把所有人踢下线
      return false;
    }
  }
}
