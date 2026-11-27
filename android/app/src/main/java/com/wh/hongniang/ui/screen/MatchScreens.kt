package com.wh.hongniang.ui.screen

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.hongniang.net.Api
import com.wh.hongniang.net.ApiException
import com.wh.hongniang.ui.noRippleClick
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/*
 * 模块三、四：每日推荐、喜欢 / 跳过、互相喜欢。样稿 design/03-match.html；
 * 2026-11-27 起发消息、语音放开，只有视频见面要互相喜欢（样稿 design/09-openchat.html）。
 * 分法（用户 2026-11-23 定的）：
 *   原生 —— 广场 → 遇见 →「推荐」（RecSection）、消息页顶上的三个数字（LikeEntries）、聊天页的提示条和不能发的说明、互相喜欢的庆祝页（MatchCelebration）；
 *   网页 —— 画像网页底部的喜欢 / 跳过按钮、喜欢列表（/likes），用 HnWebScreen 打开。
 * 「没有互相喜欢不能视频」「不再联系后不能发消息」都是服务器强制的，这里只负责把话说清楚。
 */

// ---------- 接口返回的数据 ----------

/** 在遇见 / 别人的画像里自己点喜欢的名额（每日推荐里的、回应对方喜欢的不占） */
@Serializable
data class MatchQuota(val limit: Int = 3, val used: Int = 0, val left: Int = 3)

@Serializable
data class MatchPeer(val id: String = "", val nickname: String = "", val avatar: String = "", val gender: Int = 0, val age: Int = 0, val cityName: String = "")

/** 每日推荐里的一位 */
@Serializable
data class RecItem(
    val user: MatchPeer = MatchPeer(),
    /** 照片下面的小标签：城市、身高、学历、职业 */
    val chips: List<String> = emptyList(),
    /** 共同点 */
    val tags: List<String> = emptyList(),
    /** AI 写的推荐理由；空 = 没写成（没有余额也没有 Key），只显示共同点 */
    val reason: String = "",
    /** none 还没表态 | liked | passed | mutual */
    val state: String = "none",
    val likedMe: Boolean = false,
)

@Serializable
data class MatchToday(
    /** 我的基本情况填完了没有 */
    val ready: Boolean = false,
    /** 下一批什么时候来（ISO 时间） */
    val nextAt: String = "",
    val limit: Int = 3,
    val quota: MatchQuota = MatchQuota(),
    val likedMe: Int = 0,
    val list: List<RecItem> = emptyList(),
)

@Serializable
data class NewMatch(val peer: MatchPeer = MatchPeer(), val conversationId: String = "")

/** 消息页顶上的三个数字 + 还没看过的互相喜欢 */
@Serializable
data class MatchSummary(
    val likedMe: Int = 0,
    val likedMeNew: Int = 0,
    val liked: Int = 0,
    val mutual: Int = 0,
    val newMatches: List<NewMatch> = emptyList(),
    val quota: MatchQuota = MatchQuota(),
    val ready: Boolean = false,
)

/** 我和某个人的关系 */
@Serializable
data class MatchRelation(
    /** none 都没表态 | liked 我喜欢了 | likedMe 对方先喜欢了我 | mutual 互相喜欢 | ended 有一方结束了联系 */
    val state: String = "none",
    val endedBy: String? = null,
    val matchedAt: String? = null,
    /** 现在能不能发消息、打语音：2026-11-27 起只有一方点了「不再联系」才不能 */
    val canChat: Boolean = true,
    /** open 还没互相喜欢，照常能聊 | mutual 互相喜欢 | ended_me | ended_peer */
    val chatReason: String = "open",
    /** 按「互相喜欢」这一条现在能不能视频见面（后台开关关着时没互相喜欢也是 true）。只用来参考，真正放不放行在发起通话时由服务器决定 */
    val canVideo: Boolean = true,
    /** ok | need_like | ended */
    val videoReason: String = "ok",
    /** 以前「老聊天保留期」用的，现在一直是 null */
    val legacyUntil: String? = null,
    val quota: MatchQuota = MatchQuota(),
)

