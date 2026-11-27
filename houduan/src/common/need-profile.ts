import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** 客户端按这个 code 弹「去完成资料收集」（HTTP 接口只有文字提示，WebSocket 的 error 帧会带上 code） */
export const NEED_PROFILE_CODE = 'need_profile';

/** 没完成资料收集（2026-11-27 起发消息、通话不再查这个，现在没有地方抛它；code 和 im.gateway 里的处理留着，以后要用再接） */
export class NeedProfileException extends ForbiddenException {
  constructor(message = '完成资料收集后才能发起聊天') {
    super(message);
  }
}

/** 是否已完成资料收集（相亲画像已确认） */
export async function profileDone(prisma: PrismaService, userId: bigint): Promise<boolean> {
  const row = await prisma.profile.findUnique({ where: { userId }, select: { confirmedAt: true } });
  return !!row?.confirmedAt;
}
