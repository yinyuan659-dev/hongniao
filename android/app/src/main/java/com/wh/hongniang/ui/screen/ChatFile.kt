package com.wh.hongniang.ui.screen

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.hongniang.i18n.t
import com.wh.hongniang.net.Api
import com.wh.hongniang.net.WsClient
import com.wh.hongniang.ui.theme.*
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.util.Locale

/** 文件消息内容 { url, name, size, mime }；本地刚选、还没传完的没有 url */
data class ChatFileInfo(val url: String?, val name: String, val size: Long, val mime: String?)

fun parseChatFile(content: String): ChatFileInfo {
    val o = runCatching { WsClient.json.parseToJsonElement(content).jsonObject }.getOrNull()
    return ChatFileInfo(
        url = o?.get("url")?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() },
        name = o?.get("name")?.jsonPrimitive?.contentOrNull.orEmpty(),
        size = o?.get("size")?.jsonPrimitive?.longOrNull ?: 0L,
        mime = o?.get("mime")?.jsonPrimitive?.contentOrNull,
    )
}

enum class PickKind { Image, Video, Audio, File }

private val IMAGE_MIMES = setOf("image/jpeg", "image/png", "image/webp", "image/gif")
private val VIDEO_MIMES = setOf("video/mp4", "video/quicktime")
private val AUDIO_MIMES = setOf("audio/mpeg", "audio/mp4", "audio/aac", "audio/m4a", "audio/x-m4a", "audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/3gpp")
private const val AUDIO_MAX = 10L * 1024 * 1024

/**
 * 「文件」里选的按什么发：和后端 upload.service ALLOWED 一致的按图片 / 视频 / 语音发，其余（含超过 10MB 的音频）按文件发。
 * HEIC 发图时转成 JPEG，BitmapFactory 要 Android 9 才能解。
 */
fun pickKind(mime: String, size: Long): PickKind = when {
    mime in IMAGE_MIMES || (Build.VERSION.SDK_INT >= 28 && (mime == "image/heic" || mime == "image/heif")) -> PickKind.Image
    mime in VIDEO_MIMES -> PickKind.Video
    mime in AUDIO_MIMES && size in 1..AUDIO_MAX -> PickKind.Audio
    else -> PickKind.File
}

/** 「文件」里选中的一个：名字、字节数（查不到为 -1）、类型、按什么发、音频时长（秒） */
data class PickedFile(val uri: Uri, val name: String, val size: Long, val mime: String, val kind: PickKind, val duration: Int)

/** 查名字 / 大小 / 类型，定按什么发；音频读不出时长就按文件发。要在 IO 线程调 */
fun inspectPicked(ctx: Context, uris: List<Uri>): List<PickedFile> = uris.map { uri ->
    val (name, size, mime) = queryFileMeta(ctx, uri)
    val kind = pickKind(mime, size)
    val dur = if (kind == PickKind.Audio) audioDurationSec(ctx, uri) else 0
    PickedFile(uri, name, size, mime, if (kind == PickKind.Audio && dur == 0) PickKind.File else kind, dur)
}

/** 后端只认 audio/wav */
fun uploadMime(mime: String) = if (mime == "audio/x-wav") "audio/wav" else mime

/** 音频时长（秒，四舍五入）；读不出来返回 0 */
fun audioDurationSec(ctx: Context, uri: Uri): Int = runCatching {
    val r = MediaMetadataRetriever()
    try {
        r.setDataSource(ctx, uri)
        ((r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) + 500) / 1000
    } finally {
        r.release()
    }
}.getOrDefault(0L).toInt()

/** 交给系统播放器 */
fun openVideo(ctx: Context, url: String) {
    val u = Uri.parse(Api.fullUrl(url))
    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(u, "video/*")) }
        .onFailure { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, u)) } }
}

/** 聊天里的视频：黑底 + 播放键，点了用系统播放器放；上传中盖进度，失败点了重试 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatVideoTile(url: String, state: UploadState?, sending: Boolean, onRetry: () -> Unit, onLongPress: () -> Unit) {
    val ctx = LocalContext.current
    val ready = url.isNotEmpty() && state == null
    Box(
        Modifier.size(220.dp, 140.dp).clip(RoundedCornerShape(10.dp)).background(Color(0xFF111111))
            .combinedClickable(onLongClick = onLongPress) { if (ready) openVideo(ctx, url) },
        contentAlignment = Alignment.Center,
    ) {
        if (ready) {
            Box(Modifier.size(48.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.25f)), contentAlignment = Alignment.Center) {
                Text("▶", color = Color.White, fontSize = 20.sp)
            }
        }
        UploadOverlay(state, sending, onRetry, Modifier.matchParentSize())
    }
}

/** 按十进制算，和「100MB」上限的说法一致 */
fun fmtFileSize(n: Long): String = when {
    n < 1000 -> "$n B"
    n < 1_000_000 -> String.format(Locale.US, if (n < 10_000) "%.1f KB" else "%.0f KB", n / 1e3)
    n < 1_000_000_000 -> String.format(Locale.US, if (n < 10_000_000) "%.1f MB" else "%.0f MB", n / 1e6)
    else -> String.format(Locale.US, "%.1f GB", n / 1e9)
}