@Serializable
data class LikeResult(
    val state: String = "liked",
    val matched: Boolean = false,
    val peer: MatchPeer = MatchPeer(),
    val conversationId: String? = null,
    val quota: MatchQuota = MatchQuota(),
)

@Serializable
private data class IceResp(val lines: List<String> = emptyList())

private suspend inline fun <reified T> postObj(path: String): T =
    Api.json.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), Api.request(path, "POST")!!)

/** ISO 时间 → 「11 月 23 日」 */
fun matchDayText(iso: String?): String {
    val t = runCatching { java.time.Instant.parse(iso).atZone(java.time.ZoneId.systemDefault()) }.getOrNull() ?: return ""
    return "${t.monthValue} 月 ${t.dayOfMonth} 日"
}

/** 下一批推荐什么时候来：「今天上午 10 点」/「明天上午 10 点」 */
private fun nextText(iso: String): String {
    val zone = java.time.ZoneId.systemDefault()
    val t = runCatching { java.time.Instant.parse(iso).atZone(zone) }.getOrNull() ?: return "明天上午 10 点"
    return (if (t.toLocalDate() == java.time.LocalDate.now(zone)) "今天" else "明天") + "上午 ${t.hour} 点"
}

// ---------- 全局：庆祝页、数字刷新 ----------

object MatchCenter {
    /** 不是 null 就弹出庆祝页（AppRoot 最上层画） */
    var celebrate by mutableStateOf<NewMatch?>(null)

    /** 喜欢相关的事有变化（有人喜欢我、互相喜欢、对方结束聊天、我点了喜欢）就加一：消息页的数字、底栏角标、推荐页看到它变了就重新取 */
    var version by mutableIntStateOf(0)

    fun show(peer: MatchPeer, conversationId: String) {
        celebrate = NewMatch(peer, conversationId)
        version++
    }

    /** 对方回了我的喜欢（服务器推了一条消息，或者我刚打开 App）：有没看过的互相喜欢就弹出来 */
    suspend fun checkNew() {
        runCatching { Api.getObj<MatchSummary>("/match/summary") }.onSuccess { s ->
            if (celebrate == null) s.newMatches.firstOrNull()?.let { celebrate = it }
        }
        version++
    }

    /** 点喜欢。对方早就喜欢我了 → 当场互相喜欢，顺手弹庆祝页。失败抛 ApiException（reason: need_profile / like_quota） */
    suspend fun like(userId: String): LikeResult {
        val r = postObj<LikeResult>("/match/like/$userId")
        if (r.matched && r.conversationId != null) show(r.peer, r.conversationId) else version++
        return r
    }
}

/** 没填完基本情况的人点了「喜欢」 */
@Composable
fun NeedFillDialog(onDismiss: () -> Unit, onGo: () -> Unit) {
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.clip(RoundedCornerShape(24.dp)).background(Color.White).padding(20.dp)) {
            Text("先把基本情况填完", color = HnInk, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold)
            Text("填完才能喜欢别人，别人也才能在推荐里看到你。", color = HnInk2, fontSize = 13.sp, lineHeight = 21.sp, modifier = Modifier.padding(top = 6.dp))
            Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                HnButton("以后再说", Modifier.weight(1f), ghost = true, height = 44.dp, onClick = onDismiss)
                HnButton("去填写", Modifier.weight(1.3f), height = 44.dp, onClick = onGo)
            }
        }
    }
}

/**
 * 点喜欢的统一处理：成功返回结果；失败时没填完基本情况的弹框带去填，其它的弹一句提示，返回 null。
 * 用法：val liker = rememberLiker(onNav); liker.like(id) { r -> … }; liker.Dialogs()
 */
class Liker internal constructor(
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val ctx: android.content.Context,
    private val onNav: (String) -> Unit,
) {
    var busy by mutableStateOf(false)
        private set
    private var needFill by mutableStateOf(false)

    fun like(userId: String, onDone: (LikeResult) -> Unit = {}) {
        if (busy) return
        busy = true
        scope.launch {
            runCatching { MatchCenter.like(userId) }
                .onSuccess(onDone)
                .onFailure { e ->
                    if ((e as? ApiException)?.reason == "need_profile") needFill = true
                    else android.widget.Toast.makeText(ctx, e.message ?: "操作失败", android.widget.Toast.LENGTH_SHORT).show()
                }
            busy = false
        }
    }

    @Composable
    fun Dialogs() {
        if (needFill) NeedFillDialog(onDismiss = { needFill = false }, onGo = { needFill = false; onNav("interview") })
    }
}

