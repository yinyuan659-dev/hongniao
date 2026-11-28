package com.wh.hongniang.ui.screen

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import coil.compose.AsyncImage
import com.wh.hongniang.net.Api
import com.wh.hongniang.net.WsClient
import com.wh.hongniang.ui.Avatar
import com.wh.hongniang.ui.NavBar
import com.wh.hongniang.ui.noRippleClick
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/*
 * 群聊在安卓端共用的类型、小零件和群资料页（样稿 design/12-group.html，用户 2026-11-27 过关）。
 * 对着网页端 web/src/group.tsx、pages/GroupInfo.tsx 写的，行为要和网页一致。
 * 规则都在后端（houduan/src/im/group.service.ts）：只有线路群和活动群，进群只能从「约单 / 参与」；只有群主和成员两种人。
 * 群的变化服务器都会推 { op: "group", data: { event, groupId, conversationId, group, userId?, nickname? } }，页面拿 group 直接改，不轮询。
 * 消息列表里群的那一行、群聊页在 ChatScreens.kt（单聊、群聊共用）。
 */

@Serializable
data class GroupMemberView(val id: String, val nickname: String = "", val avatar: String = "", val gender: Int = 0, val role: String = "member", val joinedAt: String = "")

/**
 * 群的信息。三个地方来的都用这一个类：
 *   消息列表（GET /im/conversations 群那一行的 group）：带 state、role，不带公告和成员；
 *   群资料（GET /im/group/:id）：全都带；
 *   推送（op: "group" 里的 group）：只有群本身的信息，不带 state / role / muted / members（见 [merged]）。
 */
@Serializable
data class GroupInfo(
    val id: String,
    val name: String = "",
    val avatar: String = "",
    /** trip 旅行线路的群 | event 相亲活动的群 | test 后台建的测试群 */
    val kind: String = "test",
    val refId: String = "0",
    val ownerId: String = "",
    /** 0 正常 1 已解散 2 被平台关闭 */
    val status: Int = 0,
    val memberCount: Int = 0,
    val memberLimit: Int = 0,
    val notice: String = "",
    val conversationId: String? = null,
    /** 活动开始 / 行程结束的时间；过了以后提示「N 天后自动解散」 */
    val endAt: String? = null,
    val expireAt: String? = null,
    /** 我和这个群的关系：ok 正常 | left 我退出了 | kicked 我被移出了 | dissolved 群解散了 | closed 群被平台关闭 */
    val state: String = "ok",
    /** owner 群主 | member 成员 */
    val role: String = "member",
    val muted: Boolean = false,
    /** 群主排第一；已经不在群里的人拿到的是空名单 */
    val members: List<GroupMemberView> = emptyList(),
)

/** 推送来的 { op: "group" } 帧里的 data */
@Serializable
data class GroupEvent(
    /** create / join / leave / kick / info / dissolved / closed / reopen */
    val event: String = "",
    val groupId: String = "",
    val conversationId: String? = null,
    val group: GroupInfo,
    /** 进群 / 退群 / 被移出的是谁 */
    val userId: String? = null,
    val nickname: String? = null,
)

/** 从 WebSocket 帧里取出群的推送；不是这种帧或者格式不对返回 null */
fun groupEventOf(frame: JsonObject): GroupEvent? =
    runCatching { Api.json.decodeFromJsonElement(GroupEvent.serializer(), frame["data"]!!) }.getOrNull()

/** 群主在这种群里叫什么 */
fun ownerLabel(kind: String): String = when (kind) { "trip" -> "领队"; "event" -> "发起人"; else -> "群主" }

/** 群名后面的小标签 */
fun kindLabel(kind: String): String = when (kind) { "trip" -> "旅行"; "event" -> "活动"; else -> "测试" }

/** 群里中间那行灰色小字（消息类型 sys，内容是 {k, text}） */
fun sysText(content: String): String =
    runCatching { Api.json.parseToJsonElement(content).jsonObject["text"]?.jsonPrimitive?.content }.getOrNull().orEmpty()

