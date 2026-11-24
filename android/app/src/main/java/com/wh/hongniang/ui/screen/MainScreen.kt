package com.wh.hongniang.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.zIndex
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.hongniang.net.UserProfile
import com.wh.hongniang.ui.AccentBrush
import com.wh.hongniang.ui.theme.*
import com.wh.hongniang.i18n.t
import kotlinx.coroutines.launch

/** 抖音式底部导航：广场 大厅 [+] 消息 我的 */
@Composable
fun MainScreen(
    initialUser: UserProfile?,
    onOpenChat: (convId: String, targetId: String, title: String) -> Unit,
    onOpenChatWithUser: (userId: String, nickname: String) -> Unit,
    onNav: (String) -> Unit,
) {
    // rememberSaveable：从详情页等返回时恢复所在 tab
    var tab by androidx.compose.runtime.saveable.rememberSaveable { mutableIntStateOf(0) }
    var meKey by remember { mutableIntStateOf(0) }
    var unreadTotal by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val startScan = rememberQrScan(onNav)

    // 「消息」上的数字 = 没读的消息 + 新喜欢我的人；消息到达、喜欢相关的事有变化时实时刷新
    fun refreshUnread() {
        scope.launch {
            runCatching {
                val convs = com.wh.hongniang.net.Api.getList<ConversationItem>("/im/conversations")
                val likes = runCatching { com.wh.hongniang.net.Api.getObj<MatchSummary>("/match/summary").likedMeNew }.getOrDefault(0)
                unreadTotal = convs.sumOf { it.unread } + likes
            }
        }
    }
    LaunchedEffect(tab, MatchCenter.version, HnEvents.version) {
        refreshUnread()
        // 切换页面停止广场列表内正在播放的视频
        FeedVideoCenter.current?.pause()
    }
    DisposableEffect(Unit) {
        val remove = com.wh.hongniang.net.WsClient.addListener { frame ->
            val op = (frame["op"] as? kotlinx.serialization.json.JsonPrimitive)?.content
            if (op == "msg") refreshUnread()
        }
        onDispose { remove() }
    }

    Scaffold(
        containerColor = Bg,
        bottomBar = {
            Row(
                modifier = Modifier.fillMaxWidth().background(Bg2).padding(vertical = 8.dp).navigationBarsPadding(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TabText(t("tab.plaza"), tab == 0, Modifier.weight(1f)) { tab = 0 }
                TabText(t("tab.hall"), tab == 1, Modifier.weight(1f)) { tab = 1 }
                Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    // 发布按钮：玫红渐变 + 白色加号（对齐 iOS）
                    Box(modifier = Modifier.size(44.dp, 30.dp).clip(RoundedCornerShape(8.dp)).background(AccentBrush).clickable { onNav("publish") }, contentAlignment = Alignment.Center) {
                        Text("+", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    }
                }
                TabText(t("tab.messages"), tab == 2, Modifier.weight(1f), badge = unreadTotal) { tab = 2 }
                TabText(t("tab.me"), tab == 3, Modifier.weight(1f)) {
                    if (tab != 3) meKey++
                    tab = 3
                }
            }
        },
    ) { pad ->
        // 四个页面常驻保活（对齐 iOS）：切 tab 不销毁重建，状态/数据/滚动位置全保留
        Box(Modifier.padding(pad)) {
            Pane(active = tab == 0) {
                PlazaScreen(onOpenDetail = { onNav("moment/$it") }, onOpenUser = { onNav("u/$it") }, onNav = onNav)
            }
            Pane(active = tab == 1) {
                // 大厅 H5 内输入框弹键盘：只让网页区域上缩（扣掉底栏已占高度，正好贴着键盘），底栏保持原位不被顶起
                val imeBottom = with(androidx.compose.ui.platform.LocalDensity.current) { WindowInsets.ime.getBottom(this).toDp() }
                HallScreen(
                    modifier = Modifier.padding(bottom = (imeBottom - pad.calculateBottomPadding()).coerceAtLeast(0.dp)),
                    active = tab == 1,
                    onOpenChat = onOpenChat,
                    onOpenWeb = { url, title, landscape ->
                        val route = "web?url=${android.net.Uri.encode(url)}&title=${android.net.Uri.encode(title)}&landscape=$landscape"
                        GameLog.d("main: nav -> $route")
                        runCatching { onNav(route) }.onFailure { GameLog.e("main: nav failed", it) }
                    },
                )
            }
            Pane(active = tab == 2) {
                MessagesScreen(
                    onOpenChat = onOpenChat,
                    onOpenMessage = { convId, targetId, title, msgId ->
                        onNav("chatroom/$convId?targetId=$targetId&title=${android.net.Uri.encode(title)}&focusMsgId=$msgId")
                    },
                    onOpenUser = onOpenChatWithUser,
                    onScan = startScan,
                    onNav = onNav,
                )
            }
            Pane(active = tab == 3) {
                // 每次切到「我的」重建刷新（资料保持最新）
                androidx.compose.runtime.key(meKey) {
                    MeScreen(initialUser = initialUser, onNav = onNav)
                }
            }
        }
    }
}

/** 保活页面容器：当前页置顶显示，其余页隐藏在底层（不销毁、不响应点击） */
@Composable
private fun Pane(active: Boolean, content: @Composable () -> Unit) {
    // 非当前 tab 直接跳过绘制而不用 alpha(0)：alpha 会把子树（含大厅 WebView）画进离屏图层，
    // 部分厂商 WebView（华为等）在图层里 / 从图层切回后不出画面，表现为大厅黑屏
    // 事件穿透修复：background 不参与命中测试，当前页空白处的点击会穿到下层 tab（如「我的」）的按钮上。
    // 给当前页挂一个什么都不做的 pointerInput，让整页都算"命中"，命中测试到此为止不再往下层兄弟找；
    // 非当前页则把所有事件吞掉兜底（即便被命中也不响应）。
    Box(
        modifier = Modifier
            .fillMaxSize()
            .zIndex(if (active) 1f else 0f)
            .drawWithContent { if (active) drawContent() }
            .background(Bg)
            .pointerInput(active) {
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent(if (active) PointerEventPass.Main else PointerEventPass.Initial)
                        if (!active) event.changes.forEach { it.consume() }
                    }
                }
            },
    ) { content() }
}

@Composable
private fun TabText(text: String, active: Boolean, modifier: Modifier, badge: Int = 0, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    Box(modifier = modifier.clickable(interactionSource = src, indication = null, onClick = onClick), contentAlignment = Alignment.Center) {
        Text(text, color = if (active) TextMain else TextSub, fontSize = if (active) 17.sp else 16.sp, fontWeight = if (active) FontWeight.Bold else FontWeight.Normal)
        // 未读角标（红色正圆数字）
        com.wh.hongniang.ui.RoundBadge(
            badge,
            Modifier.align(Alignment.TopCenter).padding(start = 52.dp),
        )
    }
}