@Composable
fun rememberLiker(onNav: (String) -> Unit): Liker {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    return remember { Liker(scope, ctx, onNav) }
}

// ---------- 广场 → 遇见 → 推荐 ----------

/** 推荐页的进程级缓存：切走再回来先显示上次的，不闪 */
private object RecCache {
    var today: MatchToday? = null
}

/**
 * 每日推荐：每天几位（默认 3 位），一次看一位，喜欢或跳过后换下一位。
 * onOpenUser 打开对方的画像网页；onBrowse 切到旁边的「所有」。
 */
@Composable
fun RecSection(onOpenUser: (String) -> Unit, onNav: (String) -> Unit, onBrowse: () -> Unit) {
    var d by remember { mutableStateOf(RecCache.today) }
    var err by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val liker = rememberLiker(onNav)

    // 进来取一次；从别人的画像网页回来（在那里可能点了喜欢 / 跳过）、填完资料回来、喜欢相关的事有变化，都重新取
    LaunchedEffect(MatchCenter.version, HnEvents.version) {
        runCatching { Api.getObj<MatchToday>("/match/today") }
            .onSuccess { d = it; RecCache.today = it; err = "" }
            .onFailure { if (d == null) err = it.message ?: "加载失败" }
    }

    val today = d
    if (today == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(err.ifEmpty { "正在为你挑人…" }, color = HnInk2, fontSize = 14.sp) }
        return
    }

    fun setState(id: String, state: String) {
        val next = today.copy(list = today.list.map { if (it.user.id == id) it.copy(state = state) else it })
        d = next
        RecCache.today = next
    }

    val left = today.list.filter { it.state == "none" }
    val cur = left.firstOrNull()

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 20.dp)) {
        when {
            // 基本情况没填完：不给推荐
            !today.ready -> RecCenter("先把基本情况填完", "填完才能给你推荐，\n别人也才能在推荐里看到你。") {
                HnButton("去填写", Modifier.padding(top = 22.dp).width(200.dp)) { onNav("interview") }
            }
            // 一个条件对得上的人都没有：如实说
            today.list.isEmpty() -> {
                RecCenter("现在还没有合适的人", "条件和你互相符合的人暂时还没有。\n有新的人加入，会第一时间推荐给你。")
                RecLinks(today, onNav, onBrowse)
            }
            cur == null -> {
                val liked = today.list.count { it.state == "liked" || it.state == "mutual" }
                val passed = today.list.count { it.state == "passed" }
                RecCenter("今天的 ${today.list.size} 位看完了", "${nextText(today.nextAt)}有新的推荐\n今天喜欢了 $liked 位，跳过 $passed 位")
                RecLinks(today, onNav, onBrowse)
            }
            else -> {
                val ta = if (cur.user.gender == 1) "他" else "她"
                Row(Modifier.fillMaxWidth().padding(22.dp, 2.dp, 22.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("今天为你挑了 ${today.list.size} 位", color = HnInk, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
                    if (today.list.size < today.limit) Text("  合适的人还不多，有几位给几位", color = HnInk3, fontSize = 11.sp)
                    Spacer(Modifier.weight(1f))
                    today.list.forEach { x ->
                        val on = x.user.id == cur.user.id
                        Box(
                            Modifier.padding(start = 5.dp).size(if (on) 18.dp else 6.dp, 6.dp).clip(RoundedCornerShape(3.dp))
                                .then(if (on) Modifier.background(HnGrad) else Modifier.background(HnInk.copy(alpha = 0.15f))),
                        )
                    }
                }

                // 卡片：大照片 + 为什么推荐
                val shape = RoundedCornerShape(28.dp)
                Column(
                    Modifier.padding(horizontal = 16.dp).fillMaxWidth()
                        .shadow(14.dp, shape, ambientColor = HnRose, spotColor = HnRose).clip(shape).background(Color.White),
                ) {
                    Box(Modifier.fillMaxWidth().height(268.dp).background(Color(0xFFEADFE1)).noRippleClick { onOpenUser(cur.user.id) }) {
                        if (cur.user.avatar.isNotEmpty()) {
                            AsyncImage(
                                model = Api.fullUrl(cur.user.avatar), contentDescription = null,
                                modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop, alignment = Alignment.TopCenter,
                            )
                        }
                        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.5f to Color.Transparent, 1f to Color(0xD118080E))))
                        Column(Modifier.align(Alignment.BottomStart).padding(start = 16.dp, end = 16.dp, bottom = 13.dp)) {
                            Row(verticalAlignment = Alignment.Bottom) {
                                Text(cur.user.nickname, color = Color.White, fontSize = 25.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
                                if (cur.user.age > 0) Text("  ${cur.user.age}", color = Color.White, fontSize = 20.sp)
                            }
                            Row(Modifier.padding(top = 7.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                cur.chips.forEach { c ->
                                    Text(
                                        c, color = Color.White, fontSize = 11.5.sp, maxLines = 1,
                                        modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(Color.White.copy(alpha = 0.24f))
                                            .border(1.dp, Color.White.copy(alpha = 0.35f), RoundedCornerShape(12.dp)).padding(horizontal = 10.dp, vertical = 3.dp),
                                    )
                                }
                            }
                        }
                    }
                    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 13.dp, bottom = 15.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            HnOrb(26.dp)
                            Text(
                                if (cur.reason.isNotEmpty()) "AI 红娘为什么推荐$ta" else "你和${ta}的共同点",
                                color = HnRose, fontSize = 12.5.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 6.dp).weight(1f),
                            )
                            if (cur.reason.isNotEmpty()) Text("✦ AI 生成", color = HnInk3, fontSize = 11.sp)
                        }
                        if (cur.reason.isNotEmpty()) Text(cur.reason, color = HnInk, fontSize = 14.5.sp, lineHeight = 24.sp, modifier = Modifier.padding(top = 8.dp))
                        if (cur.tags.isNotEmpty()) {
                            MatchTags(cur.tags, Modifier.padding(top = 10.dp))
                        } else if (cur.reason.isEmpty()) {
                            Text("你们的条件互相符合。点照片看${ta}的完整画像。", color = HnInk2, fontSize = 13.sp, lineHeight = 21.sp, modifier = Modifier.padding(top = 8.dp))
                        }
                        if (cur.likedMe) {
                            Text("${ta}已经喜欢了你，你也喜欢的话就可以视频见面", color = HnRose, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 10.dp))
                        }
                    }
                }
                // 后面还有几位：卡片下面露出两层边
                if (left.size > 1) Box(Modifier.padding(horizontal = 30.dp).fillMaxWidth().height(12.dp).clip(RoundedCornerShape(bottomStart = 24.dp, bottomEnd = 24.dp)).background(Color.White.copy(alpha = 0.7f)))
                if (left.size > 2) Box(Modifier.padding(horizontal = 46.dp).fillMaxWidth().height(9.dp).clip(RoundedCornerShape(bottomStart = 24.dp, bottomEnd = 24.dp)).background(Color.White.copy(alpha = 0.45f)))

                Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    RoundAct("✕", 62.dp, like = false, enabled = !liker.busy) {
                        scope.launch {
                            runCatching { Api.request("/match/pass/${cur.user.id}", "POST") }
                                .onSuccess { setState(cur.user.id, "passed") }
                                .onFailure { android.widget.Toast.makeText(ctx, it.message ?: "操作失败", android.widget.Toast.LENGTH_SHORT).show() }
                        }
                    }
                    Spacer(Modifier.width(26.dp))
                    RoundAct("♥", 72.dp, like = true, enabled = !liker.busy) {
                        liker.like(cur.user.id) { r -> setState(cur.user.id, if (r.matched) "mutual" else "liked") }
                    }
                }
                Text("点照片看${ta}的完整画像", color = HnInk3, fontSize = 11.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            }
        }
    }
    liker.Dialogs()
}

