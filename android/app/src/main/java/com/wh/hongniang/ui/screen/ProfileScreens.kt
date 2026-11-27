package com.wh.hongniang.ui.screen

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.hongniang.net.*
import com.wh.hongniang.ui.*
import com.wh.hongniang.ui.theme.*
import kotlinx.coroutines.launch
import com.wh.hongniang.i18n.I18n
import com.wh.hongniang.i18n.t

/**
 * 我的。
 *
 * 排法照 iOS 系统「设置」：整页一起滚（头像卡、相亲画像、各个分组都在同一个滚动区里），
 * 顶上是大标题「我的」，往上滑到大标题看不见时，顶栏中间出现小标题；每一行左边一个彩色小图标，右边灰色的值和箭头；
 * 开关的说明写在分组下面的小灰字里。样稿：design/06-me.html（用户 2026-11-25 确认）。
 */
@Composable
fun MeScreen(modifier: Modifier = Modifier, initialUser: UserProfile?, onNav: (String) -> Unit) {
    var me by remember { mutableStateOf(initialUser) }
    // 资料收集有变化（答题 / 确认）时重新拉一次，回到这页能马上看到「已完成」
    /** AI 余额（元）；null = 还没取到 */
    var aiBalance by remember { mutableStateOf<String?>(null) }
    /** 后台要求先做实人认证、而我还没做：显示一行「真人认证 · 未完成」（做过才能聊天 / 发动态 / 评论） */
    var needKyc by remember { mutableStateOf(false) }
    /** 能登录这个账号的设备有几台；null = 还没取到 */
    var deviceCount by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(HnEvents.version) {
        me = runCatching { Api.getObj<UserProfile>("/user/me") }.getOrNull() ?: me
        aiBalance = runCatching {
            ((Api.request("/ai-wallet") as? kotlinx.serialization.json.JsonObject)?.get("balance") as? kotlinx.serialization.json.JsonPrimitive)?.content
        }.getOrNull() ?: aiBalance
        runCatching { Api.request("/kyc/status") as? kotlinx.serialization.json.JsonObject }.getOrNull()?.let { s ->
            fun flag(k: String) = (s[k] as? kotlinx.serialization.json.JsonPrimitive)?.content == "true"
            needKyc = flag("required") && !flag("realname")
        }
        runCatching { Api.request("/devices") as? kotlinx.serialization.json.JsonObject }.getOrNull()?.let { d ->
            deviceCount = (d["devices"] as? kotlinx.serialization.json.JsonArray)?.size ?: deviceCount
        }
    }
    val scope = rememberCoroutineScope()
    // 扫一扫（统一处理见 QrScan.kt rememberScanHandler）：邀请名片
    val startScan = rememberQrScan(onNav)
    val u = me ?: return

    val ctx = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scroll = rememberScrollState()
    // 大标题滚出去以后（大约 44dp），顶栏变成不透明的一条，中间出现小标题
    val collapseAt = with(LocalDensity.current) { 44.dp.toPx() }
    val collapsed by remember { derivedStateOf { scroll.value > collapseAt } }
    var picking by remember { mutableStateOf(false) }
    if (picking) LanguageDialog { picking = false }
    /** 正在看哪份协议：null = 没在看，false = 用户协议，true = 隐私政策 */
    var agreement by remember { mutableStateOf<Boolean?>(null) }
    agreement?.let { isPrivacy -> AgreementDialog(isPrivacy) { agreement = null } }
    val langName = if (I18n.choice == I18n.SYSTEM) t("lang.system") else I18n.languages.firstOrNull { it.first == I18n.choice }?.second.orEmpty()

    Box(modifier.fillMaxSize().background(Bg2)) {
        Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(top = 44.dp, bottom = 28.dp)) {
            Text(t("tab.me"), color = TextMain, fontSize = 32.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(start = 20.dp, bottom = 10.dp))

            // 第一张卡：我是谁。点了进「基本资料」（头像、昵称、签名、照片）；下半部分是关注 / 粉丝
            Column(Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg)) {
                Row(
                    Modifier.fillMaxWidth().clickable { onNav("edit-profile") }.padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Avatar(u.avatar, 62)
                    Column(Modifier.weight(1f).padding(start = 14.dp, end = 4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                u.nickname, color = TextMain, fontSize = 20.sp, fontWeight = FontWeight.Bold,
                                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                            )
                            if (u.realname) {
                                Text(
                                    "真人认证", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold, maxLines = 1,
                                    modifier = Modifier.padding(start = 7.dp).clip(RoundedCornerShape(9.dp)).background(Color(0xFF34C759)).padding(horizontal = 7.dp, vertical = 1.dp),
                                )
                            }
                        }
                        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            // 「女 27 · 成都」；没选城市就不写城市
                            val about = "${if (u.gender == 1) t("me.male") else t("me.female")} ${u.age}" + if (u.cityName.isNotEmpty()) " · ${u.cityName}" else ""
                            Text(about, color = TextSub, fontSize = 13.sp, maxLines = 1)
                            val sid = u.shortId
                            if (sid != null) {
                                // 点 ID 这一小段是复制，不进「基本资料」
                                Row(
                                    Modifier.noRippleClick {
                                        clipboard.setText(androidx.compose.ui.text.AnnotatedString(sid))
                                        android.widget.Toast.makeText(ctx, t("common.copied"), android.widget.Toast.LENGTH_SHORT).show()
                                    },
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(" · " + t("me.id", "id" to sid), color = TextSub, fontSize = 13.sp, maxLines = 1)
                                    Box(Modifier.padding(start = 4.dp)) { LineIcon(IC_COPY, TextSub, 12.dp) }
                                }
                            }
                        }
                        Text(
                            u.signature.ifEmpty { t("me.noSignature") }, color = TextSub, fontSize = 13.sp,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp),
                        )
                    }
                    LineIcon(IC_CHEVRON, TextDim, 15.dp)
                }
                Box(Modifier.fillMaxWidth().height(0.5.dp).background(Line))
                // 点击进关注 / 粉丝列表
                Row(verticalAlignment = Alignment.CenterVertically) {
                    MeStat(u.following, t("me.following"), Modifier.weight(1f)) { onNav("follows/following") }
                    Box(Modifier.width(0.5.dp).height(22.dp).background(Line))
                    MeStat(u.fans, t("me.fans"), Modifier.weight(1f)) { onNav("follows/fans") }
                }
            }

            // 我的相亲画像：基本情况（点选问答，必做）+ AI 深聊（可选）。没做完基本情况不能主动找人聊天
            MePortraitCard(u, Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp), onNav)

            MeGroup(t("me.group.content")) {
                MeCell(IC_IMAGE, Color(0xFFFF9500), t("me.myMoments"), first = true, onClick = { onNav("my-moments") }) { MeValue() }
            }
            // AI 费用：深聊这类 AI 功能按用量花模型费（平台余额或自己的 Key）；点进去是网页
            MeGroup("AI 费用") {
                MeCell(IC_WALLET, Color(0xFF34C759), "AI 余额", first = true, onClick = { onNav(hnH5("/ai-fee")) }) { MeValue(aiBalance?.let { "¥$it" }) }
            }
            // 账号与安全：真人认证（后台要求且还没做时才出现）、登录设备（换手机刷脸找回后会多出来，可以移除）；点进去都是网页
            MeGroup("账号与安全", footer = if (needKyc) "做过真人认证才能聊天、发动态、评论。认证一次 ¥1。" else null) {
                if (needKyc) {
                    MeCell(IC_SHIELD, Color(0xFFFF9500), "真人认证", first = true, onClick = { onNav(hnH5("/kyc?next=/me")) }) { MeValue("未完成", dot = true) }
                }
                MeCell(IC_LOCK, Color(0xFF007AFF), "登录设备", first = !needKyc, onClick = { onNav(hnH5("/devices")) }) { MeValue(deviceCount?.let { "$it 台" }) }
            }
            MeGroup(
                t("me.group.settings"),
                // 开关的说明：写在这一组下面
                footer = "${t("me.videoMeet")}：${t("me.videoMeetSub")}" + if (u.gender == 1) "\n${t("me.camDefault")}：${t("me.camDefaultSub")}" else "",
            ) {
                // 相亲资料 = AI 红娘的那页问答（头像 / 昵称 / 照片墙在最上面那张卡里改）
                MeCell(IC_HEART, Accent, "相亲资料", first = true, onClick = { onNav("interview") }) { MeValue(if (u.profileDone) "已填完" else "未填完") }
                // 视频见面：默认关，自己和对方都打开才能互相发起视频通话
                MeCell(IC_VIDEO, Color(0xFF5AC8FA), t("me.videoMeet")) {
                    androidx.compose.material3.Switch(
                        checked = u.allowVideo,
                        onCheckedChange = { on ->
                            val before = u
                            me = u.copy(allowVideo = on)
                            scope.launch {
                                runCatching {
                                    Api.request("/user/me", "PUT", kotlinx.serialization.json.buildJsonObject {
                                        put("allowVideo", kotlinx.serialization.json.JsonPrimitive(on))
                                    })
                                }.onFailure { me = before }
                            }
                        },
                        colors = androidx.compose.material3.SwitchDefaults.colors(checkedTrackColor = Accent),
                    )
                }
                // 男方专属：视频通话默认是否开启自己画面（默认关闭；女方无此设置）
                if (u.gender == 1) {
                    var camOn by remember { mutableStateOf(Api.camDefaultOn) }
                    MeCell(IC_CAMERA, Color(0xFF5856D6), t("me.camDefault")) {
                        androidx.compose.material3.Switch(
                            checked = camOn,
                            onCheckedChange = { camOn = it; Api.camDefaultOn = it },
                            colors = androidx.compose.material3.SwitchDefaults.colors(checkedTrackColor = Accent),
                        )
                    }
                }
                MeCell(IC_GLOBE, Color(0xFF8E8E93), t("lang.title"), onClick = { picking = true }) { MeValue(langName) }
            }
            MeGroup(t("me.group.about")) {
                MeCell(IC_DOC, Color(0xFF8E8E93), t("agreement.userTitle"), first = true, onClick = { agreement = false }) { MeValue() }
                MeCell(IC_SHIELD, Color(0xFF8E8E93), t("agreement.privacyTitle"), onClick = { agreement = true }) { MeValue() }
            }
            Text(
                "${t("app.name")} ${com.wh.hongniang.BuildConfig.VERSION_NAME}", color = TextDim, fontSize = 12.sp,
                modifier = Modifier.fillMaxWidth().padding(top = 22.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            // App 的 ICP 备案号：点了用系统浏览器打开工信部的备案查询网站（不在 App 里开；手机上没有浏览器就什么也不做）
            Box(Modifier.fillMaxWidth().padding(top = 2.dp), contentAlignment = Alignment.Center) {
                Text(
                    Api.APP_ICP_NO, color = TextDim, fontSize = 12.sp,
                    modifier = Modifier
                        .clickable {
                            runCatching {
                                ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(Api.ICP_QUERY_URL)))
                            }
                        }
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }

        // 顶栏：盖在内容上面。扫一扫一直在右上角；滑动以后变成不透明的一条，中间出现小标题
        Column(Modifier.fillMaxWidth().background(if (collapsed) Bg2 else Color.Transparent)) {
            Box(Modifier.fillMaxWidth().height(44.dp)) {
                if (collapsed) Text(t("tab.me"), color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.Center))
                Box(
                    Modifier.align(Alignment.CenterEnd).padding(end = 6.dp).size(44.dp).noRippleClick(startScan),
                    contentAlignment = Alignment.Center,
                ) { ScanIcon(Accent, 20.dp) }
            }
            if (collapsed) Box(Modifier.fillMaxWidth().height(0.5.dp).background(Line))
        }
    }
}

