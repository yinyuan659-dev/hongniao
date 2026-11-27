package com.wh.hongniang.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.hongniang.i18n.t
import com.wh.hongniang.net.Api
import com.wh.hongniang.net.MeetUser
import com.wh.hongniang.net.Session
import com.wh.hongniang.ui.*
import com.wh.hongniang.ui.theme.*
import kotlinx.coroutines.launch

/** 遇见页进程级缓存：返回时原样恢复不跳动 */
object MeetCache {
    var items: List<MeetUser> = emptyList()
    /** rec = 每日推荐，排在最前面，点「遇见」先看到它 */
    var tab: String = "rec"
}

/**
 * 主页「遇见」：最前面是每日推荐（RecSection），后面是异性用户卡片流。
 * 子栏：推荐 / 所有 / 新人 / 同城 / 亲密度（亲密度按互动记分倒序）。
 */
@Composable
fun MeetSection(
    city: String,
    onOpenUser: (String) -> Unit,
    startCall: (String, String, String, Int) -> Unit,
    onNav: (String) -> Unit,
) {
    var tab by remember { mutableStateOf(MeetCache.tab) }
    var items by remember { mutableStateOf(MeetCache.items) }
    var loading by remember { mutableStateOf(false) }
    /** 在这几个列表里自己点喜欢的名额（每天几个，后台可调；「推荐」里的不占） */
    var quota by remember { mutableStateOf<MatchQuota?>(null) }
    val liker = rememberLiker(onNav)
    LaunchedEffect(tab) { MeetCache.tab = tab }
    LaunchedEffect(items) { MeetCache.items = items }
    val scope = rememberCoroutineScope()

    suspend fun loadNow() {
        if (tab == "rec") return
        val q = buildString {
            append("?tab=$tab")
            if (tab == "city" && city.isNotEmpty()) append("&city=$city")
        }
        val fresh = runCatching { Api.getList<MeetUser>("/user/meet/list$q") }.getOrNull() ?: return
        items = fresh
    }

    LaunchedEffect(tab, city) {
        loading = items.isEmpty()
        loadNow()
        loading = false
    }
    // 名额、卡片上的 ♥：进来取一次；在别人的画像网页里点了喜欢回来、喜欢相关的事有变化，也重新取
    LaunchedEffect(tab, MatchCenter.version, HnEvents.version) {
        if (tab == "rec") return@LaunchedEffect
        runCatching { Api.getObj<MatchSummary>("/match/summary") }.onSuccess { quota = it.quota }
        loadNow()
    }
    // 在线/占线状态兜底：30 秒静默刷新
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(30_000)
            loadNow()
        }
    }

    Column(Modifier.fillMaxSize()) {
        // 子栏胶囊：推荐 / 所有 / 新人 / 同城 / 亲密度（窄屏放不下可以横着滑）
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(16.dp, 2.dp, 16.dp, 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("rec" to "推荐", "all" to t("meet.tabAll"), "new" to t("meet.tabNew"), "city" to t("meet.tabCity"), "intimacy" to t("meet.tabIntimacy")).forEach { (k, label) ->
                val sel = tab == k
                Text(
                    label,
                    color = if (sel) Color.White else TextSub,
                    fontSize = 13.sp,
                    fontWeight = if (sel) FontWeight.Bold else FontWeight.Normal,
                    modifier = Modifier
                        .clip(RoundedCornerShape(15.dp))
                        .background(if (sel) Accent else Bg2)
                        .noRippleClick { tab = k }
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                )
            }
        }

        if (tab == "rec") {
            RecSection(onOpenUser = onOpenUser, onNav = onNav, onBrowse = { tab = "all" })
            return@Column
        }
        quota?.let { q ->
            if (items.isNotEmpty()) {
                Text(
                    "点 ♥ 喜欢，互相喜欢后可以视频见面 · 今天还能喜欢 ${q.left} 个",
                    color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(start = 18.dp, end = 18.dp, bottom = 8.dp),
                )
            }
        }
        if (items.isEmpty()) {
            Box(Modifier.fillMaxSize()) {
                EmptyHint(
                    when {
                        loading -> t("common.loading")
                        tab == "intimacy" -> t("meet.emptyIntimacy")
                        tab == "city" -> t("meet.emptyCity", "city" to city.ifEmpty { t("meet.tabCity") })
                        else -> t("meet.empty")
                    },
                )
            }
        } else {
            LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                contentPadding = PaddingValues(12.dp, 0.dp, 12.dp, 12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(items, key = { it.id }) { u ->
                    MeetCard(
                        u, showIntimacy = tab == "intimacy", onOpen = { onOpenUser(u.id) }, startCall = startCall,
                        onHeart = {
                            // 已经喜欢过的：进画像看（取消喜欢、发消息都在那里）
                            if (u.like == "liked" || u.like == "mutual") onOpenUser(u.id)
                            else liker.like(u.id) { r ->
                                items = items.map { if (it.id == u.id) it.copy(like = r.state) else it }
                                quota = r.quota
                            }
                        },
                    )
                }
            }
        }
    }
    liker.Dialogs()
}

