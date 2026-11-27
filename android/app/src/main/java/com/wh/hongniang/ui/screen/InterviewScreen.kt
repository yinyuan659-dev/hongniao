package com.wh.hongniang.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.hongniang.i18n.t
import com.wh.hongniang.net.Api
import com.wh.hongniang.ui.AccentButton
import com.wh.hongniang.ui.Avatar
import com.wh.hongniang.ui.NavBar
import com.wh.hongniang.ui.noRippleClick
import com.wh.hongniang.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 资料收集的一道题（GET /hn/interview）；题目、选项都是服务端按性别给的固定模板 */
@Serializable
data class HnQuestion(
    val key: String,
    val label: String = "",
    val ask: String = "",
    /** single | multi | text | number | city */
    val type: String = "single",
    val options: List<String> = emptyList(),
    val max: Int = 0,
    val min: Int = 0,
    val hint: String = "",
    /** number 题的滚轮：每一格的文字，第 i 格的值是 min + i */
    val wheel: List<String> = emptyList(),
    /** number 题滚轮一开始停在哪个值 */
    val def: Int = 0,
    /** single 题：选项里没有可以自己填 */
    val custom: Boolean = false,
    /** text 题：示例句，点一下填进输入框 */
    val samples: List<String> = emptyList(),
    val optional: Boolean = false,
    /** true = 「想找的人」那一组 */
    val pref: Boolean = false,
    val answered: Boolean = false,
    val value: List<String> = emptyList(),
    val display: String = "",
)

@Serializable
data class HnProfileBrief(val summary: String = "", val tags: List<String> = emptyList())

@Serializable
data class HnState(
    val intro: List<String> = emptyList(),
    val outro: String = "",
    val confirmedText: String = "",
    val skipText: String = "",
    val questions: List<HnQuestion> = emptyList(),
    /** 全部问题都答过了 */
    val complete: Boolean = false,
    /** 已确认 = 完成资料收集 */
    val confirmed: Boolean = false,
    val profile: HnProfileBrief? = null,
)

/** 资料有变化（答题 / 确认）就加一，「我的」页据此重新拉自己的资料 */
object HnEvents {
    var version by mutableIntStateOf(0)
}

