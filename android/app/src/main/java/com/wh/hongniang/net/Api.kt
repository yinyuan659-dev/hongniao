package com.wh.hongniang.net

import android.annotation.SuppressLint
import android.content.Context
import android.provider.Settings
import com.wh.hongniang.i18n.t
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.buffer
import okio.source
import java.util.concurrent.TimeUnit

@Serializable
data class ApiResp(
    val code: Int, val msg: String, val data: JsonElement? = null,
    /** 服务端给的原因代码（例如 AI 费用的 no_balance / key_invalid），页面按它决定弹哪张提示 */
    val reason: String? = null,
)

@Serializable
data class UserProfile(
    val id: String,
    val shortId: String? = null,
    val nickname: String,
    val avatar: String = "",
    val gender: Int,
    val age: Int = 0,
    val cityCode: String = "",
    val cityName: String = "",
    val signature: String = "",
    /** 视频见面开关（默认关；双方都打开才能互相发起视频通话） */
    val allowVideo: Boolean = false,
    /** 是否已完成资料收集（只有 /user/me 返回） */
    val profileDone: Boolean = false,
    /** AI 深聊：none 没聊过 | chatting 聊到一半 | draft 画像等确认 | done 已确认（只有 /user/me 返回） */
    val deepStatus: String = "none",
    val realname: Boolean = false,
    val realNameMasked: String = "",
    val following: Int = 0,
    val fans: Int = 0,
    /** 照片墙（最多 8 张） */
    val albums: List<AlbumItem> = emptyList(),
)

/** 注册归因到的邀请人（通过 TA 的专属邀请页下载安装）；仅异性时返回，客户端据此直接打开 TA 主页 */
@Serializable
data class InviterBrief(val id: String, val nickname: String = "", val avatar: String = "", val gender: Int = 0)

/** 通过刷脸新挂到这个账号上的一台设备（给其它设备的提醒里用）。kind：android | ios | web；label：网页的浏览器名 */
@Serializable
data class NewDevice(val id: String = "", val kind: String = "", val label: String = "", val at: String = "") {
    /** 设备列表、提醒里怎么称呼它 */
    val name: String get() = when (kind) {
        "android" -> "安卓手机"
        "ios" -> "iPhone"
        else -> if (label.isEmpty()) "网页" else "网页（$label）"
    }
}

/**
 * did：这台设备在服务器「登录设备」表里的编号（推送里靠它认出说的是不是本机）。
 * newDevices：上次用这台设备之后，通过刷脸新挂到这个账号上的其它设备，提醒一次。
 */
@Serializable
data class EnterResp(
    val registered: Boolean, val token: String? = null, val user: UserProfile? = null, val inviter: InviterBrief? = null,
    val did: String? = null, val newDevices: List<NewDevice> = emptyList(),
)

@Serializable
data class AppModuleItem(val id: Int, val name: String, val icon: String, val type: String, val entry: String)

class ApiException(val code: Int, message: String, val reason: String? = null) : Exception(message)

/** 包装 RequestBody 统计写出字节数，回调上传进度（主线程、按百分比节流） */
class ProgressRequestBody(
    private val delegate: okhttp3.RequestBody,
    private val onProgress: (Float) -> Unit,
) : okhttp3.RequestBody() {
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

    override fun contentType() = delegate.contentType()
    override fun contentLength() = delegate.contentLength()
    override fun writeTo(sink: okio.BufferedSink) {
        val total = contentLength().coerceAtLeast(1)
        var written = 0L
        var lastPercent = -1
        val counting = object : okio.ForwardingSink(sink) {
            override fun write(source: okio.Buffer, byteCount: Long) {
                super.write(source, byteCount)
                // 每写一段立刻刷出，保证统计贴近真实网络进度
                sink.flush()
                written += byteCount
                val percent = (written * 100 / total).toInt()
                if (percent != lastPercent) {
                    lastPercent = percent
                    val p = (percent / 100f).coerceIn(0f, 1f)
                    mainHandler.post { onProgress(p) }
                }
            }
        }
        val buffered = counting.buffer()
        delegate.writeTo(buffered)
        buffered.flush()
    }
}