/** 「12 关注」这样的一小块，点了进列表 */
@Composable
private fun MeStat(n: Int, label: String, modifier: Modifier, onClick: () -> Unit) {
    Row(
        modifier.clickable(onClick = onClick).padding(vertical = 11.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("$n", color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.Bold)
        Text(" $label", color = TextSub, fontSize = 13.sp)
    }
}

/** 「我的」页一个功能分组：小标题 + 白色圆角卡片 + （可选）下面一行小灰字说明 */
@Composable
private fun MeGroup(title: String, footer: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 22.dp)) {
        Text(title, color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(start = 16.dp, bottom = 7.dp))
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg), content = content)
        if (footer != null) Text(footer, color = TextSub, fontSize = 12.sp, lineHeight = 18.sp, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 7.dp))
    }
}

/**
 * 分组里的一行：彩色小图标 + 名字 + 右边的东西（值和箭头 / 开关）。
 * 第一行上面不画分隔线；分隔线从文字开始的位置画起。onClick 为空的行（带开关的）整行不可点。
 */
@Composable
private fun MeCell(
    icon: List<String>, color: Color, title: String, first: Boolean = false, onClick: (() -> Unit)? = null,
    trailing: @Composable RowScope.() -> Unit,
) {
    if (!first) Box(Modifier.fillMaxWidth().padding(start = 57.dp).height(0.5.dp).background(Line))
    Row(
        Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .heightIn(min = 48.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(29.dp).clip(RoundedCornerShape(7.dp)).background(color), contentAlignment = Alignment.Center) {
            LineIcon(icon, Color.White, 17.dp)
        }
        Text(
            title, color = TextMain, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).padding(start = 12.dp, end = 8.dp),
        )
        trailing()
    }
}

