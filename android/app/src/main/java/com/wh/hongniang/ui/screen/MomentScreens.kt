package com.wh.hongniang.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.hongniang.i18n.t
import com.wh.hongniang.net.*
import com.wh.hongniang.ui.*
import com.wh.hongniang.ui.sticker.EmojiPanel
import com.wh.hongniang.ui.sticker.SmileIcon
import com.wh.hongniang.ui.sticker.dropLastGrapheme
import com.wh.hongniang.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** 动态详情：正文 + 全部评论 + 底部输入栏（文字 / emoji） */
@Composable
fun MomentDetailScreen(id: String, onBack: () -> Unit, onOpenChat: (String, String) -> Unit, onNav: (String) -> Unit = {}) {
    var m by remember { mutableStateOf<Moment?>(null) }
    var comments by remember { mutableStateOf<List<CommentItem>>(emptyList()) }
    var input by remember { mutableStateOf("") }
    var showEmoji by remember { mutableStateOf(false) }
    val inputFocus = remember { androidx.compose.ui.focus.FocusRequester() }
    val ctx = LocalContext.current
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val scope = rememberCoroutineScope()
    fun loadC() { scope.launch { comments = runCatching { Api.getList<CommentItem>("/moments/$id/comments") }.getOrDefault(emptyList()) } }
    LaunchedEffect(id) {
        m = runCatching { Api.getObj<Moment>("/moments/$id") }.getOrNull()
        loadC()
    }
    val moment = m ?: return
    var fullImage by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxSize()) {
        Row(modifier = Modifier.fillMaxWidth().padding(8.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(modifier = Modifier.size(40.dp).noRippleClick(onBack), contentAlignment = Alignment.Center) { BackIcon(TextMain, 24.dp) }
            Avatar(moment.user?.avatar, 34)
            Text("  ${moment.user?.nickname ?: ""}", color = TextMain, fontSize = 15.sp, modifier = Modifier.weight(1f))
            // 原来这里是「私聊」；现在要互相喜欢才能聊，换成喜欢按钮（互相喜欢后它会变成「发消息」）。自己的动态不显示
            val author = moment.user
            if (author != null && author.id != Session.uid) {
                LikeChip(author.id, author.nickname, Modifier.padding(end = 8.dp), height = 32.dp, onChat = onOpenChat, onNav = onNav)
            }
        }
        LazyColumn(modifier = Modifier.weight(1f).padding(horizontal = 16.dp)) {
            item {
                if (moment.content.isNotEmpty()) Text(moment.content, color = TextMain, fontSize = 15.sp, lineHeight = 24.sp)
                if (moment.type == 2 && moment.videoUrl.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    VideoPlayerBox(Api.fullUrl(moment.videoUrl))
                }
                if (moment.images.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    // 普通布局九宫格（嵌套 LazyVerticalGrid 拖慢滚动）
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        moment.images.chunked(3).forEach { rowImages ->
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
                                rowImages.forEach { url ->
                                    AsyncImage(model = Api.fullUrl(url), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.weight(1f).height(112.dp).clip(RoundedCornerShape(8.dp)).noRippleClick { fullImage = url })
                                }
                                repeat(3 - rowImages.size) { Spacer(Modifier.weight(1f)) }
                            }
                        }
                    }
                }
                Text(t("moments.allComments", "n" to comments.size), color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(vertical = 14.dp))
            }
            items(comments, key = { it.id }) { c ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.Top) {
                    Avatar(c.user?.avatar, 34)
                    Column(modifier = Modifier.padding(start = 10.dp)) {
                        Text((c.user?.nickname ?: "") + (if (c.replyToNickname.isNotEmpty()) " " + t("moments.repliedTo", "name" to c.replyToNickname) else ""), color = TextSub, fontSize = 12.sp)
                        if (c.content.isNotEmpty()) Text(c.content, color = TextMain, fontSize = 14.sp, modifier = Modifier.padding(top = 2.dp))
                        if (c.imageUrl.isNotEmpty()) AsyncImage(model = Api.fullUrl(c.imageUrl), contentDescription = null, modifier = Modifier.padding(top = 4.dp).width(120.dp).clip(RoundedCornerShape(8.dp)))
                    }
                }
            }
        }
        Column(Modifier.fillMaxWidth().background(Bg).imePadding().navigationBarsPadding()) {
            Row(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(36.dp).clip(RoundedCornerShape(18.dp)).background(if (showEmoji) BubbleMine else Bg3).noRippleClick { focus.clearFocus(); keyboard?.hide(); showEmoji = !showEmoji },
                    contentAlignment = Alignment.Center,
                ) { SmileIcon(if (showEmoji) Accent else TextSub, 20.dp) }
                Spacer(Modifier.width(8.dp))
                Box(Modifier.weight(1f).clip(RoundedCornerShape(20.dp)).background(Bg3).padding(horizontal = 14.dp, vertical = 10.dp)) {
                    if (input.isEmpty()) Text(t("moments.saySomething"), color = TextSub, fontSize = 14.sp)
                    BasicTextField(
                        value = input, onValueChange = { if (it.length <= 500) input = it },
                        textStyle = TextStyle(color = TextMain, fontSize = 15.sp),
                        cursorBrush = SolidColor(Accent),
                        maxLines = 4,
                        modifier = Modifier.fillMaxWidth().focusRequester(inputFocus).onFocusChanged { if (it.isFocused) showEmoji = false },
                    )
                }
                Spacer(Modifier.width(8.dp))
                val canSend = input.isNotBlank()
                Box(modifier = Modifier.clip(RoundedCornerShape(15.dp)).background(if (canSend) Accent else Bg3).clickable {
                    if (!canSend) return@clickable
                    scope.launch {
                        runCatching {
                            Api.request("/moments/$id/comments", "POST", buildJsonObject { put("content", JsonPrimitive(input.trim())) })
                        }.onSuccess {
                            input = ""; showEmoji = false; loadC()
                        }.onFailure {
                            android.widget.Toast.makeText(ctx, it.message ?: t("common.fail"), android.widget.Toast.LENGTH_SHORT).show()
                        }
                    }
                }.padding(horizontal = 16.dp, vertical = 10.dp)) { Text(t("common.send"), color = Color.White, fontSize = 13.sp) }
            }
            if (showEmoji) EmojiPanel(onEmoji = { input += it }, onDelete = { input = dropLastGrapheme(input) }, onKeyboard = { showEmoji = false; inputFocus.requestFocus(); keyboard?.show() })
        }
        fullImage?.let { u ->
            androidx.compose.ui.window.Dialog(onDismissRequest = { fullImage = null }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
                ImageViewer(moment.images, moment.images.indexOf(u).coerceAtLeast(0)) { fullImage = null }
            }
        }
    }
}

