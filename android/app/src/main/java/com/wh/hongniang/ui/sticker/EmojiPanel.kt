package com.wh.hongniang.ui.sticker

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.hongniang.i18n.t
import com.wh.hongniang.ui.noRippleClick
import com.wh.hongniang.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** 搜索行右侧的快捷 emoji（Telegram 同款）：点了带着它去搜 */
private val QUICK_EMOJIS = listOf("❤️", "👍", "👎", "🎉", "👋", "😀", "😢", "😠")
private const val BOTTOM_PAD = 64

/**
 * 表情面板（Telegram 式，三端同一套）：内容往下滚时底部按钮和顶部条一起收起。
 * 点了插进输入框（onEmoji），左 🌐 切回键盘（onKeyboard），右 ⌫ 删一个字（onDelete）
 */
@Composable
fun EmojiPanel(
    onEmoji: (String) -> Unit,
    onDelete: (() -> Unit)? = null,
    onKeyboard: (() -> Unit)? = null,
) {
    val ctx = LocalContext.current
    val cfg = LocalConfiguration.current
    // 跟键盘差不多高
    val height = (cfg.screenWidthDp * 0.92f).dp.coerceIn(320.dp, 420.dp)
    val density = LocalDensity.current.density
    val chrome = remember { PanelChrome(density) }
    // 表情搜索 sheet：非 null = 从搜索行进来（"" 只聚焦搜索框，emoji 直接带着搜）
    var searchQuery by remember { mutableStateOf<String?>(null) }
    val pickEmoji: (String) -> Unit = { onEmoji(it); EmojiStore.addRecent(ctx, it) }

    // 面板本身挂个空 pointerInput：空白处的点击到此为止，不穿到下层页面
    Box(Modifier.fillMaxWidth().height(height).background(Bg2).pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } }) {
        EmojiPane(chrome, onEmoji = pickEmoji, onSearch = { searchQuery = it })

        // 底部悬浮：左 🌐 / 右 ⌫
        AnimatedVisibility(
            visible = !chrome.hidden,
            modifier = Modifier.align(Alignment.BottomCenter),
            enter = fadeIn() + slideInVertically { it },
            exit = fadeOut() + slideOutVertically { it },
        ) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)) {
                if (onKeyboard != null) SideBtn(Modifier.align(Alignment.CenterStart), onKeyboard) { GlobeIcon(TextMain, 22.dp) }
                if (onDelete != null) SideBtn(Modifier.align(Alignment.CenterEnd), onDelete) { BackspaceIcon(TextMain, 22.dp) }
            }
        }
    }

    searchQuery?.let { q -> EmojiSearchSheet(initialQuery = q, onEmoji = pickEmoji) { searchQuery = null } }
}

@Composable
private fun SideBtn(modifier: Modifier, onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(modifier.size(40.dp).shadow(6.dp, CircleShape).clip(CircleShape).background(Bg).noRippleClick(onClick), contentAlignment = Alignment.Center) { content() }
}

/** 内容区滚动方向 → 顶部条 / 底部按钮收起或展开（往下滚收起，往上滚或回到顶部展开） */
/**
 * 内容区滚动方向 → 顶部条 / 底部按钮收起或展开（Telegram 手感）。
 * 用「锚点」而不是逐帧方向：pos 是累计滚过的距离（往下为正），展开状态下锚点跟着最低点走、比锚点再往下 24dp 就收；
 * 收起状态下锚点跟着最高点走、比锚点往上 40dp 才展开（收比展容易，手指抖一下不会闪）。
 * 切换后 300ms 内忽略（顶部条高度变了网格会重排、滚动量抖一下）；回到顶部由 ShowAtTop 兜底展开。
 */
class PanelChrome(density: Float) {
    var hidden by mutableStateOf(false)
        private set
    private val hideAfter = 24f * density
    private val showAfter = 40f * density
    private var pos = 0f
    private var anchor = 0f
    private var lastToggle = 0L

    fun show() { set(false) }

    private fun set(h: Boolean) {
        if (hidden == h) return
        hidden = h
        anchor = pos
        lastToggle = android.os.SystemClock.uptimeMillis()
    }