/** 共同点小标签，一行放不下就横着滑 */
@Composable
private fun MatchTags(tags: List<String>, modifier: Modifier = Modifier) {
    Row(modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        tags.forEach { t ->
            Text(
                t, color = HnRose, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
                modifier = Modifier.clip(RoundedCornerShape(13.dp)).background(HnSoft).padding(horizontal = 11.dp, vertical = 4.dp),
            )
        }
    }
}

/** 推荐卡片下面的圆按钮：✕ 跳过、♥ 喜欢 */
@Composable
private fun RoundAct(glyph: String, size: Dp, like: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(size)
            .shadow(if (like) 10.dp else 6.dp, CircleShape, ambientColor = if (like) HnRose else HnInk3, spotColor = if (like) HnRose else HnInk3)
            .clip(CircleShape)
            .then(if (like) Modifier.background(HnGrad, alpha = if (enabled) 1f else 0.5f) else Modifier.background(Color.White))
            .noRippleClick { if (enabled) onClick() },
        contentAlignment = Alignment.Center,
    ) { Text(glyph, color = if (like) Color.White else HnInk2, fontSize = if (like) 30.sp else 24.sp) }
}

/** 推荐页居中的说明：看完了 / 没有人 / 没填完 */
@Composable
private fun RecCenter(title: String, sub: String, extra: @Composable () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(start = 30.dp, end = 30.dp, top = 36.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        HnOrb(60.dp)
        Text(title, color = HnInk, fontSize = 21.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(top = 28.dp))
        Text(sub, color = HnInk2, fontSize = 13.sp, lineHeight = 22.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
        extra()
    }
}

/** 看完以后下面的三行入口：喜欢我的、去「所有」里逛逛、和 AI 红娘再聊聊 */
@Composable
private fun RecLinks(today: MatchToday, onNav: (String) -> Unit, onBrowse: () -> Unit) {
    val shape = RoundedCornerShape(22.dp)
    Column(
        Modifier.padding(start = 16.dp, end = 16.dp, top = 26.dp).fillMaxWidth()
            .shadow(6.dp, shape, ambientColor = HnRose.copy(alpha = 0.4f), spotColor = HnRose.copy(alpha = 0.4f)).clip(shape).background(Color.White),
    ) {
        RecLinkRow("♥", "喜欢我的", if (today.likedMe > 0) "${today.likedMe} 人" else "", strong = true) { onNav(hnH5("/likes?tab=likedMe")) }
        RecLinkRow("☺", "去「所有」里逛逛", "今天还能喜欢 ${today.quota.left} 个", strong = false, onClick = onBrowse)
        RecLinkRow("✦", "和 AI 红娘再聊聊，让推荐更准", "", strong = false) { onNav("deep") }
    }
}

@Composable
private fun RecLinkRow(glyph: String, text: String, end: String, strong: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 50.dp).noRippleClick(onClick).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(30.dp).clip(RoundedCornerShape(10.dp)).background(HnSoft), contentAlignment = Alignment.Center) { Text(glyph, color = HnRose, fontSize = 14.sp) }
        Text(text, color = HnInk, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 11.dp).weight(1f))
        if (end.isNotEmpty()) Text(end, color = if (strong) HnRose else HnInk2, fontSize = if (strong) 15.sp else 12.5.sp, fontWeight = if (strong) FontWeight.Bold else FontWeight.Normal)
        Text("  ›", color = HnInk3, fontSize = 16.sp)
    }
}