/**
 * AI 红娘资料收集（「编辑资料」进来就是这里）：聊天样式的一问一答，题目是服务端的固定模板，不调大模型。
 * 答一题存一题，中途退出下次接着问；全部答完出相亲画像，确认后才算完成；之后点画像里任意一行可以改。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun InterviewScreen(myAvatar: String, myCity: String, onBack: () -> Unit, onNav: (String) -> Unit, editKey: String = "") {
    // editKey：从相亲画像网页点某一项过来改（改完直接回画像网页）
    var st by remember { mutableStateOf<HnState?>(null) }
    /** 答完以后聊天里放的那张画像卡片（点开是相亲画像网页） */
    var link by remember { mutableStateOf<HnCardBrief?>(null) }
    /** AI 深聊做了没有：没做过的，确认基本画像后邀请一下 */
    var deep by remember { mutableStateOf("") }
    var inviteOff by remember { mutableStateOf(false) }
    /** 后台要求先做实人认证、而我还没做 */
    var needKyc by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    /** 画像出来以后，正在重新回答的那一题 */
    var editing by remember { mutableStateOf<String?>(null) }
    var input by remember { mutableStateOf("") }
    var picked by remember { mutableStateOf<List<String>>(emptyList()) }
    /** 滚轮停在第几格 */
    var wheelIdx by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var showCity by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val scroll = rememberScrollState()
    fun toast(msg: String) = android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_SHORT).show()

    fun load() {
        failed = false
        scope.launch {
            runCatching { Api.getObj<HnState>("/hn/interview") }
                .onSuccess { s ->
                    st = s
                    if (editKey.isNotEmpty() && s.questions.any { it.key == editKey }) editing = editKey
                }
                .onFailure { failed = true }
        }
    }
    LaunchedEffect(Unit) { load() }

    val state = st
    LaunchedEffect(state?.complete, state?.confirmed, state?.profile?.summary) {
        if (state?.complete != true) return@LaunchedEffect
        link = runCatching { Api.getObj<HnCardBrief>("/hn/card/me") }.getOrNull() ?: link
        deep = runCatching { Api.getObj<com.wh.hongniang.net.UserProfile>("/user/me").deepStatus }.getOrNull() ?: deep
    }
    // 后台要求先做实人认证、而我还没做：答完题后多一步「去完成实人认证」。认证完（网页通知原生）会重新取一次
    LaunchedEffect(state?.complete, HnEvents.version) {
        if (state?.complete != true) return@LaunchedEffect
        runCatching { Api.request("/kyc/status") as? kotlinx.serialization.json.JsonObject }.getOrNull()?.let { s ->
            fun flag(k: String) = (s[k] as? JsonPrimitive)?.content == "true"
            needKyc = flag("required") && !flag("realname")
        }
    }
    val current = when {
        state == null -> null
        editing != null -> state.questions.firstOrNull { it.key == editing }
        else -> state.questions.firstOrNull { !it.answered }
    }
    val answeredCount = state?.questions?.count { it.answered } ?: 0

    // 换题时重置回答区；改已经答过的题时带上原来的回答（多选的勾、滚轮的位置、自己填的字）
    LaunchedEffect(current?.key, editing) {
        val q = current
        val old = q?.value?.firstOrNull().orEmpty()
        val typed = q != null && old.isNotEmpty() && (q.type == "text" || (q.type == "single" && old !in q.options))
        input = if (typed) old else ""
        picked = if (q?.type == "multi") q.value else emptyList()
        if (q?.type == "number") wheelIdx = hnWheelStart(q)
    }
    // 有新内容就滚到底
    LaunchedEffect(answeredCount, editing, state?.complete, state?.confirmed) {
        kotlinx.coroutines.delay(60)
        scroll.animateScrollTo(scroll.maxValue)
    }

    fun submit(value: List<String>) {
        val q = current ?: return
        if (busy) return
        busy = true
        scope.launch {
            runCatching {
                val data = Api.request("/hn/interview/answer", "POST", buildJsonObject {
                    put("key", q.key)
                    put("value", buildJsonArray { value.forEach { add(JsonPrimitive(it)) } })
                })
                Api.json.decodeFromJsonElement(HnState.serializer(), data!!)
            }.onSuccess {
                st = it
                HnEvents.version++
                // 从画像网页点过来改的：改完回画像网页
                if (editKey.isNotEmpty() && editing == editKey) onBack() else editing = null
            }.onFailure { toast(it.message ?: t("common.requestFailed")) }
            busy = false
        }
    }

    fun confirm() {
        if (busy) return
        busy = true
        scope.launch {
            runCatching {
                Api.json.decodeFromJsonElement(HnState.serializer(), Api.request("/hn/interview/confirm", "POST")!!)
            }.onSuccess { st = it; HnEvents.version++; toast(t("hn.done")) }
                .onFailure { toast(it.message ?: t("common.requestFailed")) }
            busy = false
        }
    }

    Column(Modifier.fillMaxSize().background(Bg)) {
        NavBar(t("hn.title"), onBack) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(end = 8.dp)) {
                // 明确标出对面是人工智能，不是真人
                Text(
                    t("hn.aiBadge"), color = Accent, fontSize = 10.sp,
                    modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(Accent.copy(alpha = 0.12f)).padding(horizontal = 5.dp, vertical = 2.dp),
                )
                if (state != null) {
                    Text(
                        t("hn.progress", "n" to answeredCount, "total" to state.questions.size),
                        color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
        }

        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(12.dp, 8.dp)) {
            if (state == null) {
                Box(Modifier.fillMaxWidth().padding(vertical = 80.dp).noRippleClick { if (failed) load() }, contentAlignment = Alignment.Center) {
                    Text(if (failed) t("hn.loadFailed") else t("common.loading"), color = TextSub, fontSize = 14.sp)
                }
            } else {
                // 还没答完：开场白 + 已经答过的一问一答；答完后只留画像，不重放整段对话
                if (!state.complete) {
                    state.intro.forEach { HnBubble(it, mine = false) }
                    state.questions.filter { it.answered }.forEach { q ->
                        HnBubble(q.ask, mine = false)
                        HnBubble(q.display, mine = true, myAvatar = myAvatar)
                    }
                } else {
                    // 答完以后：聊天里只放一张画像卡片（像一条网页链接），点开是相亲画像网页，头像、昵称、照片、每一项都在那一页；
                    // 想改哪一项，在那一页点它，会回到这里重新回答。原来这里那张很长的表格去掉了（用户 2026-11-23 要求）。
                    HnBubble(
                        if (state.confirmed) "你的资料已经收集完成，可以去找人聊天了。想改哪一项，点开下面的画像，点那一项就行。"
                        else "都问完了。我把你的相亲画像整理成了一页，点开看看对不对，没问题就点「确认」。",
                        mine = false,
                    )
                    link?.let { c -> PortraitLinkCard(c, Modifier.padding(start = 46.dp, top = 4.dp, bottom = 12.dp).widthIn(max = 330.dp)) { onNav(hnH5("/card/me")) } }
                    if (!state.confirmed && editing == null) {
                        Column(Modifier.padding(start = 46.dp, bottom = 12.dp).widthIn(max = 330.dp)) {
                            HnButton(t("hn.confirm"), Modifier.fillMaxWidth(), enabled = !busy) { confirm() }
                            Text("哪里不对，点开上面的画像，点那一项就能改", color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 8.dp))
                        }
                    }
                    // 最后一步：实人认证（后台要求且还没做时才出现；做过才能聊天 / 发动态 / 评论）。认证页是网页，内嵌打开
                    if (needKyc && editing == null) {
                        HnBubble("最后一步：做个实人认证，画像就完成了，之后就能发动态、评论、视频见面。身份证 + 刷脸，一次完成，扣 1 牵豆。", mine = false)
                        Column(Modifier.padding(start = 46.dp, bottom = 12.dp).widthIn(max = 330.dp)) {
                            HnButton("去完成实人认证", Modifier.fillMaxWidth(), height = 44.dp) { onNav(hnH5("/kyc?next=/interview")) }
                        }
                    }
                    // 基本画像确认后，没深聊过的邀请一下（可选，花一点模型费）
                    if (state.confirmed && editing == null && deep == "none" && !inviteOff) {
                        HnBubble("想让我更了解你吗？和我深聊 10 分钟，聊聊性格和想法，推荐会更准。这一步用的是真的 AI，会花几分钱的模型费，不聊也不影响你找人聊天。", mine = false)
                        Row(Modifier.padding(start = 46.dp, bottom = 12.dp).widthIn(max = 330.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            HnButton("以后再说", Modifier.weight(1f), ghost = true, height = 44.dp) { inviteOff = true }
                            HnButton("开始深聊", Modifier.weight(1.4f), height = 44.dp) { onNav("deep") }
                        }
                    }
                }
                if (editing != null && current != null) HnBubble(t("hn.editAgain"), mine = false)
                if (current != null) HnBubble(current.ask, mine = false)
            }
        }

        // ===== 底部回答区：每种题一种回答方式（滚轮 / 点选项 / 多选 / 点城市 / 多行输入） =====
        if (state != null && current != null) {
            val q = current
            val textLimit = if (q.max > 0) q.max else if (q.type == "text") 100 else 20
            Column(Modifier.fillMaxWidth().background(Bg2).navigationBarsPadding().imePadding().padding(12.dp, 10.dp)) {
                when (q.type) {
                    // 数字题（出生年份、身高）：滚轮拨到哪格算哪格，点「确定」提交
                    "number" -> {
                        key(q.key, editing) { HnWheel(hnWheelLabels(q), hnWheelStart(q)) { wheelIdx = it } }
                        AccentButton(t("common.ok"), enabled = !busy, modifier = Modifier.padding(top = 10.dp)) {
                            submit(listOf((q.min + wheelIdx).toString()))
                        }
                    }
                    "single", "multi" -> {
                        FlowRow(
                            Modifier.fillMaxWidth().heightIn(max = 260.dp).verticalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            q.options.forEach { o ->
                                // 单选题改答案时，原来选的那个亮着
                                val on = if (q.type == "multi") o in picked else q.value.firstOrNull() == o
                                HnChip(o, on) {
                                    when {
                                        q.type == "single" -> submit(listOf(o))
                                        on -> picked = picked - o
                                        q.max > 0 && picked.size >= q.max -> toast(q.ask)
                                        else -> picked = picked + o
                                    }
                                }
                            }
                        }
                        // 单选题带「自己填」：选项里没有合适的就在这里打字
                        if (q.type == "single" && q.custom) {
                            Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                HnInput(input, q.hint, lines = 1, modifier = Modifier.weight(1f)) { input = it.take(textLimit) }
                                HnSend(enabled = input.trim().isNotEmpty() && !busy) { submit(listOf(input.trim())) }
                            }
                        }
                    }
                    // 城市题：自己所在的城市 + 热门城市直接点，其余的点「其他城市」打开完整列表
                    "city" -> {
                        val cur = q.value.firstOrNull()
                        val cities = (listOfNotNull(cur, myCity.takeIf { it.isNotEmpty() }) + HOT_CITIES).distinct()
                        FlowRow(
                            Modifier.fillMaxWidth().heightIn(max = 260.dp).verticalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            cities.forEach { c -> HnChip(c, on = c == cur) { submit(listOf(c)) } }
                            HnChip(t("hn.moreCity") + " ›", on = false, accent = true) { if (!busy) showCity = true }
                        }
                    }
                    // 填空题（自我介绍）：示例句点一下填进去，再自己改
                    else -> {
                        // 键盘弹起来以后屏幕不够高，示例句先收起
                        if (q.samples.isNotEmpty() && !WindowInsets.isImeVisible) {
                            Text(t("hn.sampleHint"), color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(bottom = 6.dp))
                            Column(Modifier.fillMaxWidth().heightIn(max = 170.dp).verticalScroll(rememberScrollState())) {
                                q.samples.forEach { s ->
                                    Text(
                                        s, color = TextMain, fontSize = 13.sp, lineHeight = 19.sp,
                                        modifier = Modifier.padding(bottom = 6.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg3)
                                            .noRippleClick { input = s.take(textLimit) }.padding(12.dp, 9.dp),
                                    )
                                }
                            }
                            Spacer(Modifier.height(4.dp))
                        }
                        HnInput(input, q.hint, lines = 3, modifier = Modifier.fillMaxWidth()) { input = it.take(textLimit) }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (editing != null) {
                        Text(
                            t("common.cancel"), color = TextSub, fontSize = 14.sp,
                            modifier = Modifier.noRippleClick { if (editKey.isNotEmpty() && editing == editKey) onBack() else editing = null }.padding(vertical = 6.dp),
                        )
                    }
                    Spacer(Modifier.weight(1f))
                    if (q.optional) {
                        Text(state.skipText, color = TextSub, fontSize = 14.sp, modifier = Modifier.noRippleClick { submit(emptyList()) }.padding(vertical = 6.dp, horizontal = 4.dp))
                    }
                    if (q.type == "multi") {
                        val can = picked.isNotEmpty() && !busy
                        Text(
                            t("hn.multiDone", "n" to picked.size), color = if (can) Color.White else TextDim, fontSize = 14.sp,
                            modifier = Modifier.padding(start = 10.dp).clip(RoundedCornerShape(18.dp)).background(if (can) Accent else Bg3)
                                .noRippleClick { if (can) submit(picked) }.padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }
                    if (q.type == "text") {
                        Text("${input.length}/$textLimit", color = TextDim, fontSize = 12.sp, modifier = Modifier.padding(start = 10.dp, end = 10.dp))
                        HnSend(enabled = input.trim().isNotEmpty() && !busy) { submit(listOf(input.trim())) }
                    }
                }
            }
        }
    }

    if (showCity) {
        CityPickerSheet(
            current = current?.value?.firstOrNull() ?: myCity,
            onClose = { showCity = false },
            onSelect = { showCity = false; submit(listOf(it)) },
        )
    }
}