    val connection = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            val d = -available.y // 往下滚（内容上移）为正
            if (d == 0f) return Offset.Zero
            pos += d
            if (android.os.SystemClock.uptimeMillis() - lastToggle < 300) { anchor = pos; return Offset.Zero }
            if (!hidden) {
                if (pos < anchor) anchor = pos
                if (pos - anchor > hideAfter) set(true)
            } else {
                if (pos > anchor) anchor = pos
                if (anchor - pos > showAfter) set(false)
            }
            return Offset.Zero
        }
    }
}

/** 网格滚回顶部时把顶部条放出来 */
@Composable
private fun ShowAtTop(chrome: PanelChrome, grid: LazyGridState) {
    val atTop by remember { derivedStateOf { grid.firstVisibleItemIndex == 0 && grid.firstVisibleItemScrollOffset < 24 } }
    LaunchedEffect(atTop) { if (atTop) chrome.show() }
}

/** 顶部横向条被用户拖动时展开成两行（图 5），松手 1.5 秒后收回 */
@Composable
private fun rememberBarExpanded(row: LazyListState): Boolean {
    val dragged by row.interactionSource.collectIsDraggedAsState()
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(dragged) {
        if (dragged) expanded = true else { delay(1500); expanded = false }
    }
    return expanded
}

/** 顶部条上的一个格子（图标），expanded 时下面带名字 */
@Composable
private fun BarCell(active: Boolean, expanded: Boolean, title: String, onClick: () -> Unit, content: @Composable () -> Unit) {
    Column(
        Modifier.width(if (expanded) 56.dp else 40.dp).height(if (expanded) 64.dp else 40.dp).clip(RoundedCornerShape(10.dp)).background(if (active) Bg3 else Color.Transparent).noRippleClick(onClick),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) { content() }
        if (expanded) Text(title, color = TextSub, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp, start = 2.dp, end = 2.dp))
    }
}

/** 快捷 emoji 虚化：灰度 + 半透明，被选中的那个恢复彩色 */
private val GRAYSCALE = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) })

/**
 * 搜索行（Telegram 图）：一整条圆角胶囊，左边 🔍「搜索」，右边一排**虚化**的快捷 emoji。
 * - 传 onTap：整条胶囊是个按钮（弹搜索 sheet 并聚焦搜索框），点快捷 emoji 直接带着它去搜；
 * - 不传：点胶囊变成输入框就地搜，快捷 emoji 点亮一个当过滤词。
 */
@Composable
private fun SearchRow(value: String, onChange: (String) -> Unit, chip: String, onChip: (String) -> Unit, placeholder: String, onTap: (() -> Unit)? = null) {
    var focused by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val editing = onTap == null && (focused || value.isNotEmpty())
    Row(
        Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 4.dp, bottom = 8.dp).height(32.dp)
            .clip(RoundedCornerShape(16.dp)).background(Bg3)
            .noRippleClick { if (onTap != null) onTap() else { focused = true; focus.requestFocus() } }
            .padding(start = 12.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SearchIcon(TextDim, 15.dp)
        Spacer(Modifier.width(6.dp))
        if (onTap != null) {
            Text(placeholder, color = TextDim, fontSize = 14.sp)
        } else {
            Box(Modifier.then(if (editing) Modifier.weight(1f) else Modifier.width(44.dp))) {
                if (value.isEmpty()) Text(placeholder, color = TextDim, fontSize = 14.sp, maxLines = 1)
                BasicTextField(
                    value, onChange, singleLine = true, textStyle = TextStyle(color = TextMain, fontSize = 14.sp), cursorBrush = SolidColor(Accent),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).onFocusChanged { focused = it.isFocused },
                )
            }
        }
        if (editing) {
            Text("✕", color = TextDim, fontSize = 13.sp, modifier = Modifier.noRippleClick { onChange(""); onChip(""); focused = false }.padding(horizontal = 6.dp))
        } else {
            Spacer(Modifier.weight(1f))
            LazyRow(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                items(QUICK_EMOJIS) { e ->
                    val on = chip == e
                    Box(
                        Modifier.size(30.dp).clip(CircleShape).background(if (on) Bg else Color.Transparent)
                            .noRippleClick { onChip(if (on) "" else e) }
                            .alpha(if (on) 1f else 0.45f),
                        contentAlignment = Alignment.Center,
                    ) {
                        // Text 不能直接套 ColorFilter，用 Canvas 画一层饱和度 0 的 emoji
                        if (on) Text(e, fontSize = 19.sp) else GrayEmoji(e)
                    }
                }
            }
        }
    }
}