@Composable
private fun MeetCard(
    u: MeetUser,
    showIntimacy: Boolean,
    onOpen: () -> Unit,
    startCall: (String, String, String, Int) -> Unit,
    onHeart: () -> Unit,
) {
    val ctx = LocalContext.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(3f / 4f)
            .clip(RoundedCornerShape(14.dp))
            .background(Bg2)
            .noRippleClick(onOpen),
    ) {
        if (u.avatar.isNotEmpty()) {
            AsyncImage(
                model = Api.fullUrl(u.avatar), contentDescription = null,
                contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
            )
        }
        // 顶部徽章：已认证 > 新人
        Row(Modifier.align(Alignment.TopStart).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            if (u.realnameVerified) {
                Text(
                    t("meet.verified"), color = Color.White, fontSize = 10.sp,
                    modifier = Modifier.clip(RoundedCornerShape(9.dp)).background(Accent).padding(horizontal = 7.dp, vertical = 2.dp),
                )
            } else if (u.isNew) {
                Text(
                    t("meet.tabNew"), color = Color.White, fontSize = 10.sp,
                    modifier = Modifier.clip(RoundedCornerShape(9.dp)).background(Color(0xFF6C5CE7)).padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
        }
        // 右上：喜欢按钮（实心 = 我已经喜欢了）；对方先喜欢了我的，下面多一个小标签
        val liked = u.like == "liked" || u.like == "mutual"
        Column(Modifier.align(Alignment.TopEnd).padding(8.dp), horizontalAlignment = Alignment.End) {
            Box(
                Modifier.size(34.dp).clip(androidx.compose.foundation.shape.CircleShape)
                    .then(if (liked) Modifier.background(HnGrad) else Modifier.background(Color.White.copy(alpha = 0.9f)))
                    .noRippleClick(onHeart),
                contentAlignment = Alignment.Center,
            ) { Text("♥", color = if (liked) Color.White else HnRose, fontSize = 16.sp) }
            if (u.like == "likedMe") {
                Text(
                    "喜欢了你", color = Color.White, fontSize = 10.sp,
                    modifier = Modifier.padding(top = 4.dp).clip(RoundedCornerShape(9.dp)).background(Accent).padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
        }
        // 在线小点：挪到左上角徽章的右边
        Box(
            Modifier.align(Alignment.TopStart).padding(start = if (u.realnameVerified || u.isNew) 56.dp else 10.dp, top = 12.dp).size(8.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(if (u.online) Success else TextDim),
        )
        // 底部信息浮层（渐变压暗保证可读）
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000))))
                .padding(10.dp, 26.dp, 10.dp, 9.dp),
        ) {
            Text(u.nickname, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1)
            Spacer(Modifier.height(5.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                // 评分五星换算（0-100 → 5.0）
                Text(
                    "★ ${if (u.ratingCount > 0) "%.1f".format(u.ratingAvg / 20.0) else t("meet.ratingNew")}",
                    color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Warn.copy(alpha = 0.85f)).padding(horizontal = 6.dp, vertical = 1.dp),
                )
                if (u.cityName.isNotEmpty()) {
                    Spacer(Modifier.width(6.dp))
                    Text(u.cityName, color = Color.White.copy(alpha = 0.75f), fontSize = 11.sp, maxLines = 1, modifier = Modifier.weight(1f, fill = false))
                }
                Spacer(Modifier.weight(1f))
                if (showIntimacy && u.intimacy > 0) {
                    Text(
                        "♥ ${if (u.intimacy % 1.0 == 0.0) u.intimacy.toInt().toString() else "%.1f".format(u.intimacy)}",
                        color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Accent.copy(alpha = 0.9f)).padding(horizontal = 6.dp, vertical = 1.dp),
                    )
                } else if (u.allowVideo) {
                    // 视频按钮（对方打开了视频见面才有）三态：通话中 / 离线置灰 / 可打
                    val busyColor = Color(0xFFFFAA3C)
                    Text(
                        if (u.busy) t("meet.busy") else t("common.video"),
                        color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.clip(RoundedCornerShape(10.dp))
                            .background(if (u.busy) busyColor.copy(alpha = 0.9f) else if (u.online) Accent else TextDim.copy(alpha = 0.8f))
                            .noRippleClick {
                                when {
                                    u.busy -> android.widget.Toast.makeText(ctx, t("meet.peerBusy"), android.widget.Toast.LENGTH_SHORT).show()
                                    !u.online -> android.widget.Toast.makeText(ctx, t("meet.peerOffline"), android.widget.Toast.LENGTH_SHORT).show()
                                    else -> startCall(u.id, u.nickname, u.avatar, 2)
                                }
                            }
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
            }
        }
    }
}