// ---------- 消息页顶上：喜欢我的 / 我喜欢的 / 互相喜欢 ----------

/** 三个数字，点哪个进喜欢列表（网页）对应的分类 */
@Composable
fun LikeEntries(sum: MatchSummary?, onNav: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        listOf(Triple("likedMe", "喜欢我的", sum?.likedMe), Triple("liked", "我喜欢的", sum?.liked), Triple("mutual", "互相喜欢", sum?.mutual)).forEach { (k, label, n) ->
            val shape = RoundedCornerShape(20.dp)
            Box(
                Modifier.weight(1f).shadow(5.dp, shape, ambientColor = HnRose.copy(alpha = 0.35f), spotColor = HnRose.copy(alpha = 0.35f))
                    .clip(shape).background(Color.White).noRippleClick { onNav(hnH5("/likes?tab=$k")) },
            ) {
                Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(n?.toString() ?: "-", color = if (k == "likedMe" && (n ?: 0) > 0) HnRose else HnInk, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
                    Text(label, color = HnInk2, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
                }
                // 有新喜欢我的人：右上角红点
                if (k == "likedMe" && (sum?.likedMeNew ?: 0) > 0) {
                    Box(Modifier.align(Alignment.TopEnd).padding(top = 8.dp, end = 10.dp).size(8.dp).clip(CircleShape).background(HnRose))
                }
            }
        }
    }
}

