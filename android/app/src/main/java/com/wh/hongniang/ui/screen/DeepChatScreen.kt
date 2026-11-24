package com.wh.hongniang.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.hongniang.net.Api
import com.wh.hongniang.net.ApiException
import com.wh.hongniang.ui.Avatar
import com.wh.hongniang.ui.noRippleClick
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Serializable
data class DeepMsg(val id: String = "", val role: String = "ai", val text: String = "", val quick: List<String> = emptyList(), val topic: Int = 0)

@Serializable
data class DeepWallet(val balance: String = "0.00", val payMode: String = "platform", val hasKey: Boolean = false, val feePercent: Int = 10)

@Serializable
data class DeepSpent(val cost: String = "0.0000", val fee: String = "0.0000", val total: String = "0.0000", val ownKey: Boolean = false, val calls: Int = 0)

/** GET /hn/deep 以及每次操作后返回的状态 */
@Serializable
data class DeepState(
    /** 必须先做完点选问答才能深聊 */
    val profileDone: Boolean = false,
    val topics: List<String> = emptyList(),
    /** 开始前告诉用户大概花多少（元） */
    val estimate: String = "",
    val wallet: DeepWallet = DeepWallet(),
    /** none 没聊过 | chatting 聊天中 | draft 画像等确认 | done 已确认 */
    val status: String = "none",
    /** 聊到第几个话题；等于话题总数 = 都聊过了，在自由补充 */
    val topic: Int = 0,
    val messages: List<DeepMsg> = emptyList(),
    /** 最后一句是我说的、AI 还没回（上次没回成） */
    val pending: Boolean = false,
    val canFinish: Boolean = false,
    val spent: DeepSpent? = null,
    /** 这一轮 AI 说聊完了：接着整理画像 */
    val done: Boolean = false,
    /** 自己的 Key 用不了，按设置自动改用了平台余额 */
    val fellBack: Boolean = false,
)

/** 调模型失败时的提示卡：标题 + 说明（按服务端返回的 reason 取） */
private val DEEP_NOTICE = mapOf(
    "no_balance" to ("余额不够了，先聊到这里" to "你说的都存好了，充值后接着聊。不影响你被推荐和找人聊天。"),
    "key_invalid" to ("你的 Key 用不了" to "可能已经失效了，或者复制得不完整。"),
    "key_no_balance" to ("你的 Key 没有额度了" to "需要去 DeepSeek 后台充值，或者换一种付费方式。"),
    "need_key" to ("还没有填写你自己的 Key" to "填好以后接着聊，或者改用平台余额。"),
    "ai_down" to ("AI 暂时没回上话" to "不是你的问题，稍等一下再试。这次没有扣费。"),
)