/** 聊天文件上限，和后端 FILE_MAX_SIZE 一致：再大 Cloudflare 免费版直接回 413 */
const val FILE_MAX_SIZE = 100_000_000L

/** POST /upload/file 的返回，原样作为 file 消息的 content */
@Serializable
data class ChatFileResp(val url: String, val name: String, val size: Long, val mime: String)

/** 从 content:// 边读边写，100MB 的文件不进内存 */
private class UriRequestBody(private val ctx: Context, private val uri: android.net.Uri, private val size: Long, private val mime: String) : okhttp3.RequestBody() {
    override fun contentType() = mime.toMediaTypeOrNull() ?: "application/octet-stream".toMediaType()
    override fun contentLength() = size
    override fun writeTo(sink: okio.BufferedSink) {
        val input = ctx.contentResolver.openInputStream(uri) ?: throw java.io.IOException("cannot open $uri")
        input.source().use { sink.writeAll(it) }
    }
}

object Api {
    // 测试环境（阿里云杭州）。域名备案前只能用 IP + HTTP；备案后换成 https://域名，正式包不能留这个地址。
    const val BASE_URL = "http://120.55.59.158"

    val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        // 服务端按这个语言返回报错 / 配置项文字
        .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("Accept-Language", com.wh.hongniang.i18n.I18n.lang).build()) }
        .build()
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private lateinit var prefs: android.content.SharedPreferences
    private var deviceIdCached: String? = null

    fun init(context: Context) {
        prefs = context.getSharedPreferences("peiwan", Context.MODE_PRIVATE)
        deviceIdCached = resolveDeviceId(context)
    }

    /** 一机一号：ANDROID_ID 同签名重装不变，凭此恢复账号 */
    @SuppressLint("HardwareIds")
    private fun resolveDeviceId(context: Context): String {
        val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        return "and_" + (androidId ?: java.util.UUID.randomUUID().toString().replace("-", ""))
    }

    val deviceId: String get() = deviceIdCached!!

    var token: String?
        get() = prefs.getString("token", null)
        set(value) = prefs.edit().putString("token", value).apply()

    /** 这台设备在服务器「登录设备」表里的编号（进入 / 注册 / 刷脸找回 / 并号时服务器给的） */
    var did: String?
        get() = prefs.getString("did", null)
        set(value) = prefs.edit().putString("did", value).apply()

    /** 男方视频通话默认是否开启自己画面（默认关闭，仅男方"我的"页可设置） */
    var camDefaultOn: Boolean
        get() = prefs.getBoolean("cam_default_on", false)
        set(value) = prefs.edit().putBoolean("cam_default_on", value).apply()

    /** 注册头像上传（免登录），返回可访问的相对 URL */
    suspend fun uploadAvatar(bytes: ByteArray, mime: String = "image/jpeg"): String =
        withContext(Dispatchers.IO) {
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", "avatar.jpg", bytes.toRequestBody(mime.toMediaType()))
                .build()
            val req = Request.Builder().url("$BASE_URL/api/upload/avatar").post(body).build()
            val resp = client.newCall(req).execute()
            val text = resp.body?.string() ?: throw ApiException(-1, t("common.networkError"))
            val parsed = json.decodeFromString<ApiResp>(text)
            if (parsed.code != 0) throw ApiException(parsed.code, parsed.msg)
            (parsed.data as kotlinx.serialization.json.JsonObject)["url"]!!
                .let { (it as kotlinx.serialization.json.JsonPrimitive).content }
        }

    /** 登录后上传 kind=image|video|audio，返回相对 URL；onProgress 回调 0~1 */
    suspend fun upload(kind: String, bytes: ByteArray, filename: String, mime: String, onProgress: ((Float) -> Unit)? = null): String =
        withContext(Dispatchers.IO) {
            val raw = bytes.toRequestBody(mime.toMediaType())
            val fileBody = if (onProgress != null) ProgressRequestBody(raw, onProgress) else raw
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", filename, fileBody)
                .build()
            val builder = Request.Builder().url("$BASE_URL/api/upload/$kind").post(body)
            token?.let { builder.header("Authorization", "Bearer $it") }
            val resp = client.newCall(builder.build()).execute()
            val text = resp.body?.string() ?: throw ApiException(-1, t("common.networkError"))
            val parsed = json.decodeFromString<ApiResp>(text)
            if (parsed.code != 0) throw ApiException(parsed.code, parsed.msg)
            (parsed.data as kotlinx.serialization.json.JsonObject)["url"]!!
                .let { (it as kotlinx.serialization.json.JsonPrimitive).content }
        }

    /** 大文件上传：单次写 / 等响应都放宽，弱网下 100MB 不至于半路超时 */
    private val uploadClient by lazy { client.newBuilder().writeTimeout(60, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).build() }

    /** 聊天里发任意文件（size 是 OpenableColumns 查到的字节数），onProgress 回调 0~1 */
    suspend fun uploadChatFile(ctx: Context, uri: android.net.Uri, name: String, size: Long, mime: String, onProgress: ((Float) -> Unit)? = null): ChatFileResp =
        json.decodeFromJsonElement(ChatFileResp.serializer(), postUri("file", ctx, uri, name, size, mime, onProgress))

    /** 同 upload(kind=video|audio)，但从 content:// 边读边传，返回相对 URL */
    suspend fun uploadUri(kind: String, ctx: Context, uri: android.net.Uri, name: String, size: Long, mime: String, onProgress: ((Float) -> Unit)? = null): String =
        (postUri(kind, ctx, uri, name, size, mime, onProgress) as JsonObject)["url"]!!
            .let { (it as kotlinx.serialization.json.JsonPrimitive).content }

    private suspend fun postUri(path: String, ctx: Context, uri: android.net.Uri, name: String, size: Long, mime: String, onProgress: ((Float) -> Unit)?): JsonElement =
        withContext(Dispatchers.IO) {
            val raw = UriRequestBody(ctx, uri, size, mime)
            val fileBody = if (onProgress != null) ProgressRequestBody(raw, onProgress) else raw
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", name, fileBody)
                .build()
            val builder = Request.Builder().url("$BASE_URL/api/upload/$path").post(body)
            token?.let { builder.header("Authorization", "Bearer $it") }
            uploadClient.newCall(builder.build()).execute().use { resp ->
                // Cloudflare / nginx 拦下超大包体时回的是 HTML 413
                if (resp.code == 413) throw ApiException(413, t("chat.file.tooLarge", "name" to name))
                val text = resp.body?.string() ?: throw ApiException(-1, t("common.networkError"))
                val parsed = json.decodeFromString<ApiResp>(text)
                if (parsed.code != 0) throw ApiException(parsed.code, parsed.msg)
                parsed.data!!
            }
        }

    /** 便捷：GET 并解析为列表 */
    suspend inline fun <reified T> getList(path: String): List<T> {
        val data = request(path) ?: return emptyList()
        return json.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(kotlinx.serialization.serializer<T>()), data)
    }

    suspend inline fun <reified T> getObj(path: String): T {
        val data = request(path)!!
        return json.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), data)
    }

    /** 相对资源路径转完整 URL */
    fun fullUrl(path: String): String =
        if (path.startsWith("http") || path.isEmpty() || path.startsWith("content:") || path.startsWith("file:")) path else BASE_URL + path

    suspend fun request(path: String, method: String = "GET", body: JsonObject? = null): JsonElement? =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url("$BASE_URL/api$path")
            token?.let { builder.header("Authorization", "Bearer $it") }
            when (method) {
                "GET" -> builder.get()
                else -> builder.method(method, (body?.toString() ?: "{}").toRequestBody(jsonMedia))
            }
            val resp = client.newCall(builder.build()).execute()
            val text = resp.body?.string() ?: throw ApiException(-1, t("common.networkError"))
            val parsed = json.decodeFromString<ApiResp>(text)
            if (parsed.code != 0) throw ApiException(parsed.code, parsed.msg, parsed.reason)
            parsed.data
        }
}
