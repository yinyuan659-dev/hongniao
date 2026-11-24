package com.wh.hongniang

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 保活广播接收器（诚实保活，不伪装、不隐藏、不碰系统设置）：
 * - 守护闹钟（KeepAliveService.ACTION_GUARD）到点：确保前台服务在跑，并预约下一次。
 * - 开机 / 应用更新后：重新把服务和守护闹钟拉起来（闹钟在关机后会清空，开机需要重排）。
 *
 * 只有本地存了 token（登录过）才会拉起，未登录不弹常驻通知。
 * 启动前台服务的权限判断和异常吞吐都在 KeepAliveService.start() 里。
 */
class KeepAliveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        // 开机后 Api 可能还没 init，这里只读 SharedPreferences、不依赖 Api 单例
        KeepAliveService.start(context)
        // 守护闹钟是一次性的，每次触发后预约下一次；开机也顺带排一次
        KeepAliveService.scheduleGuard(context)
    }
}