/** 群用不了时，输入框换成的那句话 */
fun groupEndText(state: String): String = when (state) {
    "dissolved" -> "这个群已解散"
    "closed" -> "这个群因违规已被平台关闭"
    else -> "你已不在这个群里"
}

/** 服务器拒绝时带的原因（error 帧的 code、接口报错的 reason）→ 群的状态；不是群的原因返回 null */
fun groupReasonState(code: String?): String? = when (code) {
    "group_left" -> "left"
    "group_dissolved" -> "dissolved"
    "group_closed" -> "closed"
    else -> null
}

/** 推送里的群信息 + 这件事说的是不是我 → 我现在的状态（推送里的 group 不带 state，要自己算） */
fun stateAfter(ev: GroupEvent, myId: String, prev: String?): String {
    val byStatus = when (ev.group.status) { 1 -> "dissolved"; 2 -> "closed"; else -> "ok" }
    if (!ev.userId.isNullOrEmpty() && ev.userId == myId) {
        when (ev.event) {
            "leave" -> return "left"
            "kick" -> return "kicked"
            "join" -> return byStatus
        }
    }
    if (prev == "left" || prev == "kicked") return prev
    return byStatus
}

/** 把推送里的群信息盖到现有的上面：我的状态自己算；我的身份、免打扰、成员名单推送里没有，留着原来的 */
fun GroupInfo.merged(ev: GroupEvent, myId: String): GroupInfo =
    ev.group.copy(state = stateAfter(ev, myId, state), role = role, muted = muted, members = members)

/** 活动 / 行程已经结束、群还没解散的那几天，输入框上面的提示。不用提示时返回 null */
fun expireTip(g: GroupInfo, now: Long = System.currentTimeMillis()): String? {
    val end = parseIso(g.endAt)?.toEpochMilli() ?: return null
    val left = (parseIso(g.expireAt)?.toEpochMilli() ?: return null) - now
    if (end > now || left <= 0) return null
    val head = when (g.kind) { "trip" -> "行程已结束"; "event" -> "活动已结束"; else -> "已到结束时间" }
    val after = when {
        left >= 86_400_000L -> " ${(left + 86_399_999L) / 86_400_000L} 天后"
        left >= 3_600_000L -> " ${(left + 3_599_999L) / 3_600_000L} 小时后"
        else -> "不到 1 小时后"
    }
    return "$head，这个群${after}自动解散"
}

// ---------- 小零件 ----------

private val AVATAR_TRIP = Brush.verticalGradient(0f to Color(0xFF3D6B8F), 0.38f to Color(0xFF7FA7B8), 0.7f to Color(0xFFD9C7A3), 1f to Color(0xFF8A6A4A))
private val AVATAR_EVENT = Brush.verticalGradient(0f to Color(0xFF2F5D50), 0.55f to Color(0xFF6FA07A), 1f to Color(0xFFCFE3B4))
private val AVATAR_TEST = Brush.verticalGradient(listOf(Color(0xFF6B6F8F), Color(0xFFA9ADC8)))

// 和网页（hn.tsx 的 Ic）同一套线条图标；圆写成了等价的路径。internal：单元测试 GroupIconPathTest 要检查这些路径解析得出来
internal val IC_CAR = listOf(
    "M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2",
    "M5 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
    "M9 17h6",
    "M15 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
)
internal val IC_LEAF = listOf(
    "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z",
    "M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12",
)
internal val IC_USERS = listOf(
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
)

