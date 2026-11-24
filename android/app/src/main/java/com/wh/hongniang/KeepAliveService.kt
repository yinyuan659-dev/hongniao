package com.wh.hongniang

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import com.wh.hongniang.i18n.t
import com.wh.hongniang.net.WsClient

/**
 * 保活服务：前台服务 + WakeLock + 静音音频 + 定时检查 IM 长连接。
 * 保证熄屏/后台时仍能收到消息与来电邀请。
 */
class KeepAliveService : Service() {

    companion object {
        private const val CHANNEL_ID = "peiwan_keepalive"
        private const val WS_CHECK_INTERVAL = 20_000L

        /** 守护闹钟的 Action（KeepAliveReceiver 收到后确保前台服务在跑、WS 在连） */
        const val ACTION_GUARD = "com.wh.hongniang.action.KEEPALIVE_GUARD"
        private const val GUARD_REQUEST = 101
        /** 正常巡检间隔；Doze 下系统会自动拉长（setAndAllowWhileIdle 约 9 分钟一次），作为进程被杀后的兜底 */
        private const val GUARD_INTERVAL = 60_000L

        /** 只有登录过（本地存了 token）才需要保活，避免没登录也弹常驻通知 */
        private fun loggedIn(context: Context): Boolean =
            !context.getSharedPreferences("peiwan", Context.MODE_PRIVATE).getString("token", null).isNullOrEmpty()

        /** 启动前台服务：未登录不启动；Android 12+ 后台启动被拒时吞掉异常（守护闹钟会再试） */
        fun start(context: Context) {
            if (!loggedIn(context)) return
            val intent = Intent(context, KeepAliveService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (_: Exception) {
                // 例如 Android 12+ 的 ForegroundServiceStartNotAllowedException：等下一次守护闹钟再拉
            }
        }

        /**
         * 预约一次「守护」闹钟：到点由 KeepAliveReceiver 确保前台服务在跑、WS 在连。
         * 用 setAndAllowWhileIdle（免精确闹钟权限，Doze 下也能触发），闹钟在进程被杀后仍然有效，
         * 是「被系统压掉后自动恢复」的主要兜底（重启设备后由开机广播重新预约）。
         */
        fun scheduleGuard(context: Context, delayMs: Long = GUARD_INTERVAL) {
            if (!loggedIn(context)) return
            val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
            val intent = Intent(context, KeepAliveReceiver::class.java).setAction(ACTION_GUARD)
            val pi = PendingIntent.getBroadcast(
                context, GUARD_REQUEST, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val at = SystemClock.elapsedRealtime() + delayMs
            runCatching { am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi) }
        }
    }

    private var audioTrack: AudioTrack? = null
    private var silenceThread: Thread? = null
    @Volatile private var running = false
    private var wakeLock: PowerManager.WakeLock? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        acquireWakeLock()
        startForeground(1, createNotification())
        running = true
        startSilentAudio()
        mainHandler.postDelayed(wsCheck, WS_CHECK_INTERVAL)
        // 预约守护闹钟：进程被系统压掉后靠它把服务拉回来
        scheduleGuard(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!running) { running = true; startSilentAudio() }
        return START_STICKY
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "peiwan::KeepAlive").apply { acquire() }
    }

    /** 定时检查 IM 连接：connect() 幂等，断了会自动重建 */
    private val wsCheck = object : Runnable {
        override fun run() {
            if (!running) return
            runCatching { WsClient.connect() }
            mainHandler.postDelayed(this, WS_CHECK_INTERVAL)
        }
    }

    /** 静音音频：防止部分厂商系统深度休眠时冻结进程网络 */
    private fun startSilentAudio() {
        val sampleRate = 16000
        val bufSize = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        audioTrack = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(bufSize)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        audioTrack?.setVolume(0f)
        audioTrack?.play()
        silenceThread = Thread({
            val silence = ByteArray(bufSize)
            while (running) {
                try { audioTrack?.write(silence, 0, silence.size) } catch (_: Exception) { break }
            }
        }, "SilentAudio").apply { isDaemon = true; start() }
    }

    private fun createNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, t("notify.keepAliveChannel"), NotificationManager.IMPORTANCE_LOW).apply {
                    setShowBadge(false)
                },
            )
        }
        val pending = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(t("notify.keepAliveTitle"))
            .setContentText(t("notify.keepAliveText"))
            .setOngoing(true)
            .setContentIntent(pending)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onDestroy() {
        running = false
        mainHandler.removeCallbacks(wsCheck)
        try { audioTrack?.stop(); audioTrack?.release() } catch (_: Exception) {}
        audioTrack = null
        silenceThread?.interrupt()
        silenceThread = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
        // 被系统回收后自拉起：立即重启 + 预约一个短守护闹钟兜底（直接重启被拒时靠闹钟再拉）
        runCatching { start(this) }
        scheduleGuard(this, 2_000L)
    }
}