/** 灰度 emoji：把 emoji 画到位图再用饱和度 0 的 ColorFilter 显示 */
@Composable
private fun GrayEmoji(e: String) {
    val density = LocalDensity.current
    val bmp = remember(e, density) {
        val px = with(density) { 22.sp.toPx() }
        val size = (px * 1.3f).toInt().coerceAtLeast(1)
        val bitmap = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bitmap)
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { textSize = px; textAlign = android.graphics.Paint.Align.CENTER }
        val y = size / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(e, size / 2f, y, paint)
        bitmap.asImageBitmap()
    }
    Image(bmp, contentDescription = e, colorFilter = GRAYSCALE, modifier = Modifier.size(24.dp))
}

@Composable
private fun SectionHeader(title: String, right: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 10.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title.uppercase(), color = TextSub, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        right?.invoke()
    }
}

@Composable
private fun EmptyText(text: String) {
    Text(text, color = TextDim, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp))
}

private fun baseEmoji(e: String) = e.replace("\uFE0F", "")

// ---------- 表情页 ----------

/**
 * 表情页：顶部 🕒 + 8 个分类图标，搜索行，内容 8 列按分类分区。
 * 搜索行整条是按钮：弹搜索 sheet（onSearch("") 聚焦输入框；点快捷 emoji 带着它去搜）。
 */
@Composable
private fun EmojiPane(chrome: PanelChrome, onEmoji: (String) -> Unit, onSearch: (String) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { EmojiStore.ensureLoaded(ctx) }
    val groups = EmojiStore.groups
    val recent = EmojiStore.recent
    val grid = rememberLazyGridState()
    val row = rememberLazyListState()
    val expanded = rememberBarExpanded(row)
    ShowAtTop(chrome, grid)

    // 分区：最近 + 各分类；每区 1 个标题 + N 个
    val recentTitle = t("emoji.recent")
    val groupNames = groups.map { groupName(it) }
    val sections = remember(groups, recent, recentTitle, groupNames) {
        buildList {
            if (recent.isNotEmpty()) add(Triple("recent", recentTitle, recent))
            groups.forEachIndexed { i, g -> add(Triple(g.key, groupNames[i], g.items.map { it[0] })) }
        }
    }
    val starts = remember(sections) { sections.runningFold(0) { acc, s -> acc + 1 + s.third.size } }
    val activeKey by remember(sections) {
        derivedStateOf {
            val idx = grid.firstVisibleItemIndex + 1
            var cur = sections.firstOrNull()?.first ?: "recent"
            sections.forEachIndexed { i, s -> if (starts[i] <= idx) cur = s.first }
            cur
        }
    }
    LaunchedEffect(activeKey) {
        val i = if (activeKey == "recent") 0 else groups.indexOfFirst { it.key == activeKey }.let { if (it < 0) -1 else it + 1 }
        if (i >= 0) row.animateScrollToItem((i - 2).coerceAtLeast(0))
    }
    fun jump(key: String) {
        val i = sections.indexOfFirst { it.first == key }
        scope.launch { grid.animateScrollToItem(if (i < 0) 0 else starts[i]) }
    }

    Column(Modifier.fillMaxSize()) {
        AnimatedVisibility(visible = !chrome.hidden, enter = expandVertically(), exit = shrinkVertically()) {
            Column {
                LazyRow(state = row, modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                    item("recent") { BarCell(activeKey == "recent", expanded, recentTitle, onClick = { jump("recent") }) { ClockIcon(TextSub, 20.dp) } }
                    items(groups, key = { it.key }) { g ->
                        BarCell(activeKey == g.key, expanded, groupName(g), onClick = { jump(g.key) }) { Text(g.icon, fontSize = 20.sp, modifier = Modifier.alpha(if (activeKey == g.key) 1f else 0.6f)) }
                    }
                }
                SearchRow("", {}, "", { onSearch(it) }, t("emoji.searchEmoji"), onTap = { onSearch("") })
            }
        }
        LazyVerticalGrid(
            columns = GridCells.Fixed(8), state = grid,
            modifier = Modifier.fillMaxSize().nestedScroll(chrome.connection),
            contentPadding = PaddingValues(6.dp, 0.dp, 6.dp, BOTTOM_PAD.dp),
        ) {
            sections.forEach { (key, title, items) ->
                item(key = "h$key", span = { GridItemSpan(maxLineSpan) }) { SectionHeader(title) }
                items(items.size, key = { "$key-$it" }) { i -> EmojiCell(items[i], onEmoji) }
            }
            if (groups.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) { EmptyText(t("common.loading")) }
        }
    }
}