// ---------- 互相喜欢的庆祝页 ----------

/**
 * 两边都点了喜欢的那一刻弹出，盖住整个 App。
 * onChat：进你们的聊天；draft 是点了 AI 想的某一句开场白，先填进输入框，可以改了再发。
 */
@Composable
fun MatchCelebration(myAvatar: String, onChat: (convId: String, targetId: String, title: String, draft: String) -> Unit) {
    val m = MatchCenter.celebrate ?: return
    var lines by remember(m.peer.id) { mutableStateOf<List<String>>(emptyList()) }
    LaunchedEffect(m.peer.id) {
        // 看过了，下次不再弹
        runCatching { Api.request("/match/seen/${m.peer.id}", "POST") }
        // 开场白：有余额或 Key 才有，没有就不显示这一块
        runCatching { postObj<IceResp>("/match/icebreakers/${m.peer.id}") }.onSuccess { lines = it.lines }
    }
    fun close() { MatchCenter.celebrate = null }
    fun go(draft: String) { close(); onChat(m.conversationId, m.peer.id, m.peer.nickname, draft) }
    BackHandler { close() }

    Box(
        Modifier.fillMaxSize()
            .background(Brush.verticalGradient(listOf(Color(0xFFFF8A6E), Color(0xFFFF3D63), Color(0xFFFF6B6B), Color(0xFFD6286A))))
            // 盖在所有页面上面：点空白处不能穿到下面去
            .pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } },
    ) {
        Column(
            Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(start = 26.dp, end = 26.dp, top = 70.dp, bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("互相喜欢了", color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 2.sp)
            Text("你和${m.peer.nickname}都喜欢了对方，现在可以聊天了", color = Color.White.copy(alpha = 0.92f), fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
            Box(Modifier.padding(top = 26.dp), contentAlignment = Alignment.Center) {
                Row {
                    DuoAvatar(myAvatar)
                    Spacer(Modifier.width(24.dp))
                    DuoAvatar(m.peer.avatar)
                }
                Box(Modifier.size(52.dp).shadow(8.dp, CircleShape).clip(CircleShape).background(Color.White), contentAlignment = Alignment.Center) {
                    Text("♥", color = HnRose, fontSize = 26.sp)
                }
            }
            if (lines.isNotEmpty()) {
                val shape = RoundedCornerShape(22.dp)
                Column(
                    Modifier.padding(top = 24.dp).fillMaxWidth().clip(shape).background(Color.White.copy(alpha = 0.18f))
                        .border(1.dp, Color.White.copy(alpha = 0.4f), shape).padding(start = 14.dp, end = 14.dp, top = 13.dp, bottom = 14.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("✦ AI 红娘帮你想的开场白", color = Color.White, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        Text("AI 生成 · 点一句带进聊天", color = Color.White.copy(alpha = 0.8f), fontSize = 11.sp)
                    }
                    lines.forEach { l ->
                        Text(
                            l, color = HnInk, fontSize = 13.5.sp, lineHeight = 21.sp,
                            modifier = Modifier.padding(top = 8.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Color.White.copy(alpha = 0.92f))
                                .noRippleClick { go(l) }.padding(horizontal = 12.dp, vertical = 9.dp),
                        )
                    }
                }
            }
            Box(
                Modifier.padding(top = 22.dp).fillMaxWidth().height(50.dp).shadow(10.dp, RoundedCornerShape(25.dp)).clip(RoundedCornerShape(25.dp)).background(Color.White).noRippleClick { go("") },
                contentAlignment = Alignment.Center,
            ) { Text("开始聊天", color = HnRose, fontSize = 16.sp, fontWeight = FontWeight.Bold) }
            Text("待会儿再说", color = Color.White.copy(alpha = 0.9f), fontSize = 14.sp, modifier = Modifier.padding(top = 6.dp).noRippleClick { close() }.padding(12.dp))
        }
    }
}

@Composable
private fun DuoAvatar(url: String) {
    Box(Modifier.size(118.dp).shadow(12.dp, CircleShape).clip(CircleShape).background(Color.White).padding(4.dp)) {
        Box(Modifier.fillMaxSize().clip(CircleShape).background(Color(0xFFF3C6CF))) {
            if (url.isNotEmpty()) AsyncImage(model = Api.fullUrl(url), contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        }
    }
}

// ---------- 小号的喜欢按钮：动态详情、老主页这些原来放「私聊 / 发消息」的地方用 ----------

/**
 * 没表态 →「♥ 喜欢」；我喜欢了 →「已喜欢」；对方先喜欢了我 →「♥ 也喜欢」；互相喜欢 →「发消息」。
 * 有一方结束了联系就不显示。
 * withChat：前面再放一个白底的「发消息」（2026-11-27 起发消息不用互相喜欢；别人的主页底部用，互相喜欢后只剩一个「发消息」）。
 * 两个按钮都用传进来的 modifier（放在 Row 里给 weight 时各占一份）。
 */
@Composable
fun LikeChip(
    userId: String, nickname: String, modifier: Modifier = Modifier, height: Dp = 34.dp, withChat: Boolean = false,
    onChat: (String, String) -> Unit, onNav: (String) -> Unit,
) {
    var state by remember(userId) { mutableStateOf<String?>(null) }
    val liker = rememberLiker(onNav)
    LaunchedEffect(userId, MatchCenter.version) {
        runCatching { Api.getObj<MatchRelation>("/match/relation/$userId") }.onSuccess { state = it.state }
    }
    val s = state
    if (s == null || s == "ended") return
    val shape = RoundedCornerShape(height / 2)
    val ghost = s == "liked"
    if (withChat && s != "mutual") {
        Box(
            modifier.height(height)
                .shadow(2.dp, shape, ambientColor = HnInk3, spotColor = HnInk3)
                .clip(shape).background(Color.White)
                .noRippleClick { onChat(userId, nickname) }
                .padding(horizontal = 16.dp),
            contentAlignment = Alignment.Center,
        ) { Text("发消息", color = HnRose, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1) }
    }
    Box(
        modifier.height(height)
            .shadow(if (ghost) 2.dp else 5.dp, shape, ambientColor = if (ghost) HnInk3 else HnRose, spotColor = if (ghost) HnInk3 else HnRose)
            .clip(shape).then(if (ghost) Modifier.background(Color.White) else Modifier.background(HnGrad))
            .noRippleClick {
                when (s) {
                    "mutual" -> onChat(userId, nickname)
                    "liked" -> {}
                    else -> liker.like(userId) { r -> state = r.state }
                }
            }
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            when (s) { "mutual" -> "发消息"; "liked" -> "✓ 已喜欢"; "likedMe" -> "♥ 也喜欢"; else -> "♥ 喜欢" },
            color = if (ghost) HnInk2 else Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
        )
    }
    liker.Dialogs()
}

// ---------- 聊天页用的几样 ----------

/** 聊天页顶上的提示条 + 防骗提醒：互相喜欢了写哪天配上的；还没互相喜欢的照常能聊（样稿 design/09-openchat.html）；结束了联系的不显示 */
@Composable
fun ChatMatchBanner(rel: MatchRelation?) {
    if (rel == null || rel.state == "ended") return
    val head = when {
        rel.state != "mutual" -> "你们还没有互相喜欢，可以先聊聊。"
        rel.matchedAt != null -> "你们在 ${matchDayText(rel.matchedAt)}互相喜欢了。"
        else -> "你们互相喜欢了。"
    }
    val text = head + "\n线下见面前不要转账，遇到借钱、投资的请直接举报。"
    Text(
        text, color = HnInk2, fontSize = 12.5.sp, lineHeight = 19.sp, textAlign = TextAlign.Center,
        modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 6.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color.Black.copy(alpha = 0.04f)).padding(horizontal = 14.dp, vertical = 10.dp),
    )
}

/** 有一方点了「不再联系」时，输入区换成的那一句说明（聊天记录照常能看）。其余情况一律能发，不会用到它 */
@Composable
fun ChatBlockedBar(rel: MatchRelation) {
    Column(
        Modifier.fillMaxWidth().background(Color(0xFFF7F4F5)).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(if (rel.endedBy == "me") "你已选择不再联系" else "对方已结束聊天", color = HnInk2, fontSize = 14.sp, textAlign = TextAlign.Center)
    }
}

/**
 * 发起视频被服务器拒绝、原因是还没互相喜欢时弹的说明（样稿 design/09-openchat.html 第 2 组）。放在 AppRoot 最上层，哪个页面发起的都能弹。
 * 文案按两个人的关系分三种；我还没点喜欢的两种带「去 TA 的画像」（在那里点喜欢）。
 */
@Composable
fun VideoNeedLikeDialog(onOpenCard: (String) -> Unit) {
    val peer by com.wh.hongniang.rtc.CallManager.videoNeedLike.collectAsState()
    val (peerId, _) = peer ?: return
    var state by remember(peerId) { mutableStateOf<String?>(null) }
    LaunchedEffect(peerId) {
        state = runCatching { Api.getObj<MatchRelation>("/match/relation/$peerId") }.getOrNull()?.state ?: "none"
    }
    val close = { com.wh.hongniang.rtc.CallManager.videoNeedLike.value = null }
    val s = state ?: return
    androidx.compose.ui.window.Dialog(onDismissRequest = close) {
        Column(Modifier.clip(RoundedCornerShape(24.dp)).background(Color.White).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("互相喜欢后才能视频见面", color = HnInk, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold)
            Text(
                when (s) {
                    "liked" -> "你已经喜欢了 TA，等 TA 也喜欢你，就可以视频了。"
                    "likedMe" -> "TA 已经喜欢你了，你也点喜欢就可以视频。"
                    else -> "你还没有喜欢 TA。去 TA 的画像点「喜欢」，TA 也喜欢你，就可以视频了。"
                },
                color = HnInk2, fontSize = 13.5.sp, lineHeight = 22.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 7.dp),
            )
            Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                HnButton("知道了", Modifier.weight(1f), ghost = true, height = 44.dp, onClick = close)
                if (s != "liked") HnButton("去 TA 的画像", Modifier.weight(1.3f), height = 44.dp) { close(); onOpenCard(peerId) }
            }
        }
    }
}