/**
 * AI 深聊（原生）：真的大模型在问、在接话。六个话题聊完整理成画像，用户确认后生效。
 * 可选功能，按用量花模型费（平台余额或自己的 Key）。充值、填 Key、明细、相亲画像是网页（HnWebScreen）。
 * 和网页端 web/src/pages/DeepChat.tsx 是同一套流程和接口；样稿 design/01-ai-interview.html
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DeepChatScreen(myAvatar: String, onBack: () -> Unit, onNav: (String) -> Unit) {
    var st by remember { mutableStateOf<DeepState?>(null) }
    var card by remember { mutableStateOf<HnCardBrief?>(null) }
    var failed by remember { mutableStateOf(false) }
    var input by remember { mutableStateOf("") }
    /** 空 = 没在忙；reply 等 AI 回话；portrait 正在整理画像；other 别的请求 */
    var busy by remember { mutableStateOf("") }
    /** 我刚发出去、服务端还没返回的那句话（先显示出来） */
    var sending by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var askRestart by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val scroll = rememberScrollState()
    fun toast(msg: String) = android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_SHORT).show()

    fun load() {
        failed = false
        scope.launch { runCatching { Api.getObj<DeepState>("/hn/deep") }.onSuccess { st = it }.onFailure { failed = true } }
    }
    // 从充值 / 填 Key 的网页回来时这一页会重新创建，自然就重新取了一次状态
    LaunchedEffect(Unit) { load() }
    // 离开时让「我的」页重新取一次（深聊的状态、余额可能变了）
    DisposableEffect(Unit) { onDispose { HnEvents.version++ } }

    val state = st
    val showLink = state?.status == "draft" || state?.status == "done"
    LaunchedEffect(state?.status) {
        if (showLink) card = runCatching { Api.getObj<HnCardBrief>("/hn/card/me") }.getOrNull() ?: card
    }
    LaunchedEffect(state?.messages?.size, sending, busy, notice, card) {
        kotlinx.coroutines.delay(60)
        scroll.animateScrollTo(scroll.maxValue)
    }

    fun fail(e: Throwable) {
        val reason = (e as? ApiException)?.reason.orEmpty()
        if (reason in DEEP_NOTICE) notice = reason else toast(e.message ?: "请求失败，请稍后再试")
    }

    suspend fun call(path: String, body: JsonObject? = null): DeepState =
        Api.json.decodeFromJsonElement(DeepState.serializer(), Api.request(path, "POST", body)!!)

    /** 聊完后把聊天记录整理成画像 */
    fun finish() {
        if (busy.isNotEmpty()) return
        menu = false
        busy = "portrait"
        scope.launch {
            runCatching { call("/hn/deep/finish") }.onSuccess { st = it; notice = "" }.onFailure { fail(it) }
            busy = ""
        }
    }

    /** 说一句 / 点现成回答 / 先不说（skip）/ 换个话题（next）；什么都不带 = 让 AI 重新回上一句 */
    fun send(text: String = "", action: String = "") {
        val s = st ?: return
        if (busy.isNotEmpty()) return
        val shown = when (action) { "skip" -> "先不说"; "next" -> "换个话题"; else -> text.trim() }
        if (shown.isEmpty() && !s.pending) return
        input = ""
        notice = ""
        sending = shown
        busy = "reply"
        scope.launch {
            var done = false
            runCatching {
                call("/hn/deep/message", buildJsonObject {
                    if (action.isNotEmpty()) put("action", action) else if (shown.isNotEmpty()) put("text", shown)
                })
            }.onSuccess {
                st = it
                done = it.done
                if (it.fellBack) toast("你的 Key 用不了，已改用平台余额")
            }.onFailure { e ->
                fail(e)
                // 我说的话服务端已经存下了，重新取一次状态把它显示出来
                runCatching { Api.getObj<DeepState>("/hn/deep") }.onSuccess { st = it }
            }
            sending = ""
            busy = ""
            // AI 说聊完了：接着整理画像
            if (done) finish()
        }
    }

    fun post(path: String) {
        if (busy.isNotEmpty()) return
        menu = false
        busy = "other"
        scope.launch {
            runCatching { call(path) }.onSuccess { st = it; notice = ""; HnEvents.version++ }.onFailure { fail(it) }
            busy = ""
        }
    }

    fun pickMode(mode: String, then: () -> Unit = {}) {
        scope.launch {
            runCatching { Api.request("/ai-wallet/mode", "PUT", buildJsonObject { put("payMode", mode) }) }
                .onSuccess { load(); then() }
                .onFailure { toast(it.message ?: "请求失败，请稍后再试") }
        }
    }

    Box(Modifier.fillMaxSize().background(HnPageBg)) {
        Column(Modifier.fillMaxSize()) {
            // ===== 顶栏：返回 + 「AI 红娘 · 人工智能」+ 更多 =====
            Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                HnCircleBtn("‹", onBack)
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    Text("AI 红娘", color = HnInk, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    Text(
                        "人工智能", color = HnRose, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(start = 8.dp).clip(RoundedCornerShape(8.dp)).background(HnSoft).padding(horizontal = 7.dp, vertical = 2.dp),
                    )
                }
                Box(Modifier.size(34.dp)) {
                    if (state != null && state.status != "none") {
                        HnCircleBtn("···") { menu = true }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text("先聊到这（已自动保存）") }, onClick = { menu = false; onBack() })
                            if (state.status == "chatting") {
                                DropdownMenuItem(
                                    text = { Text("聊够了，直接出画像", color = if (state.canFinish) Color.Unspecified else HnInk3) },
                                    onClick = { if (state.canFinish) finish() else { menu = false; toast("再多聊两句，我才好整理") } },
                                )
                            }
                            DropdownMenuItem(text = { Text("费用明细") }, onClick = { menu = false; onNav(hnH5("/ai-fee/ledger")) })
                            DropdownMenuItem(text = { Text("重新聊", color = Color(0xFFF04438)) }, onClick = { menu = false; askRestart = true })
                        }
                    }
                }
            }

            // ===== 话题进度 =====
            if (state != null && state.status != "none") {
                Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 4.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    state.topics.forEachIndexed { i, name ->
                        val ok = i < state.topic || state.status != "chatting"
                        val on = !ok && i == state.topic
                        Box(
                            Modifier.weight(1f).height(26.dp).clip(RoundedCornerShape(13.dp))
                                .then(if (on) Modifier.background(HnGrad) else Modifier.background(if (ok) HnSoft else Color.White.copy(alpha = 0.7f))),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                if (ok) "✓$name" else name, maxLines = 1, fontSize = 11.sp,
                                color = if (on) Color.White else if (ok) HnRose else HnInk3, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
                            )
                        }
                    }
                }
            }

            // ===== 聊天内容 =====
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 6.dp)) {
                if (state == null) {
                    Box(Modifier.fillMaxWidth().padding(vertical = 80.dp).noRippleClick { if (failed) load() }, contentAlignment = Alignment.Center) {
                        Text(if (failed) "没加载出来，点一下重试" else "加载中…", color = HnInk2, fontSize = 14.sp)
                    }
                } else {
                    if (state.status == "none") DeepBubble("你好，我是 AI 红娘，是人工智能，不是真人。", mine = false, gen = false)
                    state.messages.forEach { m -> DeepBubble(m.text, mine = m.role != "ai", myAvatar = myAvatar) }
                    if (sending.isNotEmpty()) DeepBubble(sending, mine = true, myAvatar = myAvatar)
                    if (busy == "reply") DeepBubble("正在输入…", mine = false, gen = false)
                    if (busy == "portrait") DeepBubble("正在整理你的相亲画像，稍等几秒…", mine = false, gen = false)
                    val c = card
                    if (showLink && c != null) {
                        PortraitLinkCard(c, Modifier.padding(start = 47.dp, bottom = 14.dp).widthIn(max = 330.dp)) { onNav(hnH5("/card/me")) }
                    }

                    // 提示卡：上次调用失败的原因；重新进来后原因丢了、只知道 AI 还没回，就给一个「继续」
                    val noticeKey = notice.ifEmpty { if (state.status == "chatting" && state.pending && busy.isEmpty()) "ai_down" else "" }
                    DEEP_NOTICE[noticeKey]?.let { (title, sub) ->
                        Column(
                            Modifier.padding(bottom = 14.dp).fillMaxWidth().shadow(6.dp, RoundedCornerShape(22.dp), ambientColor = HnRose, spotColor = HnRose)
                                .clip(RoundedCornerShape(22.dp)).background(Color.White).padding(16.dp),
                        ) {
                            Text(title, color = HnInk, fontSize = 15.5.sp, fontWeight = FontWeight.ExtraBold)
                            Text(sub, color = HnInk2, fontSize = 12.5.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 3.dp))
                            FlowRow(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                when (noticeKey) {
                                    "no_balance" -> {
                                        HnPill("去充值") { onNav(hnH5("/ai-fee/topup")) }
                                        HnPill("改用我自己的 Key", ghost = true) { onNav(hnH5("/ai-fee/key")) }
                                    }
                                    "key_invalid", "key_no_balance" -> {
                                        HnPill("换一个 Key") { onNav(hnH5("/ai-fee/key")) }
                                        HnPill("改用平台余额", ghost = true) { pickMode("platform") { notice = "ai_down" } }
                                    }
                                    "need_key" -> {
                                        HnPill("去填写 Key") { onNav(hnH5("/ai-fee/key")) }
                                        HnPill("改用平台余额", ghost = true) { pickMode("platform") { notice = "ai_down" } }
                                    }
                                    else -> HnPill(if (state.pending) "继续" else "知道了") { if (state.pending) send() else notice = "" }
                                }
                                if (noticeKey != "ai_down" && state.pending) HnPill("解决了，继续", ghost = true) { send() }
                            }
                        }
                    }
                }
            }

            // ===== 底部：聊天中是现成回答 + 输入框；画像等确认时是两个按钮；确认后是「再聊聊」 =====
            if (state != null) {
                val blocked = notice.isNotEmpty() || (state.pending && busy.isEmpty())
                when (state.status) {
                    "chatting" -> Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 12.dp)) {
                        val extra = state.topic >= state.topics.size
                        if (!blocked && busy.isEmpty()) {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                state.messages.lastOrNull { it.role == "ai" }?.quick.orEmpty().forEach { q -> QuickChip(q, strong = true) { send(q) } }
                                QuickChip("先不说", strong = false) { send(action = "skip") }
                                if (!extra) QuickChip("换个话题", strong = false) { send(action = "next") }
                                if (extra && state.canFinish) QuickChip("聊够了，出画像", strong = false) { finish() }
                            }
                        }
                        Row(Modifier.padding(top = if (blocked) 0.dp else 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            val canType = !blocked && busy.isEmpty()
                            Box(
                                Modifier.weight(1f).height(46.dp).shadow(4.dp, RoundedCornerShape(23.dp), ambientColor = HnInk3, spotColor = HnInk3)
                                    .clip(RoundedCornerShape(23.dp)).background(Color.White.copy(alpha = if (canType) 1f else 0.6f)).padding(horizontal = 18.dp),
                                contentAlignment = Alignment.CenterStart,
                            ) {
                                if (input.isEmpty()) Text(if (blocked) "暂时不能发" else "也可以自己打字…", color = HnInk3, fontSize = 15.sp)
                                BasicTextField(
                                    value = input, onValueChange = { input = it.take(500) }, enabled = canType, singleLine = true,
                                    textStyle = TextStyle(color = HnInk, fontSize = 15.sp), cursorBrush = SolidColor(HnRose),
                                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                                    keyboardActions = KeyboardActions(onSend = { if (input.isNotBlank()) send(input) }),
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                            val canSend = canType && input.isNotBlank()
                            Box(
                                Modifier.padding(start = 8.dp).size(46.dp).clip(CircleShape).background(HnGrad, alpha = if (canSend) 1f else 0.45f)
                                    .noRippleClick { if (canSend) send(input) },
                                contentAlignment = Alignment.Center,
                            ) { Text("↑", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold) }
                        }
                        CostLine(state, total = false) { onNav(hnH5("/ai-fee/ledger")) }
                    }
                    "draft" -> Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 12.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            HnButton("再聊聊", Modifier.weight(1f), ghost = true, enabled = busy.isEmpty()) { post("/hn/deep/resume") }
                            HnButton("确认，就这样", Modifier.weight(1.5f), enabled = busy.isEmpty()) { post("/hn/deep/confirm") }
                        }
                        CostLine(state, total = true) { onNav(hnH5("/ai-fee/ledger")) }
                    }
                    "done" -> Box(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 14.dp)) {
                        HnButton("✦ 再和 AI 聊聊", Modifier.fillMaxWidth(), ghost = true, enabled = busy.isEmpty()) { post("/hn/deep/resume") }
                    }
                }
            }
        }

        // ===== 第一次进来：说明 + 选谁付模型费 =====
        if (state != null && state.status == "none") {
            Box(Modifier.fillMaxSize().background(Color(0x6B2B141C)).noRippleClick { })
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().clip(RoundedCornerShape(topStart = 30.dp, topEnd = 30.dp)).background(Color.White)
                    .navigationBarsPadding().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 24.dp, bottom = 18.dp),
            ) {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    HnOrb(60.dp)
                    Text("和 AI 红娘深聊", color = HnInk, fontSize = 21.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(top = 14.dp))
                    Text(
                        "我是人工智能，不是真人", color = HnRose, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(top = 8.dp).clip(RoundedCornerShape(12.dp)).background(HnSoft).padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }
                IntroLine("大约 10 分钟，聊性格、生活习惯、对家庭的想法和想找的人", top = 16)
                IntroLine("不想说的就说「先不说」，随时能停，下次接着聊")
                IntroLine("聊完整理成画像，你确认了才生效")

                if (state.profileDone) {
                    val own = state.wallet.payMode == "own" && state.wallet.hasKey
                    val empty = (state.wallet.balance.toDoubleOrNull() ?: 0.0) <= 0.0
                    val canStart = own || !empty
                    Row(Modifier.padding(top = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("费用怎么付", color = HnInk, fontSize = 14.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                        Text("这次预计 ¥${state.estimate} 以内", color = HnInk2, fontSize = 12.sp)
                    }
                    PayOption(
                        "平台余额  ¥${state.wallet.balance}", "DeepSeek 实际费用 + ${state.wallet.feePercent}% 手续费", selected = !own,
                        trailing = if (empty) "去充值" else null,
                        onTrailing = { onNav(hnH5("/ai-fee/topup")) },
                    ) { pickMode("platform") }
                    PayOption(
                        "我自己的 DeepSeek Key", "用你自己的额度，平台不扣余额", selected = own,
                        trailing = if (state.wallet.hasKey) null else "去填写",
                        onTrailing = { onNav(hnH5("/ai-fee/key")) },
                    ) { if (state.wallet.hasKey) pickMode("own") else onNav(hnH5("/ai-fee/key")) }
                    HnButton("开始聊", Modifier.padding(top = 16.dp).fillMaxWidth(), enabled = canStart && busy.isEmpty()) { post("/hn/deep/start") }
                    Text(
                        if (canStart) "不聊也不影响你被推荐和找人聊天" else "余额是 0，也没有填 Key：先充值，或者填自己的 Key",
                        color = HnInk3, fontSize = 11.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 10.dp).fillMaxWidth(),
                    )
                } else {
                    Text("深聊之前，先把基本情况的问答做完（免费，大概 3 分钟）。", color = HnInk2, fontSize = 13.sp, lineHeight = 21.sp, modifier = Modifier.padding(top = 18.dp))
                    HnButton("先去填基本情况", Modifier.padding(top = 14.dp).fillMaxWidth()) { onBack(); onNav("interview") }
                }
                Text(
                    "以后再说", color = HnInk2, fontSize = 14.5.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 10.dp).fillMaxWidth().clip(RoundedCornerShape(22.dp)).background(Color(0xFFF5F0F1)).noRippleClick(onBack).padding(vertical = 12.dp),
                )
            }
        }
    }

    if (askRestart) {
        AlertDialog(
            onDismissRequest = { askRestart = false },
            containerColor = Color.White,
            title = { Text("重新聊？", color = HnInk, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
            text = { Text("会从头开始，之前聊的内容不再用来整理画像。已经确认过的画像不受影响。", color = HnInk2, fontSize = 14.sp, lineHeight = 22.sp) },
            confirmButton = { Text("重新聊", color = Color(0xFFF04438), fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick { askRestart = false; post("/hn/deep/restart") }.padding(8.dp)) },
            dismissButton = { Text("取消", color = HnInk2, modifier = Modifier.noRippleClick { askRestart = false }.padding(8.dp)) },
        )
    }
}

/** 对话气泡：AI 红娘在左（白底），我在右（渐变底）。gen = 下面标「AI 生成」 */
@Composable
private fun DeepBubble(text: String, mine: Boolean, myAvatar: String = "", gen: Boolean = true) {
    Row(
        Modifier.fillMaxWidth().padding(bottom = 14.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        if (mine) {
            Spacer(Modifier.width(48.dp))
            val shape = RoundedCornerShape(20.dp, 6.dp, 20.dp, 20.dp)
            Box(
                Modifier.weight(1f, fill = false).shadow(5.dp, shape, ambientColor = HnRose, spotColor = HnRose).clip(shape).background(HnGrad).padding(horizontal = 15.dp, vertical = 11.dp),
            ) { Text(text, color = Color.White, fontSize = 15.sp, lineHeight = 24.sp) }
            Spacer(Modifier.width(9.dp))
            Box(Modifier.size(38.dp).clip(CircleShape).border(2.dp, Color.White, CircleShape)) { Avatar(myAvatar, 38) }
        } else {
            HnOrb(38.dp)
            Spacer(Modifier.width(9.dp))
            Column(Modifier.weight(1f, fill = false)) {
                val shape = RoundedCornerShape(6.dp, 20.dp, 20.dp, 20.dp)
                Box(Modifier.shadow(4.dp, shape, ambientColor = HnInk3, spotColor = HnInk3).clip(shape).background(Color.White).padding(horizontal = 15.dp, vertical = 11.dp)) {
                    Text(text, color = HnInk, fontSize = 15.sp, lineHeight = 24.sp)
                }
                if (gen) Text("✦ AI 生成", color = HnInk3, fontSize = 10.sp, modifier = Modifier.padding(start = 6.dp, top = 5.dp))
            }
            Spacer(Modifier.width(48.dp))
        }
    }
}

/** 现成回答：strong = AI 给的（玫红字），其余是「先不说 / 换个话题」（灰字） */
@Composable
private fun QuickChip(text: String, strong: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(18.dp)
    Text(
        text, color = if (strong) HnRose else HnInk2, fontSize = 14.sp, fontWeight = FontWeight.Medium,
        modifier = Modifier.clip(shape).background(Color.White).border(1.dp, if (strong) HnRose.copy(alpha = 0.28f) else HnLine, shape)
            .noRippleClick(onClick).padding(horizontal = 14.dp, vertical = 8.dp),
    )
}

/** 最下面的小字：这次花了多少、余额还剩多少，点一下看明细 */
@Composable
private fun CostLine(st: DeepState, total: Boolean, onClick: () -> Unit) {
    val s = st.spent ?: return
    val ownNow = st.wallet.payMode == "own" && st.wallet.hasKey
    val text = when {
        s.ownKey || (ownNow && s.calls == 0) -> "用的是你自己的 Key，平台没有扣费"
        total -> "本次共花 ¥${s.total}（模型费 ¥${s.cost} + 手续费 ¥${s.fee}）"
        ownNow -> "本次已花 ¥${s.total} · 现在用你自己的 Key"
        else -> "本次已花 ¥${s.total} · 余额 ¥${st.wallet.balance}"
    }
    Box(Modifier.fillMaxWidth().padding(top = 10.dp), contentAlignment = Alignment.Center) {
        Text(
            "$text  ›", color = HnInk2, fontSize = 11.sp,
            modifier = Modifier.clip(RoundedCornerShape(13.dp)).background(Color.White.copy(alpha = 0.75f)).noRippleClick(onClick).padding(horizontal = 12.dp, vertical = 5.dp),
        )
    }
}

@Composable
private fun IntroLine(text: String, top: Int = 12) {
    Row(Modifier.padding(top = top.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(36.dp).clip(RoundedCornerShape(12.dp)).background(HnSoft), contentAlignment = Alignment.Center) { Text("✦", color = HnRose, fontSize = 15.sp) }
        Text(text, color = HnInk, fontSize = 14.sp, lineHeight = 21.sp, modifier = Modifier.padding(start = 12.dp))
    }
}

/** 付费方式的一张选择卡：选中的描边变红；trailing 是右边的小字按钮（去充值 / 去填写） */
@Composable
private fun PayOption(title: String, sub: String, selected: Boolean, trailing: String?, onTrailing: () -> Unit, onClick: () -> Unit) {
    val shape = RoundedCornerShape(18.dp)
    Row(
        Modifier.padding(top = 8.dp).fillMaxWidth().clip(shape).background(if (selected) Color(0xFFFFF5F6) else Color.White)
            .border(1.5.dp, if (selected) HnRose else HnLine, shape).noRippleClick(onClick).padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = HnInk, fontSize = 14.5.sp, fontWeight = FontWeight.Bold)
            Text(sub, color = HnInk3, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
        }
        if (trailing != null) {
            Text(trailing, color = HnRose, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick(onTrailing).padding(start = 8.dp))
        } else {
            Box(
                Modifier.size(20.dp).clip(CircleShape).then(if (selected) Modifier.background(HnGrad) else Modifier.border(1.5.dp, HnInk3, CircleShape)),
                contentAlignment = Alignment.Center,
            ) { if (selected) Text("✓", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold) }
        }
    }
}