/** 分类名按 key 本地化；没有对应文案的新分类用后端给的名字 */
private fun groupName(g: EmojiGroup): String {
    val k = "emoji.group.${g.key}"
    return t(k).takeIf { it != k } ?: g.name
}

@Composable
private fun EmojiCell(e: String, onEmoji: (String) -> Unit) {
    Box(Modifier.aspectRatio(1f).clip(RoundedCornerShape(8.dp)).noRippleClick { onEmoji(e) }, contentAlignment = Alignment.Center) {
        Text(e, fontSize = 26.sp)
    }
}

// ---------- 表情搜索 sheet ----------

/** 搜索 sheet 外壳：顶部搜索框（自动聚焦）+「完成」，一行快捷 emoji（点了当搜索词），下面放结果 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchSheetShell(placeholder: String, query: String, onQuery: (String) -> Unit, onClose: () -> Unit, autoFocus: Boolean = true, content: @Composable () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (autoFocus) { delay(120); runCatching { focus.requestFocus() } } }
    ModalBottomSheet(onDismissRequest = onClose, sheetState = state, containerColor = Bg, dragHandle = null, shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.9f)) {
            Row(Modifier.fillMaxWidth().padding(12.dp, 12.dp, 12.dp, 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).height(36.dp).clip(RoundedCornerShape(10.dp)).background(Bg3).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    SearchIcon(TextDim, 15.dp)
                    Spacer(Modifier.width(6.dp))
                    Box(Modifier.weight(1f)) {
                        if (query.isEmpty()) Text(placeholder, color = TextDim, fontSize = 15.sp)
                        BasicTextField(query, onQuery, singleLine = true, textStyle = TextStyle(color = TextMain, fontSize = 15.sp), cursorBrush = SolidColor(Accent), modifier = Modifier.fillMaxWidth().focusRequester(focus))
                    }
                    if (query.isNotEmpty()) Text("✕", color = TextDim, fontSize = 13.sp, modifier = Modifier.noRippleClick { onQuery("") }.padding(start = 6.dp))
                }
                Spacer(Modifier.width(12.dp))
                Text(t("common.done"), color = Accent, fontSize = 16.sp, modifier = Modifier.noRippleClick(onClose))
            }
            LazyRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                items(QUICK_EMOJIS) { e ->
                    val on = baseEmoji(query.trim()) == baseEmoji(e)
                    Box(
                        Modifier.size(36.dp).clip(CircleShape).background(if (on) Bg3 else Color.Transparent).noRippleClick { onQuery(if (on) "" else e) }.alpha(if (on) 1f else 0.5f),
                        contentAlignment = Alignment.Center,
                    ) { if (on) Text(e, fontSize = 22.sp) else GrayEmoji(e) }
                }
            }
            content()
        }
    }
}

/** 表情搜索 sheet：按中英文关键词 / emoji 本身搜；点了插进输入框，sheet 不关（可连续点几个），「完成」收起。打开时不自动弹键盘 */
@Composable
fun EmojiSearchSheet(initialQuery: String, onEmoji: (String) -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { EmojiStore.ensureLoaded(ctx) }
    var q by remember { mutableStateOf(initialQuery) }
    val query = q.trim()
    val recent = EmojiStore.recent
    val results = remember(EmojiStore.groups, query, recent) { if (query.isEmpty()) recent else EmojiStore.search(query) }

    SearchSheetShell(t("emoji.searchEmoji"), q, { q = it }, onClose, autoFocus = false) {
        LazyVerticalGrid(columns = GridCells.Fixed(8), modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(6.dp, 0.dp, 6.dp, 30.dp)) {
            if (query.isEmpty() && recent.isNotEmpty()) item(key = "hr", span = { GridItemSpan(maxLineSpan) }) { SectionHeader(t("emoji.recent")) }
            items(results.size, key = { "q$it" }) { i -> EmojiCell(results[i], onEmoji) }
            if (results.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                EmptyText(if (query.isEmpty()) t("emoji.searchHint") else t("emoji.noMatch"))
            }
        }
    }
}

