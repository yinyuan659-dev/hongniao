package com.wh.hongniang.ui.screen

import android.Manifest
import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.hongniang.i18n.t
import com.wh.hongniang.ui.noRippleClick
import com.wh.hongniang.ui.theme.*
import kotlinx.coroutines.launch

/** 手动选过的城市存在本机：下次打开直接用，不再被自动定位覆盖（和网页端 localStorage 的做法一致） */
object CityStore {
    private const val PREFS = "hn_plaza"
    private const val KEY = "city"

    fun load(ctx: Context): String =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "").orEmpty()

    fun save(ctx: Context, city: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, city).apply()
    }
}

/**
 * 城市选择（对齐网页端 CityPickerSheet）：定位 + 热门 + 字母分组列表 + 右侧 A-Z 索引。
 * 第一格是当前定位：定位到了点它直接选中；没定位到（没给权限 / 没开定位）点它重新申请权限再定位。
 */
@Composable
fun CityPickerSheet(current: String, onClose: () -> Unit, onSelect: (String) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var located by remember { mutableStateOf<String?>(null) }
    var locating by remember { mutableStateOf(true) }
    var activeLetter by remember { mutableStateOf("") }
    val listState = rememberLazyListState()

    val locPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { g ->
        scope.launch {
            locating = true
            located = if (g.values.any { it }) detectCity(ctx) else null
            locating = false
        }
    }
    LaunchedEffect(Unit) {
        located = detectCity(ctx)
        locating = false
    }

    // 每个字母的标题在列表里的下标：第 0 项是「定位 / 热门」，之后每组 = 1 个标题 + N 个城市
    val letterIndex = remember {
        var i = 1
        CITY_LETTERS.associate { (letter, cities) -> letter to i.also { i += 1 + cities.size } }
    }

    androidx.compose.ui.window.Dialog(
        onDismissRequest = onClose,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
        // 点面板外面的空白处关闭
        Box(Modifier.fillMaxSize().noRippleClick(onClose), contentAlignment = Alignment.BottomCenter) {
            Box(
                Modifier.fillMaxWidth().fillMaxHeight(0.78f)
                    .clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp))
                    .background(Bg2)
                    .noRippleClick { },
            ) {
                Column(Modifier.fillMaxSize().navigationBarsPadding()) {
                    Row(Modifier.fillMaxWidth().padding(16.dp, 16.dp, 16.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(t("city.choose"), color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                        Text(t("common.close"), color = TextSub, fontSize = 14.sp, modifier = Modifier.noRippleClick(onClose))
                    }
                    LazyColumn(state = listState, modifier = Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 40.dp, bottom = 24.dp)) {
                        item(key = "hot") {
                            Text(t("city.locateHot"), color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp, bottom = 8.dp))
                            // 定位格 + 热门城市，4 列
                            val cells = listOf<String?>(null) + HOT_CITIES
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                cells.chunked(4).forEach { rowCells ->
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                                        rowCells.forEach { c ->
                                            if (c == null) {
                                                CityChip(
                                                    text = if (locating) t("city.locating") else (located ?: t("city.locateUnavailable")),
                                                    color = Accent, bg = Accent.copy(alpha = 0.12f), modifier = Modifier.weight(1f),
                                                ) {
                                                    val hit = located
                                                    if (hit != null) onSelect(hit)
                                                    else if (!locating) locPerm.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                                                }
                                            } else {
                                                CityChip(c, if (c == current) Accent else TextMain, Bg3, Modifier.weight(1f)) { onSelect(c) }
                                            }
                                        }
                                        repeat(4 - rowCells.size) { Spacer(Modifier.weight(1f)) }
                                    }
                                }
                            }
                        }
                        CITY_LETTERS.forEach { (letter, cities) ->
                            item(key = "h-$letter") {
                                Text(letter, color = TextSub, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp, bottom = 6.dp))
                            }
                            items(cities, key = { "$letter-$it" }) { city ->
                                Column(Modifier.fillMaxWidth().noRippleClick { onSelect(city) }) {
                                    Text(city, color = if (city == current) Accent else TextMain, fontSize = 15.sp, modifier = Modifier.padding(horizontal = 4.dp, vertical = 12.dp))
                                    Box(Modifier.fillMaxWidth().height(0.5.dp).background(Line))
                                }
                            }
                        }
                    }
                }
                // 右侧字母索引：点字母跳到那一组，# 回到顶部
                Column(
                    Modifier.align(Alignment.CenterEnd).padding(end = 4.dp, top = 40.dp).width(26.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(1.dp),
                ) {
                    (listOf("#") + CITY_LETTERS.map { it.first }).forEach { l ->
                        val on = activeLetter == l
                        Text(
                            l,
                            color = if (on) Color.White else TextSub, fontSize = 10.sp, lineHeight = 15.sp, textAlign = TextAlign.Center,
                            modifier = Modifier.width(16.dp).clip(RoundedCornerShape(8.dp)).background(if (on) Accent else Color.Transparent)
                                .noRippleClick {
                                    activeLetter = l
                                    scope.launch { listState.scrollToItem(if (l == "#") 0 else (letterIndex[l] ?: 0)) }
                                },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CityChip(text: String, color: Color, bg: Color, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier.clip(RoundedCornerShape(10.dp)).background(bg).noRippleClick(onClick).padding(vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, color = color, fontSize = 13.sp, maxLines = 1, softWrap = false) }
}