/** 会话列表 / 引用条里的一行：label 是「[文件]」 */
fun fileSnippet(content: String, label: String): String {
    val name = parseChatFile(content).name
    return if (name.isNotEmpty()) "$label $name" else label
}

/** 选中的文件：显示名、字节数（查不到为 -1）、类型 */
fun queryFileMeta(ctx: Context, uri: Uri): Triple<String, Long, String> {
    var name = ""
    var size = -1L
    runCatching {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val iName = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val iSize = c.getColumnIndex(OpenableColumns.SIZE)
                if (iName >= 0) name = c.getString(iName).orEmpty()
                if (iSize >= 0 && !c.isNull(iSize)) size = c.getLong(iSize)
            }
        }
    }
    if (name.isEmpty()) name = uri.lastPathSegment?.substringAfterLast('/').orEmpty().ifEmpty { "file" }
    return Triple(name, size, ctx.contentResolver.getType(uri) ?: "application/octet-stream")
}

/** 系统下载管理器存进「下载」目录，完成后通知栏点开；Android 9 及以下没有免权限的公共目录，交给浏览器下载 */
fun downloadChatFile(ctx: Context, f: ChatFileInfo) {
    val full = Api.fullUrl(f.url ?: return)
    if (Build.VERSION.SDK_INT < 29) {
        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(full))) }
        return
    }
    val ok = runCatching {
        val name = f.name.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").ifBlank { "file" }
        val ext = name.substringAfterLast('.', "").lowercase()
        val mime = f.mime?.takeIf { it != "application/octet-stream" } ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        val req = DownloadManager.Request(Uri.parse(full))
            .setTitle(name)
            .setMimeType(mime)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        (ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
    }.isSuccess
    Toast.makeText(ctx, t(if (ok) "chat.file.downloadStarted" else "chat.file.downloadFailed"), Toast.LENGTH_SHORT).show()
}

private val EXT_COLORS = listOf(
    Regex("^pdf$") to Color(0xFFE5484D),
    Regex("^(docx?|pages|rtf|txt|md)$") to Color(0xFF2F6FED),
    Regex("^(xlsx?|csv|numbers)$") to Color(0xFF1F9D55),
    Regex("^(pptx?|key)$") to Color(0xFFE8730C),
    Regex("^(zip|rar|7z|gz|tar|bz2|xz)$") to Color(0xFF8E6BD8),
    Regex("^(apk|ipa|exe|dmg|msi)$") to Color(0xFF13A8A8),
    Regex("^(mp3|m4a|wav|flac|aac|ogg|mp4|mov|mkv|avi|webm)$") to Color(0xFFD6409F),
)

/** 文件气泡：上传中显示进度条，失败点了重试，传完点了下载；长按弹消息菜单 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FileBubble(f: ChatFileInfo, state: UploadState?, bg: Color, shape: Shape, onRetry: () -> Unit, onLongPress: () -> Unit, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val ext = f.name.substringAfterLast('.', "").lowercase().takeIf { it.length in 1..5 && it.all(Char::isLetterOrDigit) }.orEmpty()
    val color = EXT_COLORS.firstOrNull { it.first.matches(ext) }?.second ?: Color(0xFF6B7A99)
    val failed = state?.failed == true
    val p = if (failed) null else state?.progress
    Row(
        modifier.widthIn(min = 200.dp, max = 240.dp).clip(shape).background(bg)
            .combinedClickable(onLongClick = onLongPress) {
                if (failed) onRetry() else if (state == null && f.url != null) downloadChatFile(ctx, f)
            }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(42.dp).clip(RoundedCornerShape(10.dp)).background(color), contentAlignment = Alignment.Center) {
            Text(ext.uppercase().ifEmpty { "FILE" }, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(f.name.ifEmpty { t("chat.preview.file") }, color = TextMain, fontSize = 14.sp, lineHeight = 19.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(3.dp))
            when {
                failed -> Text(t("chat.upload.retry"), color = Danger, fontSize = 12.sp)
                p != null -> Text("${fmtFileSize((f.size * p).toLong())} / ${fmtFileSize(f.size)}", color = TextSub, fontSize = 12.sp)
                else -> Text(fmtFileSize(f.size), color = TextSub, fontSize = 12.sp)
            }
            if (p != null) {
                Spacer(Modifier.height(4.dp))
                Box(Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)).background(Color.Black.copy(alpha = 0.08f))) {
                    Box(Modifier.fillMaxWidth(p.coerceIn(0f, 1f)).fillMaxHeight().background(Accent))
                }
            }
        }
    }
}