// ---------- 图标 ----------

/** 笑脸（表情按钮） */
@Composable
fun SmileIcon(tint: Color, size: Dp = 22.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.075f
        drawCircle(tint, radius = w * 0.42f, style = Stroke(stroke))
        drawCircle(tint, radius = w * 0.055f, center = Offset(w * 0.36f, w * 0.4f))
        drawCircle(tint, radius = w * 0.055f, center = Offset(w * 0.64f, w * 0.4f))
        drawArc(tint, startAngle = 20f, sweepAngle = 140f, useCenter = false, topLeft = Offset(w * 0.27f, w * 0.3f), size = Size(w * 0.46f, w * 0.42f), style = Stroke(stroke, cap = StrokeCap.Round))
    }
}

/** 时钟（最近使用 tab） */
@Composable
fun ClockIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.08f
        drawCircle(tint, radius = w * 0.42f, style = Stroke(stroke))
        drawLine(tint, Offset(w * 0.5f, w * 0.26f), Offset(w * 0.5f, w * 0.52f), strokeWidth = stroke, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.5f, w * 0.52f), Offset(w * 0.68f, w * 0.62f), strokeWidth = stroke, cap = StrokeCap.Round)
    }
}

/** 放大镜（搜索行） */
@Composable
fun SearchIcon(tint: Color, size: Dp = 16.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.1f
        drawCircle(tint, radius = w * 0.3f, center = Offset(w * 0.42f, w * 0.42f), style = Stroke(stroke))
        drawLine(tint, Offset(w * 0.64f, w * 0.64f), Offset(w * 0.88f, w * 0.88f), strokeWidth = stroke, cap = StrokeCap.Round)
    }
}

/** 地球（切回键盘） */
@Composable
fun GlobeIcon(tint: Color, size: Dp = 22.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.07f
        drawCircle(tint, radius = w * 0.42f, style = Stroke(stroke))
        drawOval(tint, topLeft = Offset(w * 0.3f, w * 0.08f), size = Size(w * 0.4f, w * 0.84f), style = Stroke(stroke))
        drawLine(tint, Offset(w * 0.08f, w * 0.5f), Offset(w * 0.92f, w * 0.5f), strokeWidth = stroke)
        drawLine(tint, Offset(w * 0.5f, w * 0.08f), Offset(w * 0.5f, w * 0.92f), strokeWidth = stroke)
    }
}

/** 退格（删一个字） */
@Composable
fun BackspaceIcon(tint: Color, size: Dp = 22.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.07f
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.34f, w * 0.22f); lineTo(w * 0.88f, w * 0.22f); lineTo(w * 0.88f, w * 0.78f); lineTo(w * 0.34f, w * 0.78f); lineTo(w * 0.1f, w * 0.5f); close()
        }
        drawPath(path, tint, style = Stroke(stroke, join = androidx.compose.ui.graphics.StrokeJoin.Round))
        drawLine(tint, Offset(w * 0.5f, w * 0.38f), Offset(w * 0.72f, w * 0.62f), strokeWidth = stroke, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.72f, w * 0.38f), Offset(w * 0.5f, w * 0.62f), strokeWidth = stroke, cap = StrokeCap.Round)
    }
}
