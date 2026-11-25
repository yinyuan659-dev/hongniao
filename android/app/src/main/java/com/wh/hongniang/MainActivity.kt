package com.wh.hongniang

import android.net.Uri
import android.os.Bundle
import android.graphics.Color as AndroidColor
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.wh.hongniang.i18n.t
import com.wh.hongniang.net.Api
import com.wh.hongniang.net.UserProfile
import com.wh.hongniang.net.WsClient
import com.wh.hongniang.rtc.CallManager
import com.wh.hongniang.ui.clearFocusOnTap
import com.wh.hongniang.ui.screen.*
import com.wh.hongniang.ui.theme.PeiwanATheme
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Api.init(applicationContext)
        com.wh.hongniang.i18n.I18n.init(applicationContext)
        // 全局图片缓存：内存 25% + 磁盘 512MB，忽略服务端缓存头（资源为 UUID 文件名不会变）
        coil.Coil.setImageLoader(
            coil.ImageLoader.Builder(applicationContext)
                .memoryCache { coil.memory.MemoryCache.Builder(applicationContext).maxSizePercent(0.25).build() }
                .diskCache {
                    coil.disk.DiskCache.Builder()
                        .directory(applicationContext.cacheDir.resolve("image_cache"))
                        .maxSizeBytes(512L * 1024 * 1024)
                        .build()
                }
                .respectCacheHeaders(false)
                .components {
                    add(coil.decode.VideoFrameDecoder.Factory())
                    // 聊天里的动图（GIF / 动态 WebP）：API 28+ 用系统 ImageDecoder，之前的机型退回 GifDecoder（只播 GIF，动态 WebP 显示首帧）
                    if (android.os.Build.VERSION.SDK_INT >= 28) add(coil.decode.ImageDecoderDecoder.Factory()) else add(coil.decode.GifDecoder.Factory())
                }
                .crossfade(true)
                .build(),
        )
        // 浅色主题：透明状态栏/导航栏 + 深色图标文字
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT),
        )
        setContent { PeiwanATheme { Surface(Modifier.fillMaxSize()) { AppRoot() } } }
        // Android 13+ 通知权限（来电提醒需要）
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 100)
        }
    }

    override fun onResume() {
        super.onResume()
        com.wh.hongniang.net.Session.foreground = true
    }

    override fun onPause() {
        super.onPause()
        com.wh.hongniang.net.Session.foreground = false
    }
}

/** 子页面路由：统一加不透明背景，覆盖在常驻主页之上（主页不销毁，返回即恢复） */
private fun androidx.navigation.NavGraphBuilder.page(
    route: String,
    arguments: List<androidx.navigation.NamedNavArgument> = emptyList(),
    content: @Composable (androidx.navigation.NavBackStackEntry) -> Unit,
) {
    composable(route, arguments) { entry ->
        // 子页面盖在常驻的 MainScreen 上面：background 不参与命中测试，页面空白处（比如表情面板底部胶囊两侧）
        // 的点击会穿到下层主页的底栏上。挂一个什么都不做的 pointerInput 让整页算"命中"，到此为止。
        Box(
            Modifier
                .fillMaxSize()
                .background(com.wh.hongniang.ui.theme.Bg)
                .pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } },
        ) { content(entry) }
    }
}

