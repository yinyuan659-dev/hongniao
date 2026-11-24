package com.wh.hongniang.ui.screen

import android.annotation.SuppressLint
import android.content.Context
import android.location.Geocoder
import android.location.LocationManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.hongniang.i18n.t
import com.wh.hongniang.net.*
import com.wh.hongniang.ui.*
import com.wh.hongniang.ui.theme.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.Locale

/** 最近一次定位（上报位置用） */
object LocationCache {
    var lat: Double? = null
    var lng: Double? = null
}

@SuppressLint("MissingPermission")
suspend fun detectCity(ctx: Context): String? = withContext(Dispatchers.IO) {
    runCatching {
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val loc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
            ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER) ?: return@withContext null
        LocationCache.lat = loc.latitude
        LocationCache.lng = loc.longitude
        val addr = Geocoder(ctx, Locale.CHINA).getFromLocation(loc.latitude, loc.longitude, 1)?.firstOrNull()
        (addr?.locality ?: addr?.subAdminArea ?: addr?.adminArea)?.removeSuffix("市")
    }.getOrNull()
}

@Composable
fun EditProfileScreen(onBack: () -> Unit) {
    var u by remember { mutableStateOf<UserProfile?>(null) }
    var nickname by remember { mutableStateOf("") }
    var age by remember { mutableStateOf("18") }
    var city by remember { mutableStateOf("") }
    var signature by remember { mutableStateOf("") }
    var avatar by remember { mutableStateOf("") }
    var photos by remember { mutableStateOf<List<String>>(emptyList()) }
    var uploadingPhoto by remember { mutableStateOf(false) }
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        u = runCatching { Api.getObj<UserProfile>("/user/me") }.getOrNull()
        u?.let {
            nickname = it.nickname; age = it.age.toString(); city = it.cityName; signature = it.signature; avatar = it.avatar
            photos = it.albums.filter { a -> a.type == 1 }.map { a -> a.url }
        }
    }
    val pickAvatar = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch { runCatching { val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }; avatar = Api.upload("image", b, "a.jpg", "image/jpeg") } }
    }
    // 照片墙多选：一次最多选剩余可加张数
    val pickWallPhotos = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        val remain = 8 - photos.size
        if (uris.isNotEmpty() && remain > 0) {
            scope.launch {
                uploadingPhoto = true
                for (uri in uris.take(remain)) {
                    runCatching {
                        val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                        photos = photos + Api.upload("image", b, "w.jpg", "image/jpeg")
                    }
                }
                uploadingPhoto = false
            }
        }
    }
    var locating by remember { mutableStateOf(false) }
    val locPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { g ->
        if (g.values.any { it }) scope.launch {
            locating = true
            detectCity(ctx)?.let { city = it }
            locating = false
        }
    }
    val user = u ?: return
    var saving by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf("") }
    // 年纪滚轮选择
    var showAgePicker by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        NavBar(t("me.editProfile"), onBack) {
            Text(if (saving) t("profile.saving") else t("common.save"), color = Accent, fontSize = 14.sp, modifier = Modifier.noRippleClick {
                if (saving) return@noRippleClick
                if (nickname.isBlank()) { toast = t("profile.nicknameEmpty"); return@noRippleClick }
                saving = true
                scope.launch {
                    val body = buildJsonObject {
                        put("nickname", JsonPrimitive(nickname.trim())); put("age", JsonPrimitive(age.toIntOrNull() ?: 18))
                        put("avatar", JsonPrimitive(avatar)); put("signature", JsonPrimitive(signature.trim()))
                        put("cityName", JsonPrimitive(city)); put("cityCode", JsonPrimitive(city))
                    }
                    runCatching {
                        Api.request("/user/me", "PUT", body)
                        // 照片墙整组保存
                        Api.request("/user/albums", "PUT", buildJsonObject {
                            put("photos", kotlinx.serialization.json.buildJsonArray { photos.forEach { add(JsonPrimitive(it)) } })
                        })
                    }
                        .onSuccess { toast = t("profile.saveSuccess"); onBack() }
                        .onFailure { toast = it.message ?: t("common.saveFailed"); saving = false }
                }
            })
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            if (toast.isNotEmpty()) {
                Text(toast, color = Danger, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 10.dp))
            }
            // ===== 头像 =====
            Column(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.noRippleClick { pickAvatar.launch("image/*") }) {
                    Avatar(avatar, 92)
                    Text(
                        t("profile.change"), color = Color.White, fontSize = 10.sp,
                        modifier = Modifier.align(Alignment.BottomCenter)
                            .clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f))
                            .padding(horizontal = 10.dp, vertical = 2.dp),
                    )
                }
                Text(t("profile.changeAvatar"), color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 8.dp))
            }
            // ===== 基本信息 =====
            EditCard {
                EditRow(t("profile.nickname")) { EditField(nickname, { nickname = it.take(16) }, t("profile.nicknameHint")) }
                EditDivider()
                EditRow(t("profile.age"), onClick = { showAgePicker = true }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(t("profile.ageYears", "n" to age), color = TextMain, fontSize = 15.sp, modifier = Modifier.weight(1f))
                        Text("›", color = TextDim, fontSize = 20.sp)
                    }
                }
                EditDivider()
                EditRow(t("profile.city")) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        EditField(city, { city = it }, t("profile.cityHint"), Modifier.weight(1f))
                        Text(
                            if (locating) t("profile.locating") else t("profile.locate"), color = Accent, fontSize = 13.sp,
                            modifier = Modifier.padding(start = 10.dp).noRippleClick {
                                locPerm.launch(arrayOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION))
                            },
                        )
                    }
                }
            }
            // ===== 签名 =====
            EditCard {
                Column(Modifier.fillMaxWidth().padding(vertical = 14.dp)) {
                    Text(t("profile.bio"), color = TextSub, fontSize = 14.sp)
                    Box(Modifier.fillMaxWidth().padding(top = 10.dp)) {
                        if (signature.isEmpty()) Text(t("profile.bioPlaceholder"), color = TextDim, fontSize = 15.sp)
                        BasicTextField(
                            signature, { signature = it.take(80) },
                            textStyle = TextStyle(color = TextMain, fontSize = 15.sp, lineHeight = 22.sp),
                            cursorBrush = SolidColor(Accent),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                        )
                    }
                    Text("${signature.length}/80", color = TextDim, fontSize = 11.sp, modifier = Modifier.align(Alignment.End))
                }
            }
            // ===== 照片墙：最多 8 张，展示在他人主页 =====
            EditCard {
                Column(Modifier.fillMaxWidth().padding(vertical = 14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(t("profile.photoWall"), color = TextSub, fontSize = 14.sp)
                        Spacer(Modifier.weight(1f))
                        Text("${photos.size}/8", color = if (photos.size >= 8) Accent else TextDim, fontSize = 12.sp)
                    }
                    Text(
                        if (photos.size >= 8) t("profile.wallFull")
                        else t("profile.wallRemain", "n" to 8 - photos.size),
                        color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp),
                    )
                    val cells = photos + if (photos.size < 8) listOf("+") else emptyList()
                    cells.chunked(4).forEach { rowItems ->
                        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            rowItems.forEach { cell ->
                                Box(Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(10.dp)).background(Bg3)) {
                                    if (cell == "+") {
                                        Box(
                                            Modifier.fillMaxSize().noRippleClick { if (!uploadingPhoto) pickWallPhotos.launch("image/*") },
                                            contentAlignment = Alignment.Center,
                                        ) { Text(if (uploadingPhoto) "…" else "＋", color = TextDim, fontSize = 26.sp) }
                                    } else {
                                        coil.compose.AsyncImage(
                                            model = Api.fullUrl(cell), contentDescription = null,
                                            contentScale = ContentScale.Crop,
                                            modifier = Modifier.fillMaxSize(),
                                        )
                                        // 右上角删除
                                        Text(
                                            "✕", color = Color.White, fontSize = 11.sp,
                                            modifier = Modifier.align(Alignment.TopEnd).padding(4.dp)
                                                .clip(androidx.compose.foundation.shape.CircleShape)
                                                .background(Color.Black.copy(alpha = 0.55f))
                                                .noRippleClick { photos = photos - cell }
                                                .padding(horizontal = 6.dp, vertical = 3.dp),
                                        )
                                    }
                                }
                            }
                            // 补齐空位保持等宽
                            repeat(4 - rowItems.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
            }
            Spacer(Modifier.height(30.dp))
        }
    }
    // ===== 年纪滚轮选择（底部弹层） =====
    if (showAgePicker) {
        AgePickerSheet(
            initial = age.toIntOrNull() ?: 18,
            onDismiss = { showAgePicker = false },
            onConfirm = { age = it.toString(); showAgePicker = false },
        )
    }
}

