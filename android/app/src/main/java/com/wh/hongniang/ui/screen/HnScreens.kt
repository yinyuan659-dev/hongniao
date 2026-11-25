package com.wh.hongniang.ui.screen

import android.annotation.SuppressLint
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import coil.compose.AsyncImage
import com.wh.hongniang.net.Api
import com.wh.hongniang.net.UserProfile
import com.wh.hongniang.ui.noRippleClick
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * AI 红娘新页面共用的东西：新观感的颜色和小零件、内嵌网页容器、画像卡片。
 * 新观感（暖色渐变底、白色圆角卡片、渐变按钮）和网页端 web/src/hn.css 是一套，样稿在 design/。
 * 深聊是原生写的（DeepChatScreen.kt）；相亲画像和 AI 费用是网页，用这里的 HnWebScreen 打开（用户 2026-11-23 定的）。
 */

val HnRose = Color(0xFFFF3D63)
val HnCoral = Color(0xFFFF8469)
val HnInk = Color(0xFF2B1C22)
val HnInk2 = Color(0xFF8C7D83)
val HnInk3 = Color(0xFFBCB0B4)
val HnSoft = Color(0x17FF3D63)
val HnLine = Color(0x142B1C22)
val HnGrad = Brush.linearGradient(listOf(HnRose, HnCoral))
/** 整页的底色：上粉、中间米白、下淡紫 */
val HnPageBg = Brush.verticalGradient(listOf(Color(0xFFFFE2E8), Color(0xFFFFF8F4), Color(0xFFFFF8F4), Color(0xFFF3ECFF)))

/** 导航到某个内嵌网页：route 是网页里 # 后面的路径，例如 /card/me、/ai-fee */
fun hnH5(route: String): String = "h5?route=" + android.net.Uri.encode(route)

/** AI 红娘的头像：渐变小球 + 爱心 */
@Composable
fun HnOrb(size: Dp = 38.dp) {
    Box(
        Modifier.size(size).shadow(6.dp, CircleShape, ambientColor = HnRose, spotColor = HnRose).clip(CircleShape).background(HnGrad),
        contentAlignment = Alignment.Center,
    ) { Text("♥", color = Color.White, fontSize = (size.value * 0.46f).sp) }
}

/** 主按钮（渐变）/ 次按钮（白底） */
@Composable
fun HnButton(text: String, modifier: Modifier = Modifier, ghost: Boolean = false, enabled: Boolean = true, height: Dp = 50.dp, onClick: () -> Unit) {
    val shape = RoundedCornerShape(height / 2)
    Box(
        modifier.height(height)
            .then(if (enabled) Modifier.shadow(if (ghost) 3.dp else 8.dp, shape, ambientColor = if (ghost) HnInk3 else HnRose, spotColor = if (ghost) HnInk3 else HnRose) else Modifier)
            .clip(shape)
            .then(if (ghost) Modifier.background(Color.White) else Modifier.background(HnGrad, alpha = if (enabled) 1f else 0.45f))
            .noRippleClick { if (enabled) onClick() },
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = if (ghost) HnInk else Color.White, fontSize = if (ghost) 15.sp else 16.sp, fontWeight = if (ghost) FontWeight.Medium else FontWeight.Bold)
    }
}

/** 小胶囊按钮 */
@Composable
fun HnPill(text: String, ghost: Boolean = false, height: Dp = 36.dp, onClick: () -> Unit) {
    val shape = RoundedCornerShape(height / 2)
    Box(
        Modifier.height(height).shadow(if (ghost) 2.dp else 5.dp, shape, ambientColor = if (ghost) HnInk3 else HnRose, spotColor = if (ghost) HnInk3 else HnRose)
            .clip(shape).then(if (ghost) Modifier.background(Color.White) else Modifier.background(HnGrad))
            .noRippleClick(onClick).padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, color = if (ghost) HnInk2 else Color.White, fontSize = 13.sp, fontWeight = if (ghost) FontWeight.Medium else FontWeight.SemiBold) }
}

/** 顶栏上的白色圆按钮（返回、更多） */
@Composable
fun HnCircleBtn(glyph: String, onClick: () -> Unit) {
    Box(
        Modifier.size(34.dp).shadow(2.dp, CircleShape, ambientColor = HnInk3, spotColor = HnInk3).clip(CircleShape).background(Color.White.copy(alpha = 0.9f)).noRippleClick(onClick),
        contentAlignment = Alignment.Center,
    ) { Text(glyph, color = HnInk, fontSize = if (glyph == "‹") 22.sp else 14.sp, fontWeight = FontWeight.Bold) }
}

// ---------- 画像卡片（聊天里的那张，点开是相亲画像网页） ----------