/** 群头像：方的圆角（人是圆的，一眼分得出）。有封面用封面，没有按类型画一个默认的 */
@Composable
fun GroupAvatar(avatar: String?, kind: String, size: Int = 54, modifier: Modifier = Modifier) {
    val brush = when (kind) { "trip" -> AVATAR_TRIP; "event" -> AVATAR_EVENT; else -> AVATAR_TEST }
    Box(modifier.size(size.dp).clip(RoundedCornerShape((size * 0.3f).dp)).background(brush), contentAlignment = Alignment.Center) {
        if (!avatar.isNullOrEmpty()) {
            AsyncImage(model = Api.fullUrl(avatar), contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        } else {
            LineIcon(when (kind) { "trip" -> IC_CAR; "event" -> IC_LEAF; else -> IC_USERS }, Color.White, (size * 0.44f).dp)
        }
    }
}

/** 群名后面的「旅行 / 活动」小标签 */
@Composable
fun KindTag(kind: String, modifier: Modifier = Modifier) {
    val (bg, fg) = when (kind) {
        "trip" -> Color(0xFFE6F0F7) to Color(0xFF2F6690)
        "event" -> Color(0xFFE5F4E8) to Color(0xFF2F7D4A)
        else -> Color(0xFFEEEEF3) to Color(0xFF6B6F8F)
    }
    // 行高要自己写：不写会用主题默认的 24，胶囊就撑得很高
    Text(
        kindLabel(kind), color = fg, fontSize = 10.5.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
        modifier = modifier.clip(RoundedCornerShape(9.dp)).background(bg).padding(horizontal = 7.dp),
    )
}

/** 昵称后面的红色小标：领队 / 发起人 */
@Composable
fun OwnerBadge(kind: String, modifier: Modifier = Modifier) {
    Text(
        ownerLabel(kind), color = Color.White, fontSize = 10.sp, lineHeight = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1,
        modifier = modifier.clip(RoundedCornerShape(7.dp)).background(HnRose).padding(horizontal = 5.dp),
    )
}

/** 群用不了了（我退出了 / 被移出了 / 群解散了 / 被平台关闭）：输入区换成一句话，没有别的按钮；之前的聊天记录照常能看 */
@Composable
fun GroupEndBar(state: String) {
    Column(
        Modifier.fillMaxWidth().background(Color(0xFFF7F4F5)).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(groupEndText(state), color = HnInk2, fontSize = 14.sp, textAlign = TextAlign.Center)
        if (state == "left" || state == "kicked") {
            Text("之前的聊天记录还能看", color = HnInk3, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
        }
    }
}

/** 活动 / 行程已经结束、群还没解散的那几天：输入框上面一条提示，照常能发 */
@Composable
fun GroupExpireTip(text: String) {
    Text(
        text, color = Color(0xFF9A5B00), fontSize = 12.5.sp, lineHeight = 18.sp, textAlign = TextAlign.Center,
        modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp).fillMaxWidth()
            .clip(RoundedCornerShape(14.dp)).background(Color(0xFFFFF4D9)).padding(horizontal = 14.dp, vertical = 8.dp),
    )
}

// ---------- 群资料页 ----------

/** 成员先显示两行（一行 5 个），多了点「全部」展开 */
private const val FOLD = 10
private val GroupRed = Color(0xFFF04438)

private class GroupConfirm(val title: String, val body: String, val ok: String, val run: () -> Unit)

/**
 * 群资料（样稿 design/12-group.html 第 2 组）。
 * 普通成员：成员、群公告（只能看）、消息免打扰、举报这个群、退出群聊。
 * 群主（线路群是领队，活动群是发起人）：多了改群名、写群公告、移出成员；最下面是「解散群聊」。群主不能退群、不能转让、不能拉人。
 * 群已经用不了的（解散了 / 被关闭 / 我不在了）：只剩「从消息列表里删除」。
 * 页面上的内容靠推送（op: "group"）更新：有人进出、群名公告改了、解散了，不用刷新。
 *
 * onExit：退出了 / 从列表里删掉了这个群 → 回到消息列表。
 */
@Composable
fun GroupInfoScreen(groupId: String, myUserId: String, onBack: () -> Unit, onNav: (String) -> Unit, onExit: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var g by remember { mutableStateOf<GroupInfo?>(null) }
    var err by remember { mutableStateOf("") }
    var all by remember { mutableStateOf(false) }
    /** 群主点了「移出」：成员头像上出现红色的减号，点谁移出谁 */
    var removing by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<GroupConfirm?>(null) }
    /** 正在改哪一项：name 群名 | notice 群公告，和改到一半的内容 */
    var edit by remember { mutableStateOf<Pair<String, String>?>(null) }
    var reporting by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    fun toast(msg: String) = Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()

    suspend fun load() {
        runCatching { Api.getObj<GroupInfo>("/im/group/$groupId") }
            .onSuccess { g = it; err = "" }
            .onFailure { err = it.message ?: "打不开这个群" }
    }

    /** 做一件要问服务器的事：同一时间只做一件；done 是做成以后的提示 */
    fun act(done: String? = null, block: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            runCatching { block() }
                .onSuccess { if (done != null) toast(done) }
                .onFailure { toast(it.message ?: "操作失败") }
            busy = false
        }
    }

    LaunchedEffect(groupId) {
        load()
        WsClient.connect()
    }
    DisposableEffect(groupId) {
        val remove = WsClient.addListener { frame ->
            when (frame["op"]?.jsonPrimitive?.content) {
                // 断线后重新连上：断线那段时间的变化没收到，补拉一次
                "ws_reopen" -> scope.launch { load() }
                "group" -> {
                    val ev = groupEventOf(frame) ?: return@addListener
                    if (ev.groupId != groupId) return@addListener
                    val prev = g ?: return@addListener
                    // 群名、公告、人数、解散 / 关闭：推送里直接带着，马上改
                    var next = prev.merged(ev, myUserId)
                    // 有人退了 / 被移出了：从名单里拿掉；我自己不在了：名单清空
                    if ((ev.event == "leave" || ev.event == "kick") && !ev.userId.isNullOrEmpty()) {
                        next = next.copy(members = if (ev.userId == myUserId) emptyList() else next.members.filterNot { it.id == ev.userId })
                    }
                    g = next
                    // 有人进群：推送里只有 id 和昵称，头像要重新拿一次名单
                    if (ev.event == "join") scope.launch { load() }
                }
            }
        }
        onDispose { remove() }
    }

    val cur = g
    Column(Modifier.fillMaxSize().background(Color(0xFFFBF7F5))) {
        NavBar("群资料", onBack)
        if (cur == null) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 80.dp), contentAlignment = Alignment.Center) {
                Text(err.ifEmpty { "加载中…" }, color = HnInk2, fontSize = 14.sp, textAlign = TextAlign.Center)
            }
        } else {
            val owner = cur.role == "owner"
            val gone = cur.state != "ok"
            val shown = if (all) cur.members else cur.members.take(FOLD)
            val ownerName = cur.members.firstOrNull { it.role == "owner" }?.nickname
            /** 群主才有、群里除了自己还有别人时才有的「移出」那一格 */
            val canRemove = owner && !gone && cur.members.size > 1
            val removingNow = removing && canRemove

            fun kick(m: GroupMemberView) {
                confirm = GroupConfirm("把 ${m.nickname} 移出群聊？", "移出以后，TA 不能自己再进这个群。", "移出") {
                    act("已把 ${m.nickname} 移出") {
                        Api.request("/im/group/$groupId/kick", "POST", buildJsonObject { put("userId", JsonPrimitive(m.id)) })
                        // 人数、名单以服务器为准：正常情况下推送已经先到了；这里再拿一次，推送万一没到也不会错
                        g = g?.let { it.copy(members = it.members.filterNot { x -> x.id == m.id }) }
                        load()
                    }
                }
            }

            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 28.dp)) {
                // 这个群是什么
                GroupCard(top = 2) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        GroupAvatar(cur.avatar, cur.kind, 52)
                        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                            Text(cur.name, color = HnInk, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                if (gone) groupEndText(cur.state)
                                else "${cur.memberCount} 人 · " + if (owner) "我是${ownerLabel(cur.kind)}" else ownerLabel(cur.kind) + if (ownerName.isNullOrEmpty()) "" else " $ownerName",
                                color = HnInk2, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp),
                            )
                        }
                        KindTag(cur.kind)
                    }
                }

                // 群成员：一行 5 个；群主最后多一格「移出」
                if (cur.members.isNotEmpty()) GroupCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("群成员", color = HnInk, fontSize = 14.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.weight(1f))
                        if (cur.members.size > FOLD) {
                            Text(if (all) "收起" else "全部 ${cur.memberCount} 人 ›", color = HnInk3, fontSize = 12.sp, modifier = Modifier.noRippleClick { all = !all })
                        }
                    }
                    val cells: List<GroupMemberView?> = if (canRemove) shown + listOf<GroupMemberView?>(null) else shown
                    cells.chunked(5).forEach { row ->
                        Row(Modifier.fillMaxWidth().padding(top = 12.dp)) {
                            row.forEach { m ->
                                Box(Modifier.weight(1f), contentAlignment = Alignment.TopCenter) {
                                    if (m == null) {
                                        RemoveTile(removingNow) { removing = !removingNow; all = true }
                                    } else {
                                        val canKick = removingNow && m.role != "owner"
                                        MemberTile(m, cur.kind, isMe = m.id == myUserId, dim = removingNow && !canKick, minus = canKick) {
                                            if (canKick) kick(m) else if (!removingNow) onNav("u/${m.id}")
                                        }
                                    }
                                }
                            }
                            repeat(5 - row.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                    if (removingNow) {
                        Text(
                            "点要移出的人。被移出的人不能自己再进这个群。", color = HnInk3, fontSize = 12.sp, textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                        )
                    }
                }

                // 群公告：只有群主能写
                if (cur.notice.isNotEmpty() || (owner && !gone)) GroupCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("群公告", color = HnInk, fontSize = 14.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.weight(1f))
                        if (owner && !gone) {
                            Text("编辑", color = HnRose, fontSize = 12.5.sp, fontWeight = FontWeight.Bold, modifier = Modifier.noRippleClick { edit = "notice" to cur.notice })
                        }
                    }
                    Text(
                        cur.notice.ifEmpty { "还没有写群公告" }, color = if (cur.notice.isEmpty()) HnInk3 else Color(0xFF4B3D43),
                        fontSize = 13.sp, lineHeight = 22.sp, modifier = Modifier.padding(top = 5.dp),
                    )
                }

                if (!gone) GroupCard(padded = false) {
                    if (owner) {
                        GroupRow("群名", onClick = { edit = "name" to cur.name }) {
                            Text(cur.name, color = HnInk3, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            Box(Modifier.padding(start = 3.dp)) { LineIcon(IC_CHEVRON, HnInk3, 15.dp) }
                        }
                        Box(Modifier.fillMaxWidth().height(1.dp).background(HnLine))
                    }
                    GroupRow("消息免打扰") {
                        androidx.compose.material3.Switch(
                            checked = cur.muted,
                            onCheckedChange = { on ->
                                act {
                                    // 开关先变，服务器没答应再变回去
                                    g = g?.copy(muted = on)
                                    try {
                                        val r = Api.request("/im/group/$groupId/mute", "POST", buildJsonObject { put("muted", JsonPrimitive(on)) })
                                        val muted = (r as? JsonObject)?.get("muted")?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: on
                                        g = g?.copy(muted = muted)
                                    } catch (e: Exception) {
                                        g = g?.copy(muted = !on)
                                        throw e
                                    }
                                }
                            },
                            colors = androidx.compose.material3.SwitchDefaults.colors(
                                checkedTrackColor = HnRose, uncheckedTrackColor = Color(0xFFE9E3E5),
                                uncheckedThumbColor = Color.White, uncheckedBorderColor = Color.Transparent,
                            ),
                        )
                    }
                    if (!owner) {
                        Box(Modifier.fillMaxWidth().height(1.dp).background(HnLine))
                        GroupRow("举报这个群", onClick = { reporting = true }) { LineIcon(IC_CHEVRON, HnInk3, 15.dp) }
                    }
                }

                // 最下面那个红字按钮：成员是「退出群聊」，群主是「解散群聊」；群已经用不了的是「从消息列表里删除」
                val shape = RoundedCornerShape(18.dp)
                Box(
                    Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp).fillMaxWidth().height(48.dp)
                        .shadow(2.dp, shape, ambientColor = HnInk3, spotColor = HnInk3).clip(shape).background(Color.White)
                        .clickable {
                            confirm = when {
                                gone -> GroupConfirm("从消息列表里删除？", "只是从你自己的消息列表里删掉，删了以后这个群的聊天记录就看不到了。", "删除") {
                                    act {
                                        Api.request("/im/group/$groupId/hide", "POST")
                                        onExit()
                                    }
                                }
                                owner -> GroupConfirm("解散群聊？", "解散以后所有人都不能再发消息，之前的聊天记录还能看。解散了不能恢复。", "解散") {
                                    act("群聊已解散") {
                                        Api.request("/im/group/$groupId/dissolve", "POST")
                                        load()
                                    }
                                }
                                else -> GroupConfirm("退出群聊？", "退出以后不会再收到这个群的消息。之后还想进，回到线路 / 活动页重新点「约单 / 参与」。", "退出") {
                                    act {
                                        Api.request("/im/group/$groupId/leave", "POST")
                                        onExit()
                                    }
                                }
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(if (gone) "从消息列表里删除" else if (owner) "解散群聊" else "退出群聊", color = GroupRed, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                }
                if (!gone && !owner) {
                    Text(
                        "线下见面前不要转账；遇到借钱、投资、推销的，直接举报。", color = HnInk3, fontSize = 12.sp, lineHeight = 20.sp, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 12.dp),
                    )
                }
            }
        }
    }

    confirm?.let { c ->
        Dialog(onDismissRequest = { confirm = null }) {
            Column(Modifier.clip(RoundedCornerShape(24.dp)).background(Color.White).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(c.title, color = HnInk, fontSize = 16.5.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center)
                Text(c.body, color = HnInk2, fontSize = 13.5.sp, lineHeight = 22.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
                Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    HnButton("取消", Modifier.weight(1f), ghost = true, height = 44.dp) { confirm = null }
                    HnButton(c.ok, Modifier.weight(1f), height = 44.dp) { confirm = null; c.run() }
                }
            }
        }
    }

    edit?.let { (field, value) ->
        val isName = field == "name"
        Dialog(onDismissRequest = { edit = null }) {
            Column(Modifier.clip(RoundedCornerShape(24.dp)).background(Color.White).padding(20.dp)) {
                Text(if (isName) "修改群名" else "群公告", color = HnInk, fontSize = 16.5.sp, fontWeight = FontWeight.ExtraBold)
                Box(
                    Modifier.padding(top = 12.dp).fillMaxWidth().heightIn(min = if (isName) 46.dp else 130.dp, max = 260.dp)
                        .clip(RoundedCornerShape(14.dp)).background(Color(0xFFFAF6F6)).padding(horizontal = 14.dp, vertical = 12.dp),
                ) {
                    if (value.isEmpty()) {
                        Text(if (isName) "群名（最多 30 个字）" else "集合时间地点、要带什么、注意事项…（最多 500 个字）", color = HnInk3, fontSize = 15.sp, lineHeight = 22.sp)
                    }
                    BasicTextField(
                        value = value,
                        onValueChange = { v -> edit = field to (if (isName) v.replace("\n", "").take(30) else v.take(500)) },
                        singleLine = isName,
                        textStyle = TextStyle(color = HnInk, fontSize = 15.sp, lineHeight = 22.sp),
                        cursorBrush = SolidColor(HnRose),
                        modifier = Modifier.fillMaxWidth().then(if (isName) Modifier else Modifier.verticalScroll(rememberScrollState())),
                    )
                }
                Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    HnButton("取消", Modifier.weight(1f), ghost = true, height = 44.dp) { edit = null }
                    HnButton("保存", Modifier.weight(1f), enabled = !busy && !(isName && value.isBlank()), height = 44.dp) {
                        act(if (isName) "群名已修改" else "群公告已更新") {
                            val r = Api.request("/im/group/$groupId/update", "POST", buildJsonObject { put(field, JsonPrimitive(value)) })
                            g = Api.json.decodeFromJsonElement(GroupInfo.serializer(), r!!)
                            edit = null
                        }
                    }
                }
            }
        }
    }

    if (reporting) {
        ReportMsgDialog("", groupId = groupId, onDone = { tip -> reporting = false; toast(tip) }) { reporting = false }
    }
}