/** 滚轮每一格的文字（服务端给了就用服务端的，出生年份会带岁数） */
private fun hnWheelLabels(q: HnQuestion): List<String> =
    q.wheel.ifEmpty { (q.min..maxOf(q.max, q.min)).map { it.toString() } }

/** 滚轮一开始停在第几格：改答案时停在原来的值，否则停在默认值 */
private fun hnWheelStart(q: HnQuestion): Int {
    val n = q.value.firstOrNull()?.toIntOrNull() ?: if (q.def > 0) q.def else q.min
    return (n - q.min).coerceIn(0, hnWheelLabels(q).size - 1)
}

/** 滚轮：上下拨，停在中间那一格就是选中的；松手自动对齐，点某一格直接滚过去 */
@Composable
private fun HnWheel(labels: List<String>, start: Int, onPick: (Int) -> Unit) {
    val rowH = 40.dp
    val rowPx = with(LocalDensity.current) { rowH.toPx() }
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = start)
    val scope = rememberCoroutineScope()
    // 上下各留两格空白，所以「第一个可见项」正好是中间那一格；滚过半格就算下一格
    val center by remember(labels.size) {
        derivedStateOf {
            (listState.firstVisibleItemIndex + if (listState.firstVisibleItemScrollOffset > rowPx / 2) 1 else 0)
                .coerceIn(0, labels.size - 1)
        }
    }
    LaunchedEffect(center) { onPick(center) }
    LaunchedEffect(listState.isScrollInProgress) {
        if (!listState.isScrollInProgress && listState.firstVisibleItemScrollOffset != 0) listState.animateScrollToItem(center)
    }
    Box(Modifier.fillMaxWidth().height(rowH * 5)) {
        Box(Modifier.align(Alignment.Center).fillMaxWidth().height(rowH).clip(RoundedCornerShape(12.dp)).background(Bg3))
        LazyColumn(state = listState, contentPadding = PaddingValues(vertical = rowH * 2), modifier = Modifier.fillMaxSize()) {
            itemsIndexed(labels) { i, label ->
                val on = i == center
                Box(
                    Modifier.fillMaxWidth().height(rowH).noRippleClick { scope.launch { listState.animateScrollToItem(i) } },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label, color = if (on) TextMain else TextDim,
                        fontSize = if (on) 18.sp else 15.sp, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
                    )
                }
            }
        }
    }
}

