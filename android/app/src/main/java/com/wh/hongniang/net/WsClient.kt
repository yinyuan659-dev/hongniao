package com.wh.hongniang.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.TimeUnit

@Serializable
data class MessagePayload(
    val id: String,
    val conversationId: String,
    val senderId: String,
    val senderNickname: String = "",
    val senderAvatar: String = "",
    val receiverId: String? = null,
    val type: String,
    val content: String,
    val createdAt: String,
    val replyTo: ReplyPreview? = null,
    val fwdFrom: String? = null,
    val reactions: List<MsgReaction> = emptyList(),
    /** 1 单聊 2 群聊；群聊的消息带 groupId、groupName */
    val convType: Int = 1,
    val groupId: String? = null,
    val groupName: String? = null,
)

/** 被回复的消息预览：文字取前 100 字、图片是 url；deleted=原消息已删除 */
@Serializable
data class ReplyPreview(
    val id: String,
    val senderId: String = "",
    val senderNickname: String = "",
    val type: String = "",
    val content: String = "",
    val deleted: Boolean = false,
)

@Serializable
data class MsgReaction(val emoji: String, val count: Int, val userIds: List<String> = emptyList())

/** IM WebSocket：自动重连 + 心跳 + 帧分发（协议见后端 im.types.ts） */
object WsClient {
    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    /** OkHttp 回调在后台线程，统一切到主线程分发，listener 里可直接做 UI 操作（如 Toast） */
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

    private var ws: WebSocket? = null
    private var manualClose = false
    /**
     * 连接断过（或者没连上）：下一次连上时给各页面发一个 { op: "ws_reopen" }（不是服务器的帧），
     * 页面收到就补拉一次——断线那段时间的消息和群的变化没收到。数据平时都靠推送，不轮询。
     */
    @Volatile private var dropped = false
    private val listeners = CopyOnWriteArraySet<(JsonObject) -> Unit>()
    val json = Json { ignoreUnknownKeys = true }

    fun connect() {
        val token = Api.token ?: return
        if (ws != null) return
        manualClose = false
        val url = Api.BASE_URL.replaceFirst("http", "ws") + "/ws?token=$token&lang=${com.wh.hongniang.i18n.I18n.lang}"
        ws = client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (!dropped) return
                    dropped = false
                    val frame = buildJsonObject { put("op", "ws_reopen") }
                    mainHandler.post { listeners.forEach { l -> runCatching { l(frame) } } }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = try {
                        json.parseToJsonElement(text) as? JsonObject
                    } catch (_: Exception) {
                        null
                    } ?: return
                    mainHandler.post { listeners.forEach { l -> runCatching { l(frame) } } }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    ws = null
                    if (!manualClose) { dropped = true; reconnectLater() }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    ws = null
                    if (!manualClose) { dropped = true; reconnectLater() }
                }
            },
        )
    }

    private fun reconnectLater() {
        Thread {
            Thread.sleep(3000)
            connect()
        }.start()
    }

    fun close() {
        manualClose = true
        dropped = false
        ws?.close(1000, null)
        ws = null
    }

    fun addListener(listener: (JsonObject) -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    /** 发消息，返回 tempId。convType 1 = 单聊（targetId 是对方的用户 id），2 = 群聊（targetId 是群 id） */
    fun send(targetId: String, msgType: String, content: String, replyToId: String? = null, convType: Int = 1): String {
        val tempId = "t_${System.currentTimeMillis()}_${(1000..9999).random()}"
        val frame = buildJsonObject {
            put("op", "send")
            put("tempId", tempId)
            put("convType", convType)
            put("targetId", targetId)
            put("msgType", msgType)
            put("content", content)
            if (replyToId != null) put("replyToId", replyToId)
        }
        ws?.send(frame.toString())
        return tempId
    }

    fun markRead(conversationId: String, msgId: String) {
        val frame = buildJsonObject {
            put("op", "read")
            put("conversationId", conversationId)
            put("msgId", msgId)
        }
        ws?.send(frame.toString())
    }
}