/** 年纪选择底部弹层（注册页 / 编辑资料共用）：取消 / 确定 + 滚轮 */
@Composable
fun AgePickerSheet(initial: Int, onDismiss: () -> Unit, onConfirm: (Int) -> Unit) {
    var pending by remember { mutableStateOf(initial) }
    androidx.compose.ui.window.Dialog(
        onDismissRequest = onDismiss,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(Modifier.fillMaxSize().noRippleClick(onDismiss), contentAlignment = Alignment.BottomCenter) {
            Column(
                Modifier.fillMaxWidth().noRippleClick { }
                    .clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)).background(Bg2)
                    .navigationBarsPadding(),
            ) {
                Row(Modifier.fillMaxWidth().padding(16.dp, 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(t("common.cancel"), color = TextSub, fontSize = 14.sp, modifier = Modifier.noRippleClick(onDismiss))
                    Text(t("profile.pickAge"), color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
                    Text(t("common.ok"), color = Accent, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick { onConfirm(pending) })
                }
                AgeWheel(initial = initial, onCentered = { pending = it })
                Spacer(Modifier.height(12.dp))
            }
        }
    }
}

/** 编辑资料分组卡片（Bg2 圆角） */
@Composable
private fun EditCard(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(top = 14.dp)
            .clip(RoundedCornerShape(14.dp)).background(Bg2).padding(horizontal = 14.dp),
        content = content,
    )
}