/** 一行右边：（橙色小点）+ 灰色的值 + 箭头 */
@Composable
private fun MeValue(value: String? = null, dot: Boolean = false) {
    if (dot) Box(Modifier.padding(end = 7.dp).size(8.dp).clip(CircleShape).background(Color(0xFFFF9500)))
    if (value != null) Text(value, color = TextSub, fontSize = 15.sp, maxLines = 1, modifier = Modifier.padding(end = 7.dp))
    LineIcon(IC_CHEVRON, TextDim, 15.dp)
}

/**
 * 线条小图标：24×24 画板上的一组 SVG 路径，按给的大小等比画出来（线宽 2，圆头圆角）。
 * 和网页（hn.tsx 的 Ic）、样稿用的是同一套图标；圆和圆角矩形这里写成了等价的路径。
 */
@Composable
private fun LineIcon(paths: List<String>, tint: Color, size: androidx.compose.ui.unit.Dp) {
    val parsed = remember(paths) { paths.map { PathParser().parsePathString(it).toPath() } }
    Canvas(Modifier.size(size)) {
        val k = this.size.minDimension / 24f
        scale(k, k, pivot = Offset.Zero) {
            parsed.forEach { drawPath(it, tint, style = Stroke(width = 2f, cap = StrokeCap.Round, join = StrokeJoin.Round)) }
        }
    }
}