/** 选项小圆角块：选中的是渐变色；accent = 文字用主题色（「其他城市」） */
@Composable
private fun HnChip(text: String, on: Boolean, accent: Boolean = false, onClick: () -> Unit) {
    Text(
        text, color = if (on) Color.White else if (accent) Accent else TextMain, fontSize = 14.sp,
        modifier = Modifier.clip(RoundedCornerShape(18.dp))
            .background(if (on) Brush.horizontalGradient(listOf(Accent, Accent2)) else Brush.horizontalGradient(listOf(Bg3, Bg3)))
            .noRippleClick(onClick)
            .padding(horizontal = 14.dp, vertical = 9.dp),
    )
}

/** 输入框：lines = 1 是单行（自己填职业），大于 1 是多行（自我介绍） */
@Composable
private fun HnInput(value: String, hint: String, lines: Int, modifier: Modifier = Modifier, onChange: (String) -> Unit) {
    val style = TextStyle(color = TextMain, fontSize = 14.sp, lineHeight = 21.sp)
    Box(modifier.clip(RoundedCornerShape(if (lines > 1) 14.dp else 20.dp)).background(Bg3).padding(14.dp, 10.dp)) {
        if (value.isEmpty()) Text(hint.ifEmpty { t("hn.inputHint") }, style = style.copy(color = TextDim))
        BasicTextField(
            value = value,
            onValueChange = onChange,
            textStyle = style,
            cursorBrush = SolidColor(Accent),
            singleLine = lines == 1,
            minLines = lines,
            maxLines = if (lines > 1) 5 else 1,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun HnSend(enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.height(40.dp).clip(RoundedCornerShape(20.dp)).background(if (enabled) Accent else Bg3)
            .noRippleClick { if (enabled) onClick() }.padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { Text(t("common.send"), color = if (enabled) Color.White else TextDim, fontSize = 14.sp) }
}

/** 对话气泡：AI 红娘在左（渐变 AI 头像），我在右（自己头像） */
@Composable
private fun HnBubble(text: String, mine: Boolean, myAvatar: String = "") {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        if (mine) Spacer(Modifier.width(50.dp))
        if (!mine) {
            Box(
                Modifier.size(38.dp).clip(RoundedCornerShape(19.dp)).background(Brush.horizontalGradient(listOf(Accent, Accent2))),
                contentAlignment = Alignment.Center,
            ) { Text("AI", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold) }
            Spacer(Modifier.width(8.dp))
        }
        Box(
            Modifier.weight(1f, fill = false)
                .clip(if (mine) RoundedCornerShape(16.dp, 4.dp, 16.dp, 16.dp) else RoundedCornerShape(4.dp, 16.dp, 16.dp, 16.dp))
                .background(if (mine) BubbleMine else Bg3)
                .padding(14.dp, 10.dp),
        ) { Text(text, color = TextMain, fontSize = 15.sp, lineHeight = 22.sp) }
        if (mine) {
            Spacer(Modifier.width(8.dp))
            Avatar(myAvatar, 38)
        }
        if (!mine) Spacer(Modifier.width(50.dp))
    }
}

/** 画像里的小标签（自己的画像卡、别人主页的相亲资料卡共用） */
@Composable
fun MatchTag(text: String) {
    Text(
        text, color = Accent, fontSize = 12.sp,
        modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(Accent.copy(alpha = 0.1f)).padding(horizontal = 9.dp, vertical = 3.dp),
    )
}

/** 别人主页上的「相亲资料」：摘要 + 一句话介绍 + 标签 + 明细（对方完成资料收集后才有，不含收入） */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MatchProfileCard(p: com.wh.hongniang.net.MatchProfile) {
    Text(t("userHome.matchProfile"), color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 18.dp))
    Text(p.summary, color = TextMain, fontSize = 14.sp, lineHeight = 22.sp, modifier = Modifier.padding(top = 8.dp))
    if (p.intro.isNotEmpty()) Text("“${p.intro}”", color = TextSub, fontSize = 13.sp, lineHeight = 20.sp, modifier = Modifier.padding(top = 6.dp))
    FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        p.tags.forEach { MatchTag(it) }
    }
    listOf(p.about, p.prefs).forEachIndexed { i, rows ->
        if (rows.isNotEmpty()) {
            Column(Modifier.padding(top = 12.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg2).padding(horizontal = 14.dp, vertical = 4.dp)) {
                if (i == 1) Text(t("userHome.lookingFor"), color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp, bottom = 2.dp))
                rows.forEach { r ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 9.dp)) {
                        Text(r.label, color = TextSub, fontSize = 14.sp, modifier = Modifier.width(92.dp))
                        Text(r.value, color = TextMain, fontSize = 14.sp, textAlign = androidx.compose.ui.text.style.TextAlign.End, modifier = Modifier.weight(1f).padding(start = 10.dp))
                    }
                    Box(Modifier.fillMaxWidth().height(0.5.dp).background(Line))
                }
            }
        }
    }
}