@Serializable
data class HnCardUser(val id: String = "", val nickname: String = "", val age: Int = 0)

@Serializable
data class HnCardAi(val summary: String = "")

/** GET /hn/card/me 里画像卡片用到的那几项 */
@Serializable
data class HnCardBrief(
    val user: HnCardUser = HnCardUser(),
    val photos: List<String> = emptyList(),
    /** 压在照片下方的小标签：城市、身高、学历、职业… */
    val hero: List<String> = emptyList(),
    val ai: HnCardAi? = null,
)

/** 聊天里的画像卡片：像别人发来的一条网页链接 */
@Composable
fun PortraitLinkCard(card: HnCardBrief, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(22.dp)
    Column(
        modifier.fillMaxWidth().shadow(10.dp, shape, ambientColor = HnRose, spotColor = HnRose).clip(shape).background(Color.White).noRippleClick(onClick),
    ) {
        Box(Modifier.fillMaxWidth().height(150.dp).background(Color(0xFFF1E6E8))) {
            card.photos.firstOrNull()?.let {
                AsyncImage(model = Api.fullUrl(it), contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop, alignment = Alignment.TopCenter)
            }
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.4f to Color.Transparent, 1f to Color(0xC71E0C12))))
            Column(Modifier.align(Alignment.BottomStart).padding(start = 14.dp, end = 14.dp, bottom = 11.dp)) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(card.user.nickname, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
                    if (card.user.age > 0) Text("  ${card.user.age}", color = Color.White, fontSize = 17.sp)
                }
                Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    card.hero.take(4).forEach { h ->
                        Text(
                            h, color = Color.White, fontSize = 11.5.sp, maxLines = 1,
                            modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(Color.White.copy(alpha = 0.24f))
                                .border(1.dp, Color.White.copy(alpha = 0.35f), RoundedCornerShape(12.dp)).padding(horizontal = 10.dp, vertical = 3.dp),
                        )
                    }
                }
            }
        }
        Column(Modifier.padding(start = 14.dp, end = 14.dp, top = 12.dp, bottom = 13.dp)) {
            Text("${card.user.nickname}的相亲画像", color = HnInk, fontSize = 15.5.sp, fontWeight = FontWeight.ExtraBold)
            Text(
                card.ai?.summary.orEmpty(), color = HnInk2, fontSize = 13.sp, lineHeight = 20.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 4.dp),
            )
            Box(Modifier.padding(top = 10.dp).fillMaxWidth().height(1.dp).background(HnLine))
            Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("点开查看完整画像", color = HnRose, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text("›", color = HnRose, fontSize = 16.sp)
            }
        }
    }
}

// ---------- 「我的」页最上面的画像卡片 ----------

private val DEEP_LABEL = mapOf("none" to "和 AI 红娘深聊", "chatting" to "继续聊", "draft" to "去确认画像", "done" to "再聊聊")

/**
 * 我的相亲画像：基本情况（点选问答，必做）+ AI 深聊（可选）。右边的圈是完成度。
 * 「查看画像」打开相亲画像网页；深聊按钮进原生的深聊页；基本情况没填完时只有「继续填写」。
 */
@Composable
fun MePortraitCard(u: UserProfile, modifier: Modifier = Modifier, onNav: (String) -> Unit) {
    val deep = u.deepStatus
    // 完成度：只做完点选问答 62%，深聊也确认了 100%
    val percent = when (deep) { "done" -> 100; "draft" -> 90; "chatting" -> 75; else -> 62 }
    val shape = RoundedCornerShape(18.dp)
    Column(
        modifier.fillMaxWidth().shadow(12.dp, shape, ambientColor = HnRose, spotColor = HnRose).clip(shape)
            .background(Brush.linearGradient(listOf(HnRose, HnCoral, Color(0xFFFFA77A)))).padding(18.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("我的相亲画像", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold)
                Text(
                    when {
                        !u.profileDone -> "基本情况还没填完\n填完才能主动找人聊天"
                        deep == "done" -> "基本情况和 AI 深聊都完成了\n想法变了可以再聊聊"
                        deep == "draft" -> "AI 红娘整理好了画像\n等你看一眼、点确认"
                        deep == "chatting" -> "基本情况已完成\n和 AI 红娘聊到一半"
                        else -> "基本情况已完成\n再和 AI 红娘聊聊，推荐更准"
                    },
                    color = Color.White.copy(alpha = 0.92f), fontSize = 12.5.sp, lineHeight = 20.sp, modifier = Modifier.padding(top = 6.dp),
                )
            }
            if (u.profileDone) {
                Box(Modifier.size(54.dp), contentAlignment = Alignment.Center) {
                    Canvas(Modifier.fillMaxSize()) {
                        val stroke = 5.dp.toPx()
                        val inset = stroke / 2
                        val arc = Size(size.width - stroke, size.height - stroke)
                        drawArc(Color.White.copy(alpha = 0.28f), 0f, 360f, false, Offset(inset, inset), arc, style = Stroke(stroke))
                        drawArc(Color.White, -90f, 360f * percent / 100, false, Offset(inset, inset), arc, style = Stroke(stroke, cap = StrokeCap.Round))
                    }
                    Text("$percent%", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold)
                }
            }
        }
        Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (u.profileDone) {
                CardPill("查看画像  ›", solid = true) { onNav(hnH5("/card/me")) }
                CardPill("✦ " + (DEEP_LABEL[deep] ?: DEEP_LABEL["none"]!!), solid = false) { onNav("deep") }
            } else {
                CardPill("继续填写  ›", solid = true) { onNav("interview") }
            }
        }
    }
}