@Composable
fun AppRoot() {
    val nav = rememberNavController()
    var user by remember { mutableStateOf<UserProfile?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    LaunchedEffect(user?.id) {
        user?.let {
            com.wh.hongniang.net.Session.uid = it.id
            com.wh.hongniang.net.Session.gender = it.gender
            WsClient.connect()
            CallManager.attachContext(context)
            CallManager.init(context, it.id)
            // 保活：前台服务 + 请求忽略电池优化（保证熄屏收消息/来电）
            runCatching { KeepAliveService.start(context) }
            runCatching {
                val pm = context.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
                if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
                    val intent = android.content.Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = android.net.Uri.parse("package:${context.packageName}")
                        addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                }
            }
            // 来电悬浮窗权限（显示在其他应用上层）
            runCatching {
                if (!android.provider.Settings.canDrawOverlays(context)) {
                    android.widget.Toast.makeText(context, t("call.overlayPermission"), android.widget.Toast.LENGTH_LONG).show()
                    val intent = android.content.Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
                        data = android.net.Uri.parse("package:${context.packageName}")
                        addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                }
            }
        }
    }

    // 路由跳转（进动态详情等）时停止广场列表内正在播放的视频
    LaunchedEffect(Unit) {
        nav.currentBackStackEntryFlow.collect {
            com.wh.hongniang.ui.screen.FeedVideoCenter.current?.pause()
        }
    }

    // 评分完成后跳转/留在女方个人主页
    LaunchedEffect(Unit) {
        com.wh.hongniang.rtc.CallManager.openUserHome.collect { uid ->
            if (uid != null) {
                com.wh.hongniang.rtc.CallManager.openUserHome.value = null
                // 已在该主页则不重复入栈
                if (nav.currentBackStackEntry?.destination?.route != "u/{id}" ||
                    nav.currentBackStackEntry?.arguments?.getString("id") != uid
                ) {
                    nav.navigate("u/$uid")
                }
            }
        }
    }

    // GPS 每分钟上报一次（用于距离展示）
    LaunchedEffect(user?.id) {
        if (user == null) return@LaunchedEffect
        while (true) {
            runCatching {
                detectCity(context) // 内部刷新 LocationCache
                val lat = LocationCache.lat
                val lng = LocationCache.lng
                if (lat != null && lng != null) {
                    Api.request("/user/location", "POST", kotlinx.serialization.json.buildJsonObject {
                        put("latitude", kotlinx.serialization.json.JsonPrimitive(lat))
                        put("longitude", kotlinx.serialization.json.JsonPrimitive(lng))
                    })
                }
            }
            kotlinx.coroutines.delay(60_000)
        }
    }

    // 喜欢相关的实时消息：互相喜欢了 → 弹庆祝页；有人喜欢我 / 对方结束了聊天 → 让各页面重新取数字
    LaunchedEffect(user?.id) {
        if (user != null) MatchCenter.checkNew()
    }
    androidx.compose.runtime.DisposableEffect(Unit) {
        val remove = WsClient.addListener { frame ->
            if (frame["op"]?.jsonPrimitive?.content != "match") return@addListener
            if (frame["event"]?.jsonPrimitive?.content == "matched") scope.launch { MatchCenter.checkNew() } else MatchCenter.version++
        }
        onDispose { remove() }
    }

    // 登录身份换了（刷脸找回成功、并号进了原来的账号、本机被别的设备移除）：断开聊天连接，回到启动页重新进入一次。
    // 这台设备现在挂在哪个账号下由服务器说了算：挂着就登录那个账号，不认识了就去注册页。
    fun restart() {
        WsClient.close()
        user = null
        nav.navigate("boot") { popUpTo(nav.graph.id) { inclusive = true } }
    }

    // 登录设备相关的实时消息：有新设备通过刷脸登录了这个账号 → 弹提醒；本机被移除了 → 退出
    androidx.compose.runtime.DisposableEffect(Unit) {
        val remove = WsClient.addListener { frame ->
            if (frame["op"]?.jsonPrimitive?.content != "device") return@addListener
            val data = frame["data"] as? JsonObject ?: return@addListener
            val id = data["id"]?.jsonPrimitive?.content.orEmpty()
            val mine = Api.did.orEmpty()
            when (frame["event"]?.jsonPrimitive?.content) {
                "added" -> if (id != mine) {
                    DeviceCenter.alert = com.wh.hongniang.net.NewDevice(
                        id = id,
                        kind = data["kind"]?.jsonPrimitive?.content.orEmpty(),
                        label = data["label"]?.jsonPrimitive?.content.orEmpty(),
                        at = data["at"]?.jsonPrimitive?.content.orEmpty(),
                    )
                }
                "removed" -> if (mine.isNotEmpty() && id == mine) {
                    Api.token = null
                    Api.did = null
                    android.widget.Toast.makeText(context, "这台设备已被移除，已退出登录", android.widget.Toast.LENGTH_LONG).show()
                    restart()
                }
            }
        }
        onDispose { remove() }
    }

    // 通过用户 id 打开会话（不能和自己私聊）。搜索、动态、老主页都从这里走：
    // 互相喜欢了才能聊（规则上线前就聊过的有保留期）；不能聊的提示一句，带去对方的画像（在那里点喜欢）
    fun openChatWithUser(userId: String, nickname: String) {
        if (userId == user?.id || userId.isEmpty()) return
        scope.launch {
            runCatching {
                val rel = Api.getObj<MatchRelation>("/match/relation/$userId")
                if (!rel.canChat) {
                    val tip = when (rel.chatReason) {
                        "ended_peer" -> "对方已结束聊天"
                        "ended_me" -> "你已选择不再联系"
                        "legacy_expired" -> "互相喜欢后才能继续聊"
                        else -> "互相喜欢后才能聊天"
                    }
                    android.widget.Toast.makeText(context, tip, android.widget.Toast.LENGTH_SHORT).show()
                    val here = nav.currentBackStackEntry
                    val onCard = here?.destination?.route == "u/{id}" && here.arguments?.getString("id") == userId
                    if (rel.endedBy == null && !onCard) nav.navigate("u/$userId")
                    return@runCatching
                }
                val data = Api.request("/im/conversations/open/$userId", "POST") as? JsonObject
                val convId = data?.get("conversationId")?.jsonPrimitive?.content ?: return@runCatching
                nav.navigate("chatroom/$convId?targetId=$userId&title=${Uri.encode(nickname)}")
            }
        }
    }

    // clearFocusOnTap：全 App 点击空白处收起键盘（Dialog/BottomSheet 是独立窗口，需各自再挂一次）
    Box(Modifier.fillMaxSize().clearFocusOnTap()) {
      Box(Modifier.fillMaxSize().statusBarsPadding()) {
        // 主页常驻底层（像老 Activity：被子页面覆盖时不销毁、返回时不重建）
        if (user != null) {
            MainScreen(
                initialUser = user,
                onOpenChat = { convId, targetId, title ->
                    nav.navigate("chatroom/$convId?targetId=$targetId&title=${Uri.encode(title)}")
                },
                onOpenChatWithUser = ::openChatWithUser,
                onNav = { nav.navigate(it) },
            )
        }
        NavHost(navController = nav, startDestination = "boot") {
            page("boot") {
                BootScreen(
                    onRegistered = { user = it; nav.navigate("main") { popUpTo("boot") { inclusive = true } } },
                    onNeedRegister = { nav.navigate("register") { popUpTo("boot") { inclusive = true } } },
                )
            }
            page("register") {
                // 注册完直接去 AI 红娘那里做资料收集（返回就是主页）
                RegisterScreen(
                    onDone = { user = it; nav.navigate("main") { popUpTo("register") { inclusive = true } }; nav.navigate("interview") },
                    // 换了手机：刷脸找回原来的账号（网页）。?dev= 把本机的设备号带给网页，找回成功后挂到账号上的是这台手机
                    onRecover = { nav.navigate(hnH5("/recover?dev=${Api.deviceId}")) },
                )
            }
            composable("main") {
                // 空占位：主页由底层常驻渲染
                Box(Modifier.size(0.dp))
            }
            page(
                "chatroom/{convId}?targetId={targetId}&title={title}&focusMsgId={focusMsgId}&draft={draft}",
                arguments = listOf(
                    navArgument("convId") { type = NavType.StringType },
                    navArgument("targetId") { type = NavType.StringType; defaultValue = "" },
                    navArgument("title") { type = NavType.StringType; defaultValue = "" },
                    navArgument("focusMsgId") { type = NavType.StringType; defaultValue = "" },
                    // 先填进输入框的话（互相喜欢的庆祝页里点的开场白）
                    navArgument("draft") { type = NavType.StringType; defaultValue = "" },
                ),
            ) { entry ->
                val a = entry.arguments!!
                val targetId = a.getString("targetId") ?: ""
                val startCall = rememberStartCall(targetId, a.getString("title") ?: "")
                ChatRoomScreen(
                    convId = a.getString("convId")!!,
                    targetId = targetId,
                    title = a.getString("title") ?: "",
                    focusMsgId = a.getString("focusMsgId").orEmpty(),
                    myUserId = user?.id ?: "",
                    myAvatar = user?.avatar ?: "",
                    myNickname = user?.nickname ?: "",
                    onBack = { nav.popBackStack() },
                    onCall = { type -> startCall(type) },
                    onNav = { nav.navigate(it) },
                    draft = a.getString("draft").orEmpty(),
                )
            }
            // AI 红娘资料收集（「编辑资料」和没完成资料时的提示框都进这里）
            // edit：从相亲画像网页点某一项过来改那一题（不带就是正常进入）
            page("interview?edit={edit}", listOf(navArgument("edit") { type = NavType.StringType; defaultValue = "" })) { entry ->
                InterviewScreen(
                    myAvatar = user?.avatar ?: "", myCity = user?.cityName ?: "",
                    onBack = { nav.popBackStack() }, onNav = { nav.navigate(it) },
                    editKey = entry.arguments?.getString("edit").orEmpty(),
                )
            }
            // AI 深聊（原生）：真的大模型在问，按用量花模型费
            page("deep") {
                DeepChatScreen(myAvatar = user?.avatar ?: "", onBack = { nav.popBackStack() }, onNav = { nav.navigate(it) })
            }
            // AI 红娘的网页：相亲画像（/card/me、/u/用户id）、AI 费用（/ai-fee…）。route 是网页里 # 后面的路径
            page("h5?route={route}", listOf(navArgument("route") { type = NavType.StringType; defaultValue = "/card/me" })) { entry ->
                HnWebScreen(
                    route = entry.arguments?.getString("route") ?: "/card/me",
                    onBack = { nav.popBackStack() },
                    onNav = { nav.navigate(it) },
                    onOpenChat = { convId, targetId, title -> nav.navigate("chatroom/$convId?targetId=$targetId&title=${Uri.encode(title)}") },
                    onSession = ::restart,
                )
            }
            // 全屏网页容器（活动页、小游戏；大厅页经 JS 桥 openWeb 唤起，只开我们自己的网页）；landscape=true 该页横屏
            page(
                "web?url={url}&title={title}&landscape={landscape}",
                listOf(
                    navArgument("url") { type = NavType.StringType; defaultValue = "" },
                    navArgument("title") { type = NavType.StringType; defaultValue = "" },
                    navArgument("landscape") { type = NavType.BoolType; defaultValue = false },
                ),
            ) { entry ->
                val a = entry.arguments!!
                GameWebScreen(
                    url = a.getString("url") ?: "",
                    title = a.getString("title") ?: "",
                    landscape = a.getBoolean("landscape"),
                    onBack = { nav.popBackStack() },
                )
            }
            // 广场动态：发布 / 详情评论 / 我的动态
            page("publish") { PublishScreen(onBack = { nav.popBackStack() }, onDone = { nav.popBackStack() }) }
            page("moment/{id}", listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                MomentDetailScreen(entry.arguments!!.getString("id")!!, onBack = { nav.popBackStack() }, onOpenChat = ::openChatWithUser, onNav = { nav.navigate(it) })
            }
            page("my-moments") { MyMomentsScreen(onBack = { nav.popBackStack() }, onOpen = { nav.navigate("moment/$it") }) }
            page("edit-profile") { EditProfileScreen(onBack = { nav.popBackStack() }) }
            page("realname") { RealnameScreen(onBack = { nav.popBackStack() }) }
            page("follows/{type}", listOf(navArgument("type") { type = NavType.StringType })) { entry ->
                FollowListScreen(
                    type = entry.arguments!!.getString("type")!!,
                    onBack = { nav.popBackStack() },
                    onOpenUser = { nav.navigate("u/$it") },
                )
            }
            // 别人的主页 = 相亲画像网页（用户 2026-11-23 定的）；原来的原生主页（动态、评分）挪到 u-home，从画像网页里「看 TA 的动态」进
            page("u/{id}", listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                HnWebScreen(
                    route = "/u/${entry.arguments!!.getString("id")!!.filter { it.isDigit() }}",
                    onBack = { nav.popBackStack() },
                    onNav = { nav.navigate(it) },
                    onOpenChat = { convId, targetId, title -> nav.navigate("chatroom/$convId?targetId=$targetId&title=${Uri.encode(title)}") },
                )
            }
            page("u-home/{id}", listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                UserHomeScreen(
                    userId = entry.arguments!!.getString("id")!!,
                    onBack = { nav.popBackStack() },
                    onOpenChat = ::openChatWithUser,
                    onOpenMoment = { nav.navigate("moment/$it") },
                    onNav = { nav.navigate(it) },
                )
            }
        }
      }
        // 互相喜欢的庆祝页：盖在所有页面上面（通话界面除外）
        MatchCelebration(myAvatar = user?.avatar ?: "") { convId, targetId, title, draft ->
            nav.navigate("chatroom/$convId?targetId=$targetId&title=${Uri.encode(title)}&draft=${Uri.encode(draft)}")
        }
        // 有新设备通过刷脸登录了这个账号：提醒一次；「不是我」→ 去登录设备页移除
        if (user != null) NewDeviceDialog(onRemove = { nav.navigate(hnH5("/devices")) })
        CallOverlay()
        // 启动检查更新（后台配置；强制时弹框不可关闭）
        com.wh.hongniang.ui.UpdateChecker()
    }
}
