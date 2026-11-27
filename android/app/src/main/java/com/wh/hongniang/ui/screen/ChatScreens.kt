package com.wh.hongniang.ui.screen

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.location.LocationManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.hongniang.i18n.t
import com.wh.hongniang.net.*
import com.wh.hongniang.ui.*
import com.wh.hongniang.ui.theme.*
import com.wh.hongniang.ui.sticker.SmileIcon
import com.wh.hongniang.ui.sticker.EmojiPanel
import com.wh.hongniang.ui.sticker.dropLastGrapheme
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

@Serializable
data class PeerBrief(val id: String, val nickname: String, val avatar: String = "", val gender: Int = 0)

@Serializable
data class LastMsg(val id: String, val senderId: String, val type: String, val content: String = "", val createdAt: String)

@Serializable
data class ConversationItem(
    val id: String,
    val peer: PeerBrief? = null,
    val lastMsg: LastMsg? = null,
    val unread: Int = 0,
    val lastMsgAt: String,
    /** 互相喜欢的才有：fresh = 刚配上还没说过话 */
    val match: ConvMatch? = null,
    /** 对方点了「不合适，不再联系」 */
    val ended: Boolean = false,
)

@Serializable
data class ConvMatch(val at: String? = null, val fresh: Boolean = false)

@Serializable
data class MsgItem(
    val id: String,
    val conversationId: String,
    val senderId: String,
    val senderNickname: String = "",
    val senderAvatar: String = "",
    val receiverId: String? = null,
    val type: String,
    val content: String,
    val createdAt: String,
    val isRead: Boolean = false,
    val replyTo: ReplyPreview? = null,
    val fwdFrom: String? = null,
    val reactions: List<MsgReaction> = emptyList(),
    /** 本地刚选的图（content://）：上传期间和发出后都用它显示 */
    @kotlinx.serialization.Transient val local: String? = null,
    /** 本地上传任务的 key（进度、失败重试按它找） */
    @kotlinx.serialization.Transient val upKey: String? = null,
) {
    /** 本地刚发、还没收到服务端 ack（id 还是 tempId，或图片还没传完的 l_ 本地 id） */
    val pending: Boolean get() = id.startsWith("t_") || id.startsWith("l_")
}

/** 聊天列表一行的 key：相册按相册 id，本地刚选的图按上传 key（发出、确认换 id 时不重建） */
internal fun chatRowKey(row: List<MsgItem>): String =
    if (row.size > 1) "g_" + (parseImage(row[0].content).g ?: row[0].id) else row[0].upKey ?: row[0].id

private fun parseIso(iso: String?): java.time.Instant? =
    if (iso.isNullOrEmpty()) null else runCatching { java.time.Instant.parse(iso) }.getOrNull()

/** 今天显示 HH:mm，非今天显示 MM-dd HH:mm */
fun fmtChatTime(iso: String?): String {
    val instant = parseIso(iso) ?: return ""
    val zone = java.time.ZoneId.systemDefault()
    val dt = instant.atZone(zone)
    val today = java.time.LocalDate.now(zone)
    val pattern = if (dt.toLocalDate() == today) "HH:mm" else "MM-dd HH:mm"
    return dt.format(java.time.format.DateTimeFormatter.ofPattern(pattern))
}

/** 与上一条间隔超 5 分钟显示时间分隔条 */
fun shouldShowTime(messages: List<MsgItem>, idx: Int): Boolean {
    val cur = parseIso(messages[idx].createdAt) ?: return false
    if (idx == 0) return true
    val prev = parseIso(messages[idx - 1].createdAt) ?: return true
    return java.time.Duration.between(prev, cur).seconds > 300
}

internal fun preview(msg: LastMsg?): String = when {
    msg == null -> ""
    msg.type == "text" -> msg.content.take(30)
    msg.type == "image" -> t("chat.preview.image")
    msg.type == "video" -> t("chat.preview.video")
    msg.type == "audio" -> t("chat.preview.voice")
    msg.type == "file" -> fileSnippet(msg.content, t("chat.preview.file"))
    msg.type == "location" -> t("chat.preview.location")
    msg.type.startsWith("call") -> t("chat.preview.call")
    else -> ""
}

/** 消息列表一行：左图标 54 + 标题 / 时间 + 预览 / 角标，分隔线和文字对齐 */
@Composable
private fun MsgListRow(onClick: () -> Unit, leading: @Composable () -> Unit, title: @Composable RowScope.() -> Unit, end: String, sub: String, badge: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.padding(vertical = 9.dp)) { leading() }
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Column(Modifier.padding(end = 16.dp, top = 9.dp, bottom = 9.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, content = title)
                    if (end.isNotEmpty()) Text(end, color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(start = 8.dp))
                }
                Row(Modifier.padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(sub, color = TextSub, fontSize = 14.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    badge()
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
        }
    }
}

private class PlusMenuItem(val label: String, val icon: @Composable (Color) -> Unit, val onClick: () -> Unit)

/** 消息页右上「+」弹出菜单：白色圆角卡片 + 阴影，从按钮右上角缩放展开 */
@Composable
private fun PlusMenu(expanded: Boolean, onDismiss: () -> Unit, items: List<PlusMenuItem>) {
    val visible = remember { MutableTransitionState(false) }
    visible.targetState = expanded
    if (!visible.currentState && !visible.targetState) return
    val density = LocalDensity.current
    // 卡片四周留 12dp 给阴影（Popup 窗口外的阴影会被裁掉），offset 再抵回去
    Popup(
        alignment = Alignment.TopEnd,
        offset = with(density) { IntOffset(12.dp.roundToPx(), 30.dp.roundToPx()) },
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        AnimatedVisibility(
            visibleState = visible,
            enter = fadeIn(tween(140)) + scaleIn(tween(180), initialScale = 0.85f, transformOrigin = TransformOrigin(1f, 0f)),
            exit = fadeOut(tween(110)) + scaleOut(tween(110), targetScale = 0.92f, transformOrigin = TransformOrigin(1f, 0f)),
        ) {
            Column(
                Modifier.padding(12.dp)
                    .shadow(10.dp, RoundedCornerShape(14.dp), ambientColor = Color.Black.copy(alpha = 0.10f), spotColor = Color.Black.copy(alpha = 0.16f))
                    .clip(RoundedCornerShape(14.dp)).background(Bg)
                    .width(168.dp).padding(vertical = 6.dp),
            ) {
                items.forEach { item ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onDismiss(); item.onClick() }.padding(horizontal = 14.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(32.dp).clip(CircleShape).background(Accent.copy(alpha = 0.10f)), contentAlignment = Alignment.Center) {
                            item.icon(Accent)
                        }
                        Spacer(Modifier.width(12.dp))
                        Text(item.label, color = TextMain, fontSize = 15.sp)
                    }
                }
            }
        }
    }
}