@Composable
private fun CardPill(text: String, solid: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(17.dp)
    Box(
        Modifier.height(34.dp).clip(shape)
            .then(if (solid) Modifier.background(Color.White) else Modifier.background(Color.White.copy(alpha = 0.22f)).border(1.dp, Color.White.copy(alpha = 0.45f), shape))
            .noRippleClick(onClick).padding(horizontal = 15.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, color = if (solid) HnRose else Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
}

// ---------- 内嵌网页：相亲画像、AI 费用 ----------

/**
 * 用 App 的登录身份打开 AI 红娘的某个网页（route 是 # 后面的路径）。网页自己带顶栏和返回键，这里不再画标题栏。
 * 网页通过 JS 桥（window.PeiwanNative.hn）把这些动作交给原生：关掉这一页、回问答页改某一题、打开基本资料页、打开深聊页、看对方动态。
 * 离开别的页面再回来时，这个网页会重新加载，所以改完资料回来看到的是新内容。
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun HnWebScreen(
    route: String, onBack: () -> Unit, onNav: (String) -> Unit, onOpenChat: (convId: String, targetId: String, title: String) -> Unit,
    /** 网页里换了登录身份（刷脸找回成功、并号进了原来的账号）：原生重新进入一次 */
    onSession: () -> Unit = {},
) {
    var webView by remember { mutableStateOf<WebView?>(null) }
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val url = remember(route) {
        val sep = if (route.contains("?")) "&" else "?"
        withIndexCacheBuster("${Api.BASE_URL}/#$route${sep}token=${Api.token ?: ""}&embed=1&lang=${com.wh.hongniang.i18n.I18n.lang}")
    }
    // 刷脸（实人认证 / 找回）要用摄像头：网页申请时，先看 App 有没有相机权限，没有就向用户要，再把结果告诉网页
    var camRequest by remember { mutableStateOf<android.webkit.PermissionRequest?>(null) }
    val camLauncher = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { granted ->
        camRequest?.let { req ->
            runCatching { if (granted) req.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else req.deny() }
        }
        camRequest = null
    }
    val bridge = remember { HnJsBridge(onBack, onNav, onOpenChat, onSession) }
    // 系统返回键：网页里有上一页先后退，没有就关掉
    BackHandler { if (webView?.canGoBack() == true) webView?.goBack() else onBack() }
    DisposableEffect(Unit) {
        onDispose {
            // 这一页已经关了：网页那边排着队的延时动作（认证通过后自动关页）不要再执行
            bridge.alive = false
            webView?.apply {
                stopLoading()
                (parent as? android.view.ViewGroup)?.removeView(this)
                destroy()
            }
            webView = null
            // 在网页里可能改了资料、花了余额：让「我的」页重新取一次
            HnEvents.version++
        }
    }
    AndroidView(
        modifier = Modifier.fillMaxSize().clipToBounds().navigationBarsPadding().imePadding(),
        factory = { ctx ->
            WebView(ctx).apply {
                clipToOutline = true
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                // 刷脸页打开摄像头后要自动播放预览画面
                settings.mediaPlaybackRequiresUserGesture = false
                setBackgroundColor(Color(0xFFFFF8F4).toArgb())
                webViewClient = GameLog.webViewClient("hn") { }
                webChromeClient = object : android.webkit.WebChromeClient() {
                    override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
                        GameLog.d("hn: [H5 ${m.messageLevel()}] ${m.message()} (${m.sourceId().substringAfterLast('/')}:${m.lineNumber()})")
                        return true
                    }

                    // 网页要用摄像头（阿里云的刷脸页）。只给 https 页面、只给摄像头；麦克风等别的一律不给
                    override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                        val wantsCam = request.resources.contains(android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                        val https = request.origin?.scheme == "https"
                        GameLog.d("hn: permission request cam=$wantsCam origin=${request.origin?.host}")
                        if (!wantsCam || !https) { request.deny(); return }
                        val has = androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED
                        if (has) {
                            request.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                        } else {
                            camRequest = request
                            camLauncher.launch(android.Manifest.permission.CAMERA)
                        }
                    }

                    override fun onPermissionRequestCanceled(request: android.webkit.PermissionRequest) {
                        if (camRequest == request) camRequest = null
                    }
                }
                addJavascriptInterface(bridge, "PeiwanNative")
                GameLog.d("hn: open ${url.substringBefore("token=")}token=***")
                loadUrl(url)
                webView = this
            }
        },
    )
}