/** 后台要求先做实人认证、没做就发消息时的提示框：带去认证页（网页，内嵌打开） */
@Composable
fun NeedKycDialog(onDismiss: () -> Unit, onGo: () -> Unit) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Bg2,
        title = { Text("先完成实人认证", color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
        text = { Text("发动态、评论、视频见面都要先做实人认证。\n身份证 + 刷脸，扣 1 牵豆。", color = TextSub, fontSize = 14.sp, lineHeight = 22.sp) },
        confirmButton = { Text("去认证", color = Accent, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick(onGo).padding(8.dp)) },
        dismissButton = { Text("以后再说", color = TextSub, modifier = Modifier.noRippleClick(onDismiss).padding(8.dp)) },
    )
}

/** 没完成资料收集就发消息 / 打电话时的提示框：带去 AI 红娘 */
@Composable
fun NeedProfileDialog(onDismiss: () -> Unit, onGo: () -> Unit) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Bg2,
        title = { Text(t("hn.needTitle"), color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
        text = { Text(t("hn.needBody"), color = TextSub, fontSize = 14.sp, lineHeight = 22.sp) },
        confirmButton = { Text(t("hn.needGo"), color = Accent, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick(onGo).padding(8.dp)) },
        dismissButton = { Text(t("common.cancel"), color = TextSub, modifier = Modifier.noRippleClick(onDismiss).padding(8.dp)) },
    )
}