/** 消息主页：标题 + 搜索 + 列表（会话按最新时间排） */
@Composable
fun MessagesScreen(
    modifier: Modifier = Modifier, onOpenChat: (convId: String, targetId: String, title: String) -> Unit, onOpenMessage: (convId: String, targetId: String, title: String, msgId: String) -> Unit, onOpenUser: (userId: String, nickname: String) -> Unit, onScan: () -> Unit,
    /** 跳到 App 内的页面（顶上三个数字点开是喜欢列表） */
    onNav: (String) -> Unit = {},
) {
    var convs by remember { mutableStateOf<List<ConversationItem>>(emptyList()) }
    var showSearch by remember { mutableStateOf(false) }
    /** 顶上三个数字：喜欢我的 / 我喜欢的 / 互相喜欢 */
    var sum by remember { mutableStateOf<MatchSummary?>(null) }
    val scope = rememberCoroutineScope()

    fun loadConvs() { scope.launch { convs = runCatching { Api.getList<ConversationItem>("/im/conversations") }.getOrDefault(convs) } }

    // 进来取一次；有人喜欢了我 / 互相喜欢了 / 对方结束了聊天、从喜欢列表（网页）回来，数字和列表都重新取
    LaunchedEffect(MatchCenter.version, HnEvents.version) {
        loadConvs()
        runCatching { Api.getObj<MatchSummary>("/match/summary") }.onSuccess { sum = it }
    }
    DisposableEffect(Unit) {
        val remove = WsClient.addListener { frame ->
            when (frame["op"]?.jsonPrimitive?.content) {
                // conv_refresh：服务端通知会话列表有变
                "msg", "conv_cleared", "conv_refresh" -> loadConvs()
            }
        }
        onDispose { remove() }
    }

    val entries = remember(convs) { convs.sortedByDescending { parseIso(it.lastMsgAt) ?: java.time.Instant.EPOCH } }

    if (showSearch) {
        ChatSearchDialog(
            convs = convs,
            extras = emptyList(),
            onDismiss = { showSearch = false },
            onOpenChat = { id, target, title -> showSearch = false; onOpenChat(id, target, title) },
            onOpenMessage = { id, target, title, msgId -> showSearch = false; onOpenMessage(id, target, title, msgId) },
            onOpenUser = { id, name -> showSearch = false; onOpenUser(id, name) },
            onScan = { showSearch = false; onScan() },
        )
    }

    Column(modifier = modifier.fillMaxSize()) {
        Row(modifier = Modifier.fillMaxWidth().padding(16.dp, 12.dp, 16.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(t("tab.messages"), color = TextMain, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Box {
                var showPlusMenu by remember { mutableStateOf(false) }
                Box(modifier = Modifier.size(34.dp).clip(CircleShape).background(Bg3).clickable { showPlusMenu = true }, contentAlignment = Alignment.Center) { PlusIcon(TextMain, 18.dp) }
                PlusMenu(
                    expanded = showPlusMenu,
                    onDismiss = { showPlusMenu = false },
                    items = listOf(
                        PlusMenuItem(t("me.scan"), { ScanIcon(it, 18.dp) }, onScan),
                    ),
                )
            }
        }

        // 搜索胶囊：点了弹全屏搜索框；右端扫一扫
        Box(
            Modifier.padding(start = 16.dp, end = 16.dp, bottom = 6.dp).fillMaxWidth().height(36.dp)
                .clip(RoundedCornerShape(18.dp)).background(Bg3).clickable { showSearch = true },
        ) {
            Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically) {
                com.wh.hongniang.ui.sticker.SearchIcon(TextSub, 16.dp)
                Text(t("common.search"), color = TextSub, fontSize = 15.sp, modifier = Modifier.padding(start = 6.dp))
            }
            Box(
                Modifier.align(Alignment.CenterEnd).padding(end = 4.dp).size(28.dp).clip(androidx.compose.foundation.shape.CircleShape).clickable(onClick = onScan),
                contentAlignment = Alignment.Center,
            ) { ScanIcon(TextSub, 17.dp) }
        }

        LazyColumn(Modifier.fillMaxSize()) {
            // 喜欢我的 / 我喜欢的 / 互相喜欢
            item("likes") { LikeEntries(sum, onNav) }
            items(entries, key = { "c-${it.id}" }) { c ->
                val name = c.peer?.nickname ?: ""
                val fresh = c.match?.fresh == true
                MsgListRow(
                    onClick = { c.peer?.let { onOpenChat(c.id, it.id, name) } }, leading = { Avatar(c.peer?.avatar, 54) },
                    title = {
                        Text(name, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        // 刚互相喜欢、还没说过话
                        if (fresh) {
                            Text(
                                "刚配上", color = HnRose, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
                                modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(10.dp)).background(HnSoft).padding(horizontal = 8.dp, vertical = 2.dp),
                            )
                        }
                    },
                    end = fmtChatTime(c.lastMsgAt),
                    sub = if (fresh) "你们互相喜欢了，打个招呼吧" else if (c.ended && c.lastMsg == null) "对方已结束聊天" else preview(c.lastMsg),
                    badge = { com.wh.hongniang.ui.RoundBadge(c.unread, Modifier.padding(start = 8.dp)) },
                )
            }
            if (entries.isEmpty()) item("empty") {
                Box(Modifier.fillMaxWidth().padding(vertical = 60.dp), contentAlignment = Alignment.Center) {
                    Text("还没有聊天。\n互相喜欢以后，对方会出现在这里。", color = TextSub, fontSize = 14.sp, lineHeight = 26.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
        }
    }
}

/** 聊天页：文字/图片/语音/位置 */
@SuppressLint("MissingPermission")
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun ChatRoomScreen(
    convId: String, targetId: String, title: String, focusMsgId: String = "", myUserId: String, myAvatar: String, myNickname: String,
    onBack: () -> Unit, onCall: (Int) -> Unit,
    /** 跳到 App 内的页面（聊天图片「识别二维码」后交给统一的扫码处理） */
    onNav: (String) -> Unit = {},
    /** 先填进输入框的话（从互相喜欢的庆祝页点了一句开场白进来），可以改了再发 */
    draft: String = "",
) {
    val handleScan = rememberScanHandler(onNav)
    var messages by remember { mutableStateOf<List<MsgItem>>(emptyList()) }
    var input by remember { mutableStateOf(draft) }
    /** 我和对方的关系：互相喜欢了才能发消息（规则上线前就聊过的有保留期） */
    var rel by remember { mutableStateOf<MatchRelation?>(null) }
    var reportUser by remember { mutableStateOf(false) }
    var showEndConfirm by remember { mutableStateOf(false) }
    // 进来取一次；互相喜欢了 / 对方结束了聊天、从对方的画像网页回来（在那里可能点了喜欢），都重新取
    LaunchedEffect(targetId, MatchCenter.version, HnEvents.version) {
        if (targetId.isNotEmpty()) runCatching { Api.getObj<MatchRelation>("/match/relation/$targetId") }.onSuccess { rel = it }
    }
    var fullImage by remember { mutableStateOf<String?>(null) }
    var recording by remember { mutableStateOf(false) }
    var voiceMode by remember { mutableStateOf(false) }
    var showAttach by remember { mutableStateOf(false) }
    var showEmoji by remember { mutableStateOf(false) }
    val inputFocus = remember { androidx.compose.ui.focus.FocusRequester() }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    /** 正在播删除动画（灰飞烟灭）的消息 id */
    var dying by remember { mutableStateOf(setOf<String>()) }

    /** 屏幕上看得见的播完动画再移除，看不见的直接移除；2 秒兜底防止滚走后卡住 */
    fun removeMsgs(ids: Collection<String>) {
        val todo = ids.toSet() - dying
        if (todo.isEmpty()) return
        val keys = listState.layoutInfo.visibleItemsInfo.map { it.key.toString() }.toSet()
        // 相册只删其中几张时不播动画，剩下的重新拼版
        val visible = groupAlbums(messages).filter { chatRowKey(it) in keys && (it.size == 1 || it.all { m -> m.id in todo }) }
            .flatten().map { it.id }.toSet()
        val (show, hide) = todo.partition { it in visible }
        if (hide.isNotEmpty()) messages = messages.filterNot { it.id in hide }
        if (show.isEmpty()) return
        dying = dying + show
        scope.launch {
            kotlinx.coroutines.delay(2000)
            messages = messages.filterNot { it.id in show }
            dying = dying - show.toSet()
        }
    }
    /** 列表按行排（相册一行），这两个把消息换算成行号 */
    fun rowIndexOf(id: String) = groupAlbums(messages).indexOfFirst { r -> r.any { it.id == id } }
    fun lastRow() = (groupAlbums(messages).size - 1).coerceAtLeast(0)
    val ctx = LocalContext.current
    var recorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var recFile by remember { mutableStateOf<File?>(null) }
    var recStart by remember { mutableLongStateOf(0L) }

    // ---------- 长按菜单相关状态 ----------
    var menuMsg by remember { mutableStateOf<MsgItem?>(null) }
    var replyTo by remember { mutableStateOf<MsgItem?>(null) }
    var pins by remember { mutableStateOf<List<PinItem>>(emptyList()) }
    var pinIdx by remember { mutableIntStateOf(0) }
    var selecting by remember { mutableStateOf<Set<String>?>(null) }
    var forwardIds by remember { mutableStateOf<List<String>?>(null) }
    var reportId by remember { mutableStateOf<String?>(null) }
    var deleteIds by remember { mutableStateOf<List<String>?>(null) }
    /** 没完成资料收集就发消息：弹框带去 AI 红娘 */
    var needProfile by remember { mutableStateOf(false) }
    var needKyc by remember { mutableStateOf(false) }

    fun toast(msg: String) = android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_SHORT).show()

    /** 发消息并乐观显示；正在回复的话只挂在这一条上 */
    fun sendMsg(type: String, content: String) {
        val r = replyTo
        replyTo = null
        val tempId = WsClient.send(targetId, type, content, r?.id)
        val preview = r?.let { ReplyPreview(it.id, it.senderId, it.senderNickname, it.type, if (it.type == "text") it.content.take(100) else if (it.type == "image") it.content else "") }
        messages = messages + MsgItem(tempId, convId, myUserId, myNickname, myAvatar, null, type, content, java.time.Instant.now().toString(), replyTo = preview)
    }

    suspend fun loadPins() {
        pins = runCatching { Api.getList<PinItem>("/im/conversations/$convId/pins") }.getOrDefault(emptyList())
        pinIdx = 0
    }

    // 重新拉取消息列表（清空记录后本端及其他端同步用）
    suspend fun reloadMessages() {
        messages = runCatching { Api.getList<MsgItem>("/im/messages?conversationId=$convId") }.getOrDefault(emptyList())
    }

    // 从搜索结果进来：首屏定位到该消息并闪一下，之后照常滚到底
    var focusTarget by remember { mutableStateOf(focusMsgId) }
    var flashId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(convId) {
        val around = if (focusMsgId.isNotEmpty()) "&aroundId=$focusMsgId" else ""
        val list = runCatching { Api.getList<MsgItem>("/im/messages?conversationId=$convId$around") }.getOrDefault(emptyList())
        // 列表回来之前就发出 / 收到的消息不能被覆盖掉
        val ids = list.map { it.id }.toSet()
        messages = list + messages.filterNot { it.id in ids }
        launch { loadPins() }
        messages.lastOrNull()?.let { WsClient.markRead(convId, it.id) }
        WsClient.connect()
    }
    DisposableEffect(convId) {
        val remove = WsClient.addListener { frame ->
            when (frame["op"]?.jsonPrimitive?.content) {
                "msg" -> {
                    val data = frame["data"]?.jsonObject ?: return@addListener
                    val m = WsClient.json.decodeFromJsonElement(MessagePayload.serializer(), data)
                    if (m.conversationId == convId) {
                        messages = messages + MsgItem(
                            m.id, m.conversationId, m.senderId, m.senderNickname, m.senderAvatar, m.receiverId, m.type, m.content, m.createdAt,
                            replyTo = m.replyTo, fwdFrom = m.fwdFrom, reactions = m.reactions,
                        )
                        WsClient.markRead(convId, m.id)
                    }
                }
                "msg_delete" -> {
                    val d = frame["data"]?.jsonObject ?: return@addListener
                    if (d["conversationId"]?.jsonPrimitive?.content != convId) return@addListener
                    val id = d["msgId"]?.jsonPrimitive?.content ?: return@addListener
                    removeMsgs(listOf(id))
                    pins = pins.filterNot { it.id == id }
                }
                "ack" -> {
                    val tid = frame["tempId"]?.jsonPrimitive?.content ?: return@addListener
                    val mid = frame["msgId"]?.jsonPrimitive?.content ?: return@addListener
                    val at = frame["createdAt"]?.jsonPrimitive?.content
                    messages = messages.map { if (it.id == tid) it.copy(id = mid, createdAt = at ?: it.createdAt) else it }
                }
                "read" -> {
                    if (frame["conversationId"]?.jsonPrimitive?.content != convId) return@addListener
                    val upTo = frame["msgId"]?.jsonPrimitive?.content?.toLongOrNull() ?: return@addListener
                    messages = messages.map { m -> if (m.senderId == myUserId && (m.id.toLongOrNull() ?: Long.MAX_VALUE) <= upTo) m.copy(isRead = true) else m }
                }
                "msg_reactions" -> {
                    val d = frame["data"]?.jsonObject ?: return@addListener
                    if (d["conversationId"]?.jsonPrimitive?.content != convId) return@addListener
                    val id = d["msgId"]?.jsonPrimitive?.content
                    val rs = runCatching { WsClient.json.decodeFromJsonElement(ListSerializer(MsgReaction.serializer()), d["reactions"]!!) }.getOrDefault(emptyList())
                    messages = messages.map { if (it.id == id) it.copy(reactions = rs) else it }
                }
                "msg_pin" -> {
                    if (frame["data"]?.jsonObject?.get("conversationId")?.jsonPrimitive?.content == convId) scope.launch { loadPins() }
                }
                "error" -> {
                    // 发送被后端拒绝：撤回乐观显示的消息，提示一下。
                    // 2026-11-27 起发消息放开了，服务器不会再因为没填资料 / 没认证 / 没互相喜欢拒绝（need_profile、need_kyc 两个分支留着兜底）
                    val code = frame["code"]?.jsonPrimitive?.content
                    if (code == "need_profile") {
                        needProfile = true
                    } else if (code == "need_kyc") {
                        // 后台要求先做实人认证：弹框带去认证页（网页）
                        needKyc = true
                    } else {
                        val msg = frame["msg"]?.jsonPrimitive?.content ?: t("chat.sendFailed")
                        android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_SHORT).show()
                        // 对方已结束聊天：重新取一次关系，输入区换成说明
                        if (code == "chat_ended") MatchCenter.version++
                    }
                    val tid = frame["tempId"]?.jsonPrimitive?.content
                    (if (tid != null) messages.firstOrNull { it.id == tid } else messages.lastOrNull { it.id.startsWith("t_") })?.let { last -> messages = messages - last }
                }
                "conv_cleared" -> {
                    // 有人清空了记录：重新拉取同步
                    val cid = frame["data"]?.jsonObject?.get("conversationId")?.jsonPrimitive?.content
                    if (cid == convId) scope.launch { reloadMessages() }
                }
            }
        }
        onDispose { remove() }
    }
    LaunchedEffect(messages.size) {
        if (messages.isEmpty()) return@LaunchedEffect
        if (focusTarget.isNotEmpty()) {
            val target = focusTarget
            focusTarget = ""
            val idx = rowIndexOf(target)
            if (idx >= 0) {
                // 目标消息上方留两条上下文
                listState.scrollToItem((idx - 2).coerceAtLeast(0))
                flashId = target
                return@LaunchedEffect
            }
        }
        // 首次进入直接定位到底部，之后新消息平滑滚动
        listState.scrollToItem(lastRow())
    }
    LaunchedEffect(flashId) {
        if (flashId != null) { kotlinx.coroutines.delay(1600); flashId = null }
    }
    // 键盘高度变化时把列表滚到底，内容随键盘上移、最后一条贴着输入框
    val imeBottom = WindowInsets.ime.getBottom(androidx.compose.ui.platform.LocalDensity.current)
    LaunchedEffect(imeBottom) {
        if (messages.isNotEmpty()) runCatching { listState.scrollToItem(lastRow()) }
    }

    // ---------- 长按菜单的操作 ----------

    /** 跳到某条消息（引用 / 置顶）：不在当前列表就按 aroundId 重新拉一段 */
    fun jumpTo(id: String) = scope.launch {
        val idx = rowIndexOf(id)
        if (idx >= 0) {
            listState.scrollToItem((idx - 2).coerceAtLeast(0))
            flashId = id
            return@launch
        }
        val list = runCatching { Api.getList<MsgItem>("/im/messages?conversationId=$convId&aroundId=$id") }.getOrDefault(emptyList())
        if (list.none { it.id == id }) { toast(t("chat.originalGone")); return@launch }
        // 交给 LaunchedEffect(messages.size) 定位（列表条数没变时它不会触发，就地滚）
        focusTarget = id
        val sameSize = list.size == messages.size
        messages = list
        if (sameSize) {
            kotlinx.coroutines.delay(50)
            focusTarget = ""
            listState.scrollToItem((rowIndexOf(id) - 2).coerceAtLeast(0))
            flashId = id
        }
    }

    fun react(id: String, emoji: String) = scope.launch {
        runCatching {
            val r = Api.request("/im/messages/$id/react", "POST", buildJsonObject { put("emoji", JsonPrimitive(emoji)) })
            val rs = WsClient.json.decodeFromJsonElement(ListSerializer(MsgReaction.serializer()), r!!.jsonObject["reactions"]!!)
            messages = messages.map { if (it.id == id) it.copy(reactions = rs) else it }
        }.onFailure { toast(it.message ?: t("common.failed")) }
    }

    fun togglePin(id: String, pin: Boolean) = scope.launch {
        runCatching { Api.request("/im/messages/$id/pin", "POST", buildJsonObject { put("pin", JsonPrimitive(pin)) }) }
            .onSuccess { loadPins(); toast(if (pin) t("chat.pinned") else t("chat.unpinned")) }
            .onFailure { toast(it.message ?: t("common.failed")) }
    }

    fun doDelete(ids: List<String>, forAll: Boolean) = scope.launch {
        runCatching {
            Api.request("/im/messages/delete", "POST", buildJsonObject {
                put("conversationId", JsonPrimitive(convId)); put("ids", jsonIds(ids)); put("forAll", JsonPrimitive(forAll))
            })
        }.onSuccess { selecting = null; removeMsgs(ids) }
            .onFailure { toast(it.message ?: t("chat.deleteFailed")) }
    }

    /** 能否「为双方删除」：只能删自己发的 */
    fun canDeleteForAll(m: MsgItem) = m.senderId == myUserId

    fun menuActions(m: MsgItem) = MenuActions(
        onReact = { react(m.id, it) },
        onReply = { replyTo = m; showEmoji = false; voiceMode = false; runCatching { inputFocus.requestFocus() } },
        onCopy = if (m.type == "text") ({ copyToClipboard(ctx, m.content) }) else null,
        onSave = if (m.type == "image" || m.type == "video") ({ scope.launch { saveMediaToGallery(ctx, if (m.type == "image") imageUrl(m.content) else m.content, m.type) } })
            else if (m.type == "file" && parseChatFile(m.content).url != null) ({ downloadChatFile(ctx, parseChatFile(m.content)) }) else null,
        onPin = { togglePin(m.id, pins.none { it.id == m.id }) },
        onForward = if (m.type in FORWARDABLE) ({ forwardIds = listOf(m.id) }) else null,
        onReport = if (m.senderId != myUserId) ({ reportId = m.id }) else null,
        onDelete = { deleteIds = listOf(m.id) },
        onSelect = { selecting = setOf(m.id) },
    )

    val audioPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val locPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { g ->
        if (g.values.any { it }) sendLocation(ctx) { name, lat, lng ->
            sendMsg("location", buildJsonObject { put("name", JsonPrimitive(name)); put("lat", JsonPrimitive(lat)); put("lng", JsonPrimitive(lng)) }.toString())
        }
    }
    // ---------- 发图：选好立刻显示（本地预览 + 进度圈），后台最多同时传 3 张，按选择顺序发出；多张合成相册 ----------
    val uploads = remember { mutableStateMapOf<String, UploadState>() }
    val upUris = remember { mutableMapOf<String, Uri>() }

    suspend fun uploadOne(key: String): String? {
        val uri = upUris[key] ?: return null
        uploads[key] = UploadState(0f)
        return runCatching {
            val (bytes, mime) = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { compressImage(ctx, uri) }
            Api.upload("image", bytes, if (mime == "image/gif") "img.gif" else "img.jpg", mime) { p ->
                if (uploads[key]?.failed == false) uploads[key] = UploadState(p)
            }
        }.onSuccess { uploads.remove(key) }
            .onFailure { uploads[key] = UploadState(failed = true) }
            .getOrNull()
    }

    /** 传完的图发出去：本地那条换成 tempId，等 ack；正在回复的引用挂在第一张上 */
    fun sendUploaded(key: String, url: String): String? {
        val m = messages.firstOrNull { it.upKey == key } ?: return null
        val meta = parseImage(m.content)
        val content = imageContent(url, meta.g, meta.w, meta.h)
        val tempId = WsClient.send(targetId, "image", content, m.replyTo?.id)
        messages = messages.map { if (it.upKey == key) it.copy(id = tempId, content = content) else it }
        upUris.remove(key)
        return tempId
    }

    // 「+」弹框选的图 / 拍的照；说明文字等图都发出后单独发一条
    fun sendImages(uris: List<Uri>, caption: String) {
        if (uris.isEmpty()) return
        val g = if (uris.size > 1) newAlbumId() else null
        val r = replyTo
        replyTo = null
        val preview = r?.let { ReplyPreview(it.id, it.senderId, it.senderNickname, it.type, if (it.type == "text") it.content.take(100) else if (it.type == "image") imageUrl(it.content) else "") }
        scope.launch {
            val stamp = System.currentTimeMillis()
            val items = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                uris.mapIndexed { i, uri -> Triple("l_${stamp}_${i}_${(1000..9999).random()}", uri, readImageSize(ctx, uri)) }
            }
            val now = java.time.Instant.now().toString()
            items.forEach { (key, uri, _) -> upUris[key] = uri; uploads[key] = UploadState(0f) }
            messages = messages + items.mapIndexed { i, (key, uri, wh) ->
                MsgItem(
                    key, convId, myUserId, myNickname, myAvatar, null, "image", imageContent("", g, wh.first, wh.second), now,
                    replyTo = if (i == 0) preview else null, local = uri.toString(), upKey = key,
                )
            }
            ChatUploadScope.launch {
                uploadInOrder(items.map { it.first }, { uploadOne(it) }, { k, u -> sendUploaded(k, u)?.let { awaitAck(it) } })
                val text = caption.trim()
                if (text.isNotEmpty()) sendMsg("text", text)
            }
        }
    }

    // ---------- 「文件」里选的：图片走发图，音频按语音发，视频 / 文件立刻显示带进度的占位，按顺序一个个传 ----------
    /** 视频 / 文件占位对应的原文件（按 upKey） */
    val upPicked = remember { mutableMapOf<String, PickedFile>() }

    /** 传完返回消息 content：视频是地址，文件是 { url, name, size, mime } */
    suspend fun uploadPicked(key: String): String? {
        val p = upPicked[key] ?: return null
        val type = messages.firstOrNull { it.upKey == key }?.type ?: return null
        uploads[key] = UploadState(0f)
        val onProgress: (Float) -> Unit = { v -> if (uploads[key]?.failed == false) uploads[key] = UploadState(v) }
        return runCatching {
            if (type == "video") Api.uploadUri("video", ctx, p.uri, p.name, p.size, p.mime, onProgress)
            else Api.uploadChatFile(ctx, p.uri, p.name, p.size, p.mime, onProgress).let { r ->
                buildJsonObject { put("url", JsonPrimitive(r.url)); put("name", JsonPrimitive(r.name)); put("size", JsonPrimitive(r.size)); put("mime", JsonPrimitive(r.mime)) }.toString()
            }
        }.onSuccess { uploads.remove(key) }
            .onFailure { uploads[key] = UploadState(failed = true); toast(it.message ?: t("common.uploadFailed")) }
            .getOrNull()
    }

    fun sendPicked(key: String, content: String): String? {
        val m = messages.firstOrNull { it.upKey == key } ?: return null
        val tempId = WsClient.send(targetId, m.type, content, m.replyTo?.id)
        messages = messages.map { if (it.upKey == key) it.copy(id = tempId, content = content) else it }
        upPicked.remove(key)
        return tempId
    }

    fun sendFiles(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch {
            val all = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { inspectPicked(ctx, uris) }
            all.firstOrNull { it.size == 0L || it.size > FILE_MAX_SIZE }?.let {
                toast(t(if (it.size == 0L) "chat.file.empty" else "chat.file.tooLarge", "name" to it.name))
            }
            val ok = all.filter { it.size != 0L && it.size <= FILE_MAX_SIZE }
            val images = ok.filter { it.kind == PickKind.Image }.map { it.uri }
            if (images.isNotEmpty()) sendImages(images, "")

            val picked = ok.filter { it.kind == PickKind.Video || it.kind == PickKind.File }
            val r = if (picked.isNotEmpty()) replyTo else null
            if (r != null) replyTo = null
            val preview = r?.let { ReplyPreview(it.id, it.senderId, it.senderNickname, it.type, if (it.type == "text") it.content.take(100) else if (it.type == "image") imageUrl(it.content) else "") }
            val stamp = System.currentTimeMillis()
            val now = java.time.Instant.now().toString()
            val items = picked.mapIndexed { i, p -> "l_f${stamp}_${i}_${(1000..9999).random()}" to p }
            items.forEach { (key, p) -> upPicked[key] = p.copy(mime = uploadMime(p.mime)); uploads[key] = UploadState(0f) }
            messages = messages + items.mapIndexed { i, (key, p) ->
                val video = p.kind == PickKind.Video
                val content = if (video) "" else buildJsonObject { put("name", JsonPrimitive(p.name)); put("size", JsonPrimitive(p.size)); put("mime", JsonPrimitive(p.mime)) }.toString()
                MsgItem(key, convId, myUserId, myNickname, myAvatar, null, if (video) "video" else "file", content, now, replyTo = if (i == 0) preview else null, upKey = key)
            }
            ChatUploadScope.launch {
                for (a in ok.filter { it.kind == PickKind.Audio }) {
                    runCatching { Api.uploadUri("audio", ctx, a.uri, a.name, a.size, uploadMime(a.mime)) }
                        .onSuccess { url -> sendMsg("audio", buildJsonObject { put("url", JsonPrimitive(url)); put("duration", JsonPrimitive(a.duration)) }.toString()) }
                        .onFailure { toast(it.message ?: t("common.uploadFailed")) }
                }
                for ((key, _) in items) uploadPicked(key)?.let { c -> sendPicked(key, c)?.let { awaitAck(it) } }
            }
        }
    }

    fun retryUpload(m: MsgItem) {
        val key = m.upKey ?: return
        if (m.type == "file" || m.type == "video") {
            ChatUploadScope.launch { uploadPicked(key)?.let { sendPicked(key, it) } }
            return
        }
        ChatUploadScope.launch { uploadOne(key)?.let { sendUploaded(key, it) } }
    }

    fun startRec() {
        runCatching {
            val f = File(ctx.cacheDir, "rec_${System.currentTimeMillis()}.m4a")
            val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else @Suppress("DEPRECATION") MediaRecorder()
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setOutputFile(f.absolutePath)
            r.prepare(); r.start()
            recorder = r; recFile = f; recStart = System.currentTimeMillis(); recording = true
        }
    }
    fun stopRec() {
        recording = false
        runCatching { recorder?.stop(); recorder?.release() }
        recorder = null
        val f = recFile ?: return
        val dur = ((System.currentTimeMillis() - recStart) / 1000).toInt().coerceAtLeast(1)
        scope.launch {
            runCatching {
                val url = Api.upload("audio", f.readBytes(), "a.m4a", "audio/m4a")
                val c = buildJsonObject { put("url", JsonPrimitive(url)); put("duration", JsonPrimitive(dur)) }.toString()
                sendMsg("audio", c)
            }
        }
    }

    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val focus = androidx.compose.ui.platform.LocalFocusManager.current

    var showClearConfirm by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize()) {
        Row(modifier = Modifier.fillMaxWidth().padding(8.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(modifier = Modifier.size(40.dp).noRippleClick(onBack), contentAlignment = Alignment.Center) { BackIcon(TextMain, 24.dp) }
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                Text(title, color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            }
            var menu by remember { mutableStateOf(false) }
            Box {
                Box(Modifier.size(40.dp).noRippleClick { menu = true }, contentAlignment = Alignment.Center) {
                    Text("···", color = TextMain, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                }
                androidx.compose.material3.DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = Bg2) {
                    if (targetId.isNotEmpty()) {
                        androidx.compose.material3.DropdownMenuItem(text = { Text("看 TA 的画像", fontSize = 14.sp, color = TextMain) }, onClick = { menu = false; onNav("u/$targetId") })
                        // 视频见面：按钮一直在（结束了联系的除外）。要互相喜欢、两个人都打开了视频见面才打得通；
                        // 能不能打由服务器决定：没互相喜欢会弹说明（VideoNeedLikeDialog），别的原因给一句提示
                        if (rel?.state != "ended") {
                            androidx.compose.material3.DropdownMenuItem(text = { Text("视频见面", fontSize = 14.sp, color = TextMain) }, onClick = { menu = false; onCall(2) })
                        }
                        androidx.compose.material3.DropdownMenuItem(text = { Text("举报", fontSize = 14.sp, color = TextMain) }, onClick = { menu = false; reportUser = true })
                        // 不合适，不再联系：任何时候都能点（2026-11-27 起谁都能先发消息，这是不想被打扰时唯一的办法）；自己已经点过的不再显示
                        val r = rel
                        if (r != null && r.endedBy != "me") {
                            androidx.compose.material3.DropdownMenuItem(text = { Text("不合适，不再联系", fontSize = 14.sp, color = Danger) }, onClick = { menu = false; showEndConfirm = true })
                        }
                    }
                    androidx.compose.material3.DropdownMenuItem(text = { Text(com.wh.hongniang.i18n.t("chat.menu.clear"), fontSize = 14.sp, color = Danger) }, onClick = { menu = false; showClearConfirm = true })
                }
            }
        }
        // 顶上一条提示：哪天配上的 + 防骗提醒
        ChatMatchBanner(rel)
        if (reportUser) {
            ReportUserDialog(targetId, onDone = { tip -> reportUser = false; toast(tip) }) { reportUser = false }
        }
        if (showEndConfirm) {
            androidx.compose.material3.AlertDialog(
                onDismissRequest = { showEndConfirm = false },
                containerColor = Bg2,
                title = { Text("不合适，不再联系", color = TextMain) },
                text = { Text("之后你们都不能再给对方发消息，这个聊天会从列表里收起，也不再互相推荐。对方只会看到「对方已结束聊天」。", color = TextSub) },
                confirmButton = {
                    Text("不再联系", color = Danger, modifier = Modifier.noRippleClick {
                        showEndConfirm = false
                        scope.launch {
                            runCatching { Api.request("/match/end/$targetId", "POST") }
                                .onSuccess { MatchCenter.version++; onBack() }
                                .onFailure { toast(it.message ?: t("chat.sendFailed")) }
                        }
                    }.padding(8.dp))
                },
                dismissButton = { Text(t("common.cancel"), color = TextSub, modifier = Modifier.noRippleClick { showEndConfirm = false }.padding(8.dp)) },
            )
        }

        if (pins.isNotEmpty()) {
            PinBar(
                pins, pinIdx,
                onJump = { jumpTo(pins[pinIdx % pins.size].id); pinIdx = (pinIdx + 1) % pins.size },
                onUnpin = { togglePin(pins[pinIdx % pins.size].id, false) },
            )
        }

        if (needProfile) {
            NeedProfileDialog(onDismiss = { needProfile = false }, onGo = { needProfile = false; onNav("interview") })
        }
        if (needKyc) {
            NeedKycDialog(onDismiss = { needKyc = false }, onGo = { needKyc = false; onNav(hnH5("/kyc?next=/me")) })
        }
        if (showClearConfirm) {
            androidx.compose.material3.AlertDialog(
                onDismissRequest = { showClearConfirm = false },
                containerColor = Bg2,
                title = { Text(t("chat.menu.clear"), color = TextMain) },
                text = { Text(t("chat.clearSingleConfirm"), color = TextSub) },
                confirmButton = {
                    Text(t("chat.clear"), color = Danger, modifier = Modifier.noRippleClick {
                        showClearConfirm = false
                        scope.launch {
                            runCatching { Api.request("/im/conversations/$convId/clear", "POST") }
                                .onSuccess { reloadMessages() }
                        }
                    }.padding(8.dp))
                },
                dismissButton = { Text(t("common.cancel"), color = TextSub, modifier = Modifier.noRippleClick { showClearConfirm = false }.padding(8.dp)) },
            )
        }
        // 一行一条消息，同一相册的连续图片合成一行；second 是这行第一条在 messages 里的下标
        val chatRows = remember(messages) {
            var start = 0
            groupAlbums(messages).map { r -> (r to start).also { start += r.size } }
        }
        LazyColumn(state = listState, modifier = Modifier.weight(1f).padding(horizontal = 12.dp).noRippleClick { showEmoji = false; focus.clearFocus(); keyboard?.hide() }) {
            items(chatRows, key = { chatRowKey(it.first) }) { (row, idx) ->
                val m = row[0]
                val album = if (row.size > 1) row else null
                val rowIds = row.map { it.id }
                // 微信式时间分隔条：与上一条间隔超 5 分钟显示
                if (shouldShowTime(messages, idx)) {
                    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                        Text(fmtChatTime(m.createdAt), color = TextDim, fontSize = 11.sp)
                    }
                }
                val flashOn = flashId != null && flashId in rowIds
                val flashBg by androidx.compose.animation.animateColorAsState(
                    if (flashOn) Accent.copy(alpha = 0.14f) else Color.Transparent,
                    androidx.compose.animation.core.tween(if (flashOn) 150 else 900), label = "flash",
                )
                val sel = selecting
                val rowPending = row.any { it.pending }
                val rowSelected = sel != null && rowIds.all { it in sel }
                Box(
                    Modifier.fillMaxWidth()
                        .dustOut(rowIds.all { it in dying }) { messages = messages.filterNot { it.id in rowIds }; dying = dying - rowIds.toSet() }
                        .clip(RoundedCornerShape(8.dp)).background(flashBg),
                ) {
                    if (sel != null) {
                        val toggle = { if (!rowPending) selecting = if (rowSelected) sel - rowIds.toSet() else sel + rowIds }
                        Row(
                            Modifier.fillMaxWidth().noRippleClick(toggle),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            SelectCircle(rowSelected)
                            Spacer(Modifier.width(10.dp))
                            Box(Modifier.weight(1f)) {
                                Bubble(m, m.senderId == myUserId, myUserId, onImage = {}, onMenu = {}, onReact = {}, onJump = {}, album = album, uploads = uploads)
                                // 多选时盖一层，点哪都是勾选
                                Box(Modifier.matchParentSize().noRippleClick(toggle))
                            }
                        }
                    } else {
                        Bubble(
                            m, m.senderId == myUserId, myUserId,
                            onImage = { fullImage = it },
                            onMenu = { if (!m.pending) { focus.clearFocus(); keyboard?.hide(); menuMsg = m } },
                            onReact = { react(m.id, it) },
                            onJump = { jumpTo(it) },
                            album = album,
                            uploads = uploads,
                            onItemMenu = { it2 -> if (!it2.pending) { focus.clearFocus(); keyboard?.hide(); menuMsg = it2 } },
                            onItemReact = { it2, e -> react(it2.id, e) },
                            onRetry = { retryUpload(it) },
                        )
                    }
                }
            }
        }
        val sel = selecting
        if (sel != null) {
            val chosen = messages.filter { it.id in sel }
            Row(Modifier.fillMaxWidth().background(Bg2).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(t("common.cancel"), color = TextMain, fontSize = 15.sp, modifier = Modifier.noRippleClick { selecting = null })
                Text(t("chat.selectedN", "n" to sel.size), color = TextSub, fontSize = 13.sp, modifier = Modifier.weight(1f).padding(start = 14.dp))
                val on = chosen.isNotEmpty()
                Text(t("chat.copySelected"), color = if (on) TextMain else TextDim, fontSize = 15.sp, modifier = Modifier.noRippleClick {
                    val texts = chosen.filter { it.type == "text" }
                    if (texts.isEmpty()) toast(t("chat.noTextSelected"))
                    else { copyToClipboard(ctx, texts.joinToString("\n") { it.content }); selecting = null }
                })
                Spacer(Modifier.width(18.dp))
                Text(t("chat.forward"), color = if (on) TextMain else TextDim, fontSize = 15.sp, modifier = Modifier.noRippleClick {
                    val ok = chosen.filter { it.type in FORWARDABLE }.map { it.id }
                    if (ok.isEmpty()) toast(t("chat.cantForward"))
                    else { if (ok.size < chosen.size) toast(t("chat.partForward")); forwardIds = ok }
                })
                Spacer(Modifier.width(18.dp))
                Text(t("common.delete"), color = if (on) Danger else TextDim, fontSize = 15.sp, modifier = Modifier.noRippleClick { if (on) deleteIds = chosen.map { it.id } })
            }
        } else if (rel?.state == "ended") {
            // 有一方点了「不再联系」：输入区换成一句说明，聊天记录照常能看。其余情况一律能发
            ChatBlockedBar(rel!!)
        } else
        // 微信式底部区（随键盘上移）：左语音切换 / 输入框 / +面板 / 发送
        Column(modifier = Modifier.background(Bg2).imePadding().navigationBarsPadding()) {
            replyTo?.let { r -> ReplyBar(r.senderNickname, msgSnippet(r.type, r.content)) { replyTo = null } }
            Row(modifier = Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
                Box(
                    modifier = Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).background(Bg3).noRippleClick { voiceMode = !voiceMode; showEmoji = false; focus.clearFocus(); keyboard?.hide() },
                    contentAlignment = Alignment.Center,
                ) { if (voiceMode) KeyboardIcon(TextSub, 20.dp) else WaveformIcon(TextSub, 18.dp) } // 与 iOS 一致：waveform / keyboard
                Spacer(Modifier.width(8.dp))

                if (voiceMode) {
                    Box(
                        modifier = Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(20.dp)).background(if (recording) Accent else Bg3)
                            .pointerInputRecord(onStart = { audioPerm.launch(Manifest.permission.RECORD_AUDIO); startRec() }, onStop = { stopRec() }),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (recording) {
                            val trans = rememberInfiniteTransition(label = "rec")
                            val a by trans.animateFloat(0.35f, 1f, infiniteRepeatable(tween(600), RepeatMode.Reverse), label = "a")
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                WaveformIcon(Color.White.copy(alpha = a), 16.dp); Spacer(Modifier.width(8.dp)); Text(t("chat.releaseToSend"), color = Color.White, fontSize = 14.sp)
                            }
                        } else Text(t("chat.holdToTalk"), color = TextMain, fontSize = 14.sp)
                    }
                } else {
                    Box(
                        modifier = Modifier.weight(1f).heightIn(min = 40.dp).clip(RoundedCornerShape(20.dp)).background(Bg3).padding(horizontal = 14.dp, vertical = 9.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        if (input.isEmpty()) Text(t("chat.inputHint"), color = TextDim, fontSize = 15.sp)
                        androidx.compose.foundation.text.BasicTextField(
                            value = input, onValueChange = { input = it },
                            textStyle = androidx.compose.ui.text.TextStyle(color = TextMain, fontSize = 15.sp),
                            cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                            maxLines = 4,
                            modifier = Modifier.fillMaxWidth().focusRequester(inputFocus).onFocusChanged { if (it.isFocused) showEmoji = false },
                        )
                    }
                }
                Spacer(Modifier.width(8.dp))
                // 表情按钮：面板顶替键盘（Telegram 式）
                Box(
                    modifier = Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).background(if (showEmoji) BubbleMine else Bg3).noRippleClick { focus.clearFocus(); keyboard?.hide(); voiceMode = false; showEmoji = !showEmoji },
                    contentAlignment = Alignment.Center,
                ) { SmileIcon(if (showEmoji) Accent else TextSub, 22.dp) }
                Spacer(Modifier.width(8.dp))
                Box(modifier = Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).background(Bg3).noRippleClick { focus.clearFocus(); keyboard?.hide(); showEmoji = false; showAttach = true }, contentAlignment = Alignment.Center) { PlusIcon(TextSub, 22.dp) }
                if (input.isNotBlank() && !voiceMode) {
                    Spacer(Modifier.width(8.dp))
                    Box(modifier = Modifier.height(40.dp).clip(RoundedCornerShape(20.dp)).background(Accent).noRippleClick {
                        sendMsg("text", input.trim()); input = ""
                    }.padding(horizontal = 16.dp), contentAlignment = Alignment.Center) { Text(t("common.send"), color = Color.White, fontSize = 14.sp) }
                }
            }

            if (showEmoji) {
                EmojiPanel(
                    onEmoji = { input += it },
                    onDelete = { input = dropLastGrapheme(input) },
                    onKeyboard = { showEmoji = false; inputFocus.requestFocus(); keyboard?.show() },
                )
            }
        }
    }

    if (showAttach) {
        AttachSheet(
            // 视频通话仅男方可发起（女方只能接听）
            canVideoCall = true,
            onDismiss = { showAttach = false },
            onSend = { uris, caption -> sendImages(uris, caption) },
            onFiles = { sendFiles(it) },
            onAction = { a ->
                when (a) {
                    AttachAction.File -> {}
                    AttachAction.Location -> locPerm.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                    AttachAction.VoiceCall -> onCall(1)
                    AttachAction.VideoCall -> onCall(2)
                }
            },
        )
    }
    menuMsg?.let { m ->
        MsgMenuDialog(
            msgId = m.id, mine = m.senderId == myUserId,
            myReaction = m.reactions.firstOrNull { myUserId in it.userIds }?.emoji,
            pinned = pins.any { it.id == m.id },
            actions = menuActions(m),
        ) { menuMsg = null }
    }
    deleteIds?.let { ids ->
        DeleteMsgDialog(
            count = ids.size,
            canForAll = messages.filter { it.id in ids }.all { canDeleteForAll(it) },
            peerName = title,
            onConfirm = { forAll -> deleteIds = null; doDelete(ids, forAll) },
        ) { deleteIds = null }
    }
    forwardIds?.let { ids ->
        ForwardDialog(convId, ids, onDone = { tip, convIds ->
            forwardIds = null; selecting = null; toast(tip)
            if (convId in convIds) scope.launch { reloadMessages() }
        }) { forwardIds = null }
    }
    reportId?.let { id ->
        ReportMsgDialog(id, onDone = { tip -> reportId = null; toast(tip) }) { reportId = null }
    }
    fullImage?.let { u ->
        androidx.compose.ui.window.Dialog(onDismissRequest = { fullImage = null }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
            val imgs = messages.filter { it.type == "image" }.map { it.local ?: imageUrl(it.content) }
            ImageViewer(imgs.ifEmpty { listOf(u) }, imgs.indexOf(u).coerceAtLeast(0), onScanQr = handleScan) { fullImage = null }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun Bubble(
    m: MsgItem, mine: Boolean, myId: String,
    onImage: (String) -> Unit, onMenu: () -> Unit, onReact: (String) -> Unit, onJump: (String) -> Unit,
    /** 多图相册（第一张就是 m） */
    album: List<MsgItem>? = null,
    uploads: Map<String, UploadState> = emptyMap(),
    /** 相册里长按 / 回应的是哪一张 */
    onItemMenu: (MsgItem) -> Unit = {},
    onItemReact: (MsgItem, String) -> Unit = { _, _ -> },
    onRetry: (MsgItem) -> Unit = {},
) {
    val menu by rememberUpdatedState(onMenu)
    // 微信式：对方左侧灰气泡，自己右侧主题气泡，头像顶部对齐、贴边尾角
    val bubbleShape = if (mine) RoundedCornerShape(16.dp, 4.dp, 16.dp, 16.dp) else RoundedCornerShape(4.dp, 16.dp, 16.dp, 16.dp)
    val bg = if (mine) BubbleMine else Bg3
    // 浅色主题：自己的气泡是浅玫红底，文字同样用深色
    val fg = TextMain

    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Top) {
        if (!mine) { Avatar(m.senderAvatar, 38); Spacer(Modifier.width(8.dp)) }
        // 点 / 长按气泡弹消息菜单；图片、语音、链接各自的点击优先
        Column(
            horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = 240.dp).pointerInput(Unit) { detectTapGestures(onTap = { menu() }, onLongPress = { menu() }) },
        ) {
            if (!mine) Row(Modifier.padding(bottom = 2.dp, start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(m.senderNickname, color = TextSub, fontSize = 11.sp)
            }
            if (m.fwdFrom != null) Text(t("chat.forwardedFrom", "name" to m.fwdFrom), color = LinkBlue, fontSize = 11.sp, modifier = Modifier.padding(bottom = 2.dp, start = 4.dp, end = 4.dp))
            m.replyTo?.let { r -> ReplyQuote(r) { onJump(r.id) } }
            when (m.type) {
                "image" -> if (album != null) {
                    ImageAlbum(
                        cells = album.map { a ->
                            val meta = parseImage(a.content)
                            AlbumCell(a.upKey ?: a.id, imageModel(a.local, a.content), meta.w, meta.h, a.upKey?.let { uploads[it] }, a.pending)
                        },
                        width = 240.dp,
                        onTap = { i -> val a = album[i]; if (a.upKey == null || uploads[a.upKey] == null) onImage(a.local ?: imageUrl(a.content)) },
                        onLongPress = { i -> onItemMenu(album[i]) },
                        onRetry = { i -> onRetry(album[i]) },
                    )
                } else {
                    val meta = remember(m.content) { parseImage(m.content) }
                    val size = singleImageSize(meta.w, meta.h, 200.dp, 260.dp)
                    Box(Modifier.clip(RoundedCornerShape(10.dp))) {
                        AsyncImage(
                            model = imageModel(m.local, m.content), contentDescription = null,
                            contentScale = if (size != null) ContentScale.Crop else ContentScale.FillWidth,
                            modifier = (if (size != null) Modifier.size(size.first, size.second) else Modifier.widthIn(max = 160.dp))
                                .background(Bg3)
                                .combinedClickable(interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, indication = null, onLongClick = { menu() }) { onImage(m.local ?: imageUrl(m.content)) },
                        )
                        UploadOverlay(m.upKey?.let { uploads[it] }, m.pending, { onRetry(m) }, Modifier.matchParentSize())
                    }
                }
                "audio" -> {
                    val obj = runCatching { WsClient.json.parseToJsonElement(m.content).jsonObject }.getOrNull()
                    val url = obj?.get("url")?.jsonPrimitive?.content ?: m.content
                    val dur = (obj?.get("duration")?.jsonPrimitive?.content ?: "1").toIntOrNull() ?: 1
                    var voicePlaying by remember { mutableStateOf(false) }
                    Row(
                        modifier = Modifier.widthIn(min = 70.dp, max = (70 + dur * 8).coerceAtMost(220).dp).clip(bubbleShape).background(bg).combinedClickable(onLongClick = { menu() }) {
                            runCatching {
                                android.media.MediaPlayer().apply {
                                    setDataSource(Api.fullUrl(url))
                                    setOnCompletionListener { voicePlaying = false; it.release() }
                                    setOnErrorListener { mp, _, _ -> voicePlaying = false; mp.release(); true }
                                    prepare(); start()
                                    voicePlaying = true
                                }
                            }
                        }.padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (voicePlaying) PlayingVoiceBars(fg) else WaveformIcon(fg, 15.dp)
                        Spacer(Modifier.width(8.dp)); Text("${dur}\"", color = fg, fontSize = 14.sp)
                    }
                }
                "file" -> FileBubble(parseChatFile(m.content), m.upKey?.let { uploads[it] }, bg, bubbleShape, { onRetry(m) }, { menu() })
                "video" -> ChatVideoTile(m.content, m.upKey?.let { uploads[it] }, m.pending, { onRetry(m) }, { menu() })
                "location" -> {
                    val name = runCatching { WsClient.json.parseToJsonElement(m.content).jsonObject["name"]?.jsonPrimitive?.content }.getOrNull() ?: t("chat.location")
                    Row(modifier = Modifier.clip(bubbleShape).background(bg).padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        PinIcon(fg, 16.dp); Spacer(Modifier.width(8.dp)); Text(name, color = fg, fontSize = 14.sp)
                    }
                }
                "call" -> {
                    val obj = runCatching { WsClient.json.parseToJsonElement(m.content).jsonObject }.getOrNull()
                    val callType = obj?.get("callType")?.jsonPrimitive?.content?.toIntOrNull() ?: 1
                    val result = obj?.get("result")?.jsonPrimitive?.content ?: "end"
                    val dur = obj?.get("duration")?.jsonPrimitive?.content?.toIntOrNull() ?: 0
                    val label = if (callType == 2) t("chat.call.video") else t("chat.call.voice")
                    val text = when (result) {
                        "end" -> "$label %02d:%02d".format(dur / 60, dur % 60)
                        "reject" -> t("chat.call.rejected", "label" to label)
                        else -> t("chat.call.canceled", "label" to label)
                    }
                    Row(modifier = Modifier.clip(bubbleShape).background(bg).padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (callType == 2) VideoIcon(fg, 16.dp) else MicIcon(fg, 16.dp)
                        Spacer(Modifier.width(8.dp))
                        Text(text, color = fg, fontSize = 14.sp)
                    }
                }
                else -> Box(modifier = Modifier.clip(bubbleShape).background(bg).padding(horizontal = 14.dp, vertical = 10.dp)) { LinkText(m.content, color = fg, fontSize = 15.sp, lineHeight = 21.sp) }
            }
            if (album != null) {
                // 相册几张图的回应合在一起显示；点的是自己回应过的那张就取消那张的，否则回应第一张
                val merged = album.flatMap { it.reactions }.groupBy { it.emoji }
                    .map { (e, rs) -> MsgReaction(e, rs.sumOf { it.count }, rs.flatMap { it.userIds }) }
                ReactionChips(merged, myId) { e ->
                    onItemReact(album.firstOrNull { a -> a.reactions.any { it.emoji == e && myId in it.userIds } } ?: album[0], e)
                }
            } else ReactionChips(m.reactions, myId, onReact)
            val failed = (album ?: listOf(m)).any { a -> a.upKey?.let { uploads[it]?.failed } == true }
            if (failed) Text(t("chat.upload.failed"), color = Danger, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp, start = 4.dp, end = 4.dp))
        }
        if (mine) { Spacer(Modifier.width(8.dp)); Avatar(m.senderAvatar, 38) }
    }
}