private val REPORT_REASONS = listOf("资料或照片是假的", "骚扰、辱骂", "借钱、投资、要转账", "发广告或引流", "色情低俗", "其他")

/** 举报一个人：选原因 → 提交。onDone 带回一句提示 */
@Composable
fun ReportUserDialog(userId: String, onDone: (String) -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.clip(RoundedCornerShape(24.dp)).background(Color.White).padding(top = 20.dp, bottom = 10.dp)) {
            Text("举报的原因", color = HnInk, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(horizontal = 20.dp))
            Text("对方不会知道是你举报的。", color = HnInk2, fontSize = 13.sp, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 8.dp))
            REPORT_REASONS.forEach { r ->
                Text(
                    r, color = HnInk, fontSize = 15.sp,
                    modifier = Modifier.fillMaxWidth().noRippleClick {
                        scope.launch {
                            val tip = runCatching {
                                Api.request("/match/report/$userId", "POST", buildJsonObject { put("reason", JsonPrimitive(r)) })
                                "举报已提交，平台会尽快核实"
                            }.getOrElse { it.message ?: "提交失败" }
                            onDone(tip)
                        }
                    }.padding(horizontal = 20.dp, vertical = 13.dp),
                )
            }
            Text("取消", color = HnInk2, fontSize = 15.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().noRippleClick(onDismiss).padding(vertical = 12.dp))
        }
    }
}