/** 全局视频播放中心：保证同时只有一个视频出声 */
object FeedVideoCenter {
    var current: androidx.media3.exoplayer.ExoPlayer? = null

    fun register(player: androidx.media3.exoplayer.ExoPlayer) {
        if (current !== player) current?.pause()
        current = player
    }

    fun unregister(player: androidx.media3.exoplayer.ExoPlayer) {
        if (current === player) current = null
    }
}

/** 内嵌视频播放器（ExoPlayer），默认自动播放；接入全局互斥（播 A 停其他） */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun VideoPlayerBox(url: String, autoPlay: Boolean = true, height: androidx.compose.ui.unit.Dp = 240.dp) {
    val ctx = LocalContext.current
    val player = remember {
        androidx.media3.exoplayer.ExoPlayer.Builder(ctx).build().apply {
            setMediaItem(androidx.media3.common.MediaItem.fromUri(url))
            playWhenReady = autoPlay
            prepare()
            // 开始播放时暂停其它视频
            addListener(object : androidx.media3.common.Player.Listener {
                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    if (isPlaying) FeedVideoCenter.register(this@apply)
                }
            })
        }
    }
    DisposableEffect(Unit) {
        onDispose {
            FeedVideoCenter.unregister(player)
            player.release()
        }
    }
    androidx.compose.ui.viewinterop.AndroidView(
        factory = {
            androidx.media3.ui.PlayerView(it).apply {
                this.player = player
                useController = true
                setShowNextButton(false)
                setShowPreviousButton(false)
            }
        },
        modifier = Modifier.fillMaxWidth().height(height).clip(RoundedCornerShape(10.dp)).background(Color.Black),
    )
}