/** 群资料页的白色圆角卡片 */
@Composable
private fun GroupCard(top: Int = 10, padded: Boolean = true, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(18.dp)
    Column(
        Modifier.padding(start = 16.dp, end = 16.dp, top = top.dp).fillMaxWidth()
            .shadow(2.dp, shape, ambientColor = HnInk3, spotColor = HnInk3).clip(shape).background(Color.White)
            .then(if (padded) Modifier.padding(horizontal = 15.dp, vertical = 13.dp) else Modifier),
        content = content,
    )
}

/** 卡片里的一行：左边名字，右边的东西靠右（值和箭头 / 开关） */
@Composable
private fun GroupRow(label: String, onClick: (() -> Unit)? = null, trailing: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .heightIn(min = 50.dp).padding(horizontal = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = HnInk, fontSize = 14.5.sp, maxLines = 1)
        Row(Modifier.weight(1f).padding(start = 10.dp), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically, content = trailing)
    }
}

/** 成员名单里的一个人：头像 + 昵称；群主头像下面压着「领队 / 发起人」；minus = 右上角的红色减号（点了移出） */
@Composable
private fun MemberTile(m: GroupMemberView, kind: String, isMe: Boolean, dim: Boolean, minus: Boolean, onClick: () -> Unit) {
    Column(Modifier.noRippleClick(onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(width = 56.dp, height = 52.dp), contentAlignment = Alignment.TopCenter) {
            Box(
                Modifier.alpha(if (dim) 0.45f else 1f).size(44.dp).shadow(2.dp, CircleShape, ambientColor = HnInk3, spotColor = HnInk3)
                    .clip(CircleShape).background(Color.White).padding(2.dp),
            ) { Avatar(m.avatar, 40) }
            if (m.role == "owner") OwnerBadge(kind, Modifier.align(Alignment.BottomCenter).border(1.5.dp, Color.White, RoundedCornerShape(7.dp)))
            if (minus) {
                Box(
                    Modifier.align(Alignment.TopEnd).size(18.dp).clip(CircleShape).background(GroupRed).border(1.5.dp, Color.White, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Box(Modifier.size(width = 8.dp, height = 2.dp).background(Color.White)) }
            }
        }
        Text(
            if (isMe) "我" else m.nickname, color = HnInk2, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
            modifier = Modifier.padding(start = 2.dp, end = 2.dp, top = 3.dp),
        )
    }
}

/** 群主名单最后的那一格：点了进入「移出」状态，再点一下是「完成」 */
@Composable
private fun RemoveTile(removing: Boolean, onClick: () -> Unit) {
    Column(Modifier.noRippleClick(onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(width = 56.dp, height = 52.dp), contentAlignment = Alignment.TopCenter) {
            Box(
                Modifier.size(44.dp).clip(CircleShape).background(Color.White).drawBehind {
                    val w = 1.5.dp.toPx()
                    drawCircle(
                        Color(0xFFF7A8A2), radius = size.minDimension / 2 - w / 2,
                        style = Stroke(width = w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))),
                    )
                },
                contentAlignment = Alignment.Center,
            ) {
                if (removing) Text("✓", color = GroupRed, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                else Box(Modifier.size(width = 14.dp, height = 2.dp).background(GroupRed))
            }
        }
        Text(if (removing) "完成" else "移出", color = GroupRed, fontSize = 11.sp, maxLines = 1, modifier = Modifier.padding(top = 3.dp))
    }
}