private val IC_CHEVRON = listOf("m9 18 6-6-6-6")
private val IC_COPY = listOf(
    "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
    "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
)
private val IC_IMAGE = listOf(
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M7 9a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
    "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
)
private val IC_WALLET = listOf(
    "M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1",
    "M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4",
)
private val IC_SHIELD = listOf(
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "m9 12 2 2 4-4",
)
private val IC_LOCK = listOf(
    "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z",
    "M7 11V7a5 5 0 0 1 10 0v4",
)
private val IC_HEART = listOf(
    "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
)
private val IC_VIDEO = listOf(
    "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5",
    "M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
)
private val IC_CAMERA = listOf(
    "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z",
    "M9 13a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
)
private val IC_GLOBE = listOf(
    "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0",
    "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
    "M2 12h20",
)
private val IC_DOC = listOf(
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    "M14 2v4a2 2 0 0 0 2 2h4",
    "M16 13H8",
    "M16 17H8",
)

/** 语言选择：跟随系统 + 打包进来的每种语言（名字用各自的语言写） */
@Composable
private fun LanguageDialog(onDismiss: () -> Unit) {
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Bg2).padding(vertical = 8.dp)) {
            Text(t("lang.title"), color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(20.dp, 12.dp))
            (listOf(I18n.SYSTEM to t("lang.system")) + I18n.languages).forEach { (code, name) ->
                Row(
                    Modifier.fillMaxWidth().clickable { I18n.select(code); onDismiss() }.padding(20.dp, 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(name, color = TextMain, fontSize = 15.sp, modifier = Modifier.weight(1f))
                    if (I18n.choice == code) Text("✓", color = Accent, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

/** 关注/粉丝列表（我的页面点击数字进入） */
@Composable
fun FollowListScreen(type: String, onBack: () -> Unit, onOpenUser: (String) -> Unit) {
    val title = if (type == "fans") t("me.fans") else t("me.following")
    var list by remember { mutableStateOf<List<FollowUser>?>(null) }
    LaunchedEffect(type) {
        list = runCatching { Api.getList<FollowUser>("/user/follows/list?type=$type") }.getOrDefault(emptyList())
    }
    Column(Modifier.fillMaxSize()) {
        NavBar(title, onBack)
        val items = list
        when {
            items == null -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
                Text(t("common.loading"), color = TextDim, fontSize = 13.sp)
            }
            items.isEmpty() -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
                Text(if (type == "fans") t("me.noFans") else t("me.noFollowing"), color = TextDim, fontSize = 13.sp)
            }
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(items, key = { it.id }) { u ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onOpenUser(u.id) }.padding(16.dp, 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(u.avatar, 46)
                        Column(Modifier.weight(1f).padding(start = 12.dp)) {
                            Text(u.nickname, color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            val sub = u.signature.ifEmpty { u.cityName }
                            if (sub.isNotEmpty()) {
                                Text(sub, color = TextSub, fontSize = 12.sp, maxLines = 1, modifier = Modifier.padding(top = 3.dp))
                            }
                        }
                        Text("›", color = TextDim, fontSize = 18.sp)
                    }
                    Box(Modifier.fillMaxWidth().padding(start = 74.dp).height(0.5.dp).background(Line))
                }
            }
        }
    }
}

/** 实名认证（仅女生）：姓名 + 身份证号，后端本地核验校验位，一证一号 */
@Composable
fun RealnameScreen(onBack: () -> Unit) {
    var me by remember { mutableStateOf<UserProfile?>(null) }
    var name by remember { mutableStateOf("") }
    var idCard by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { me = runCatching { Api.getObj<UserProfile>("/user/me") }.getOrNull() }

    Column(modifier = Modifier.fillMaxSize()) {
        NavBar(t("realname.title"), onBack)
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (me?.realname == true) {
                Column(
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Bg2).padding(vertical = 40.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(t("realname.done"), color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    Text(t("realname.verifiedName", "name" to (me?.realNameMasked ?: "")), color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
                }
            } else {
                Column(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Bg2).padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(t("realname.name"), color = TextSub, fontSize = 13.sp)
                        androidx.compose.foundation.text.BasicTextField(
                            value = name,
                            onValueChange = { name = it.take(20) },
                            textStyle = androidx.compose.ui.text.TextStyle(color = TextMain, fontSize = 16.sp),
                            cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                            singleLine = true,
                            decorationBox = { inner ->
                                Box(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Bg3).padding(12.dp)) {
                                    if (name.isEmpty()) Text(t("realname.namePlaceholder"), color = TextDim, fontSize = 16.sp)
                                    inner()
                                }
                            },
                        )
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(t("realname.idCardNo"), color = TextSub, fontSize = 13.sp)
                        androidx.compose.foundation.text.BasicTextField(
                            value = idCard,
                            onValueChange = { v -> idCard = v.uppercase().filter { it.isDigit() || it == 'X' }.take(18) },
                            textStyle = androidx.compose.ui.text.TextStyle(color = TextMain, fontSize = 16.sp),
                            cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                            singleLine = true,
                            decorationBox = { inner ->
                                Box(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Bg3).padding(12.dp)) {
                                    if (idCard.isEmpty()) Text(t("realname.idCardPlaceholder"), color = TextDim, fontSize = 16.sp)
                                    inner()
                                }
                            },
                        )
                    }
                    Text(t("realname.privacy"), color = TextDim, fontSize = 12.sp)
                }
                AccentButton(if (busy) t("realname.submitting") else t("realname.submit"), enabled = !busy && name.length >= 2 && idCard.length == 18) {
                    busy = true
                    scope.launch {
                        val body = kotlinx.serialization.json.buildJsonObject {
                            put("name", kotlinx.serialization.json.JsonPrimitive(name.trim()))
                            put("idCard", kotlinx.serialization.json.JsonPrimitive(idCard))
                        }
                        runCatching { Api.request("/user/realname", "POST", body) }
                            .onSuccess {
                                toast = t("realname.success")
                                me = runCatching { Api.getObj<UserProfile>("/user/me") }.getOrNull() ?: me
                            }
                            .onFailure { toast = it.message ?: t("realname.failed") }
                        busy = false
                    }
                }
            }
            if (toast.isNotEmpty()) Text(toast, color = Accent, fontSize = 13.sp, modifier = Modifier.align(Alignment.CenterHorizontally))
        }
    }
}