/** 编辑资料行：左标签 + 右内容，可整行点击 */
@Composable
private fun EditRow(label: String, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    Row(
        (if (onClick != null) Modifier.noRippleClick(onClick) else Modifier).fillMaxWidth().padding(vertical = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = TextSub, fontSize = 14.sp, modifier = Modifier.width(76.dp))
        Box(Modifier.weight(1f)) { content() }
    }
}

@Composable
private fun EditDivider() {
    Box(Modifier.fillMaxWidth().height(0.5.dp).background(Line))
}

/** 无边框输入框（暗色行内样式） */
@Composable
private fun EditField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    keyboard: KeyboardType = KeyboardType.Text,
) {
    Box(modifier) {
        if (value.isEmpty()) Text(placeholder, color = TextDim, fontSize = 15.sp)
        BasicTextField(
            value, onChange, singleLine = true,
            textStyle = TextStyle(color = TextMain, fontSize = 15.sp),
            cursorBrush = SolidColor(Accent),
            keyboardOptions = KeyboardOptions(keyboardType = keyboard),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** 年纪滚轮：18-70，snap 对齐，中间高亮为选中值 */
@Composable
private fun AgeWheel(initial: Int, onCentered: (Int) -> Unit) {
    val ages = remember { (18..70).toList() }
    val itemH = 44.dp
    val itemPx = with(LocalDensity.current) { itemH.toPx() }
    val state = rememberLazyListState((initial - 18).coerceIn(0, ages.lastIndex))
    val fling = rememberSnapFlingBehavior(state)
    val centerIdx by remember {
        derivedStateOf {
            (state.firstVisibleItemIndex + if (state.firstVisibleItemScrollOffset > itemPx / 2) 1 else 0)
                .coerceIn(0, ages.lastIndex)
        }
    }
    LaunchedEffect(centerIdx) { onCentered(ages[centerIdx]) }
    Box(Modifier.fillMaxWidth().height(itemH * 5)) {
        LazyColumn(
            state = state, flingBehavior = fling,
            contentPadding = PaddingValues(vertical = itemH * 2),
            modifier = Modifier.fillMaxSize(),
        ) {
            items(ages) { a ->
                val selected = ages[centerIdx] == a
                Box(Modifier.fillMaxWidth().height(itemH), contentAlignment = Alignment.Center) {
                    Text(
                        "$a", color = if (selected) Accent else TextSub,
                        fontSize = if (selected) 22.sp else 15.sp,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                    )
                }
            }
        }
        // 中间选中区参考线
        Box(Modifier.align(Alignment.Center).fillMaxWidth().height(itemH)) {
            Box(Modifier.align(Alignment.TopCenter).fillMaxWidth().height(0.5.dp).background(Line))
            Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(0.5.dp).background(Line))
        }
    }
}