// ---------- 登录设备：新设备登录的提醒 ----------

/** 有新设备通过刷脸登录了这个账号（在线时服务器推送，不在线的下次启动时由「进入」带回来）→ AppRoot 最上层弹提醒 */
object DeviceCenter {
    var alert by mutableStateOf<com.wh.hongniang.net.NewDevice?>(null)
}

/** 「你的账号在新设备登录了」。onRemove：点了「不是我，去移除」→ 打开登录设备页（网页） */
@Composable
fun NewDeviceDialog(onRemove: () -> Unit) {
    val d = DeviceCenter.alert ?: return
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { DeviceCenter.alert = null },
        containerColor = Color.White,
        title = { Text("你的账号在新设备登录了", color = HnInk, fontSize = 18.sp, fontWeight = FontWeight.Bold) },
        text = {
            Text(
                "一台${d.name}通过刷脸登录了你的账号。\n\n是你本人换了手机：不用管，两台都能用。\n不是你：马上移除那台设备。",
                color = HnInk2, fontSize = 14.sp, lineHeight = 22.sp,
            )
        },
        confirmButton = { Text("是我本人", color = HnRose, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick { DeviceCenter.alert = null }.padding(8.dp)) },
        dismissButton = { Text("不是我，去移除", color = HnInk2, modifier = Modifier.noRippleClick { DeviceCenter.alert = null; onRemove() }.padding(8.dp)) },
    )
}

/** AI 红娘网页 → 原生 的 JS 桥（网页端见 web/src/bridge.ts 的 hnNative / openNativeChat） */
private class HnJsBridge(
    private val onBack: () -> Unit,
    private val onNav: (String) -> Unit,
    private val onOpenChat: (String, String, String) -> Unit,
    private val onSession: () -> Unit,
) {
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    /** 这一页还开着（关掉以后设成 false） */
    @Volatile
    var alive = true

    @android.webkit.JavascriptInterface
    fun hn(json: String) {
        val o = runCatching { Api.json.parseToJsonElement(json) as JsonObject }.getOrNull() ?: return
        fun arg(k: String) = (o[k] as? JsonPrimitive)?.content.orEmpty()
        val action = arg("action")
        // 只认字母数字，防止网页拼出奇怪的原生路由
        val edit = arg("edit").filter { it.isLetterOrDigit() }
        val id = arg("id").filter { it.isDigit() }
        val convId = arg("conversationId").filter { it.isDigit() }
        GameLog.d("bridge.hn action=$action edit=$edit id=$id")
        main.post {
            when (action) {
                "close" -> onBack()
                "interview" -> onNav(if (edit.isEmpty()) "interview" else "interview?edit=$edit")
                "editProfile" -> onNav("edit-profile")
                "deep" -> onNav("deep")
                "userHome" -> if (id.isNotEmpty()) onNav("u-home/$id")
                // 在画像网页 / 喜欢列表里点喜欢，当场互相喜欢了：弹原生的庆祝页
                "matched" -> if (id.isNotEmpty() && convId.isNotEmpty()) MatchCenter.show(MatchPeer(id = id, nickname = arg("nickname").take(30), avatar = arg("avatar")), convId)
                // 真人认证通过了：让「我的」页、问答页重新取状态，稍等一下（让用户看到「认证通过」）再关掉网页
                "kycDone" -> {
                    HnEvents.version++
                    main.postDelayed({ if (alive) onBack() }, 1200)
                }
                // 登录身份换了（刷脸找回成功、并号进了原来的账号）：换成网页给的令牌，原生重新进入一次
                "session" -> {
                    val token = arg("token").filter { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }
                    if (token.isNotEmpty()) {
                        Api.token = token
                        Api.did = arg("did").filter { it.isDigit() }.ifEmpty { null }
                        onSession()
                    }
                }
            }
        }
    }

    /** 画像网页上的「发消息」：打开原生聊天页 */
    @android.webkit.JavascriptInterface
    fun openChat(convId: String, convType: String, targetId: String, title: String) {
        if ((convType.toIntOrNull() ?: 1) != 1) return
        main.post { onOpenChat(convId, targetId, title) }
    }
}