/** 语音播放中的声条动画：三根声条循环跳动 */
@Composable
private fun PlayingVoiceBars(color: Color) {
    val transition = rememberInfiniteTransition(label = "voiceBars")
    val p by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(350), RepeatMode.Reverse),
        label = "voiceBarsP",
    )
    val bars = listOf(6f to 15f, 11f to 6f, 15f to 10f)
    Row(
        modifier = Modifier.size(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        bars.forEach { (a, b) ->
            Box(
                Modifier
                    .width(3.dp)
                    .height((a + (b - a) * p).dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(color),
            )
        }
    }
}

/** 简单的按住录音手势 */
private fun Modifier.pointerInputRecord(onStart: () -> Unit, onStop: () -> Unit): Modifier =
    this.pointerInput(Unit) {
        detectTapGestures(onPress = {
            onStart()
            tryAwaitRelease()
            onStop()
        })
    }

/**
 * 取当前位置后回调（地名 + 经纬度）。缓存的位置超过 10 分钟就现取一次（最多等 10 秒，取不到用旧的）；
 * 一个都没有就提示、不回调（以前会把「位置获取失败」和 0,0 当消息发出去）。
 */
@SuppressLint("MissingPermission")
internal fun sendLocation(ctx: Context, cb: (String, Double, Double) -> Unit) {
    val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val main = android.os.Handler(android.os.Looper.getMainLooper())
    fun done(loc: android.location.Location?) {
        if (loc == null) {
            android.widget.Toast.makeText(ctx, t("msg.locFailed"), android.widget.Toast.LENGTH_SHORT).show()
            return
        }
        // 地名：系统反查（部分国产机没有地理编码服务，就用「我的位置」）
        Thread {
            val name = runCatching {
                if (!android.location.Geocoder.isPresent()) return@runCatching null
                @Suppress("DEPRECATION")
                val a = android.location.Geocoder(ctx, java.util.Locale.getDefault()).getFromLocation(loc.latitude, loc.longitude, 1)?.firstOrNull()
                    ?: return@runCatching null
                listOfNotNull(a.locality ?: a.adminArea, a.subLocality, a.thoroughfare).distinct().joinToString(" ").ifBlank { null }
            }.getOrNull() ?: t("chat.myLocation")
            main.post { cb(name, loc.latitude, loc.longitude) }
        }.start()
    }
    val providers = listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
        .filter { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }
    val last = (providers + LocationManager.PASSIVE_PROVIDER).mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }.maxByOrNull { it.time }
    if (providers.isEmpty() || (last != null && System.currentTimeMillis() - last.time < 10 * 60_000)) return done(last)
    var finished = false
    val listener = object : android.location.LocationListener {
        override fun onLocationChanged(location: android.location.Location) {
            if (finished) return
            finished = true
            runCatching { lm.removeUpdates(this) }
            done(location)
        }
        // API 29 及以下这几个没有默认实现，不写会崩
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }
    android.widget.Toast.makeText(ctx, t("chat.locating"), android.widget.Toast.LENGTH_SHORT).show()
    runCatching { providers.forEach { lm.requestLocationUpdates(it, 0L, 0f, listener, android.os.Looper.getMainLooper()) } }
        .onFailure { return done(last) }
    main.postDelayed({
        if (!finished) {
            finished = true
            runCatching { lm.removeUpdates(listener) }
            done(last)
        }
    }, 10_000)
}
