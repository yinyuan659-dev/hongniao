package com.wh.hongniang.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.hongniang.net.*
import com.wh.hongniang.ui.*
import com.wh.hongniang.ui.theme.*
import kotlinx.coroutines.launch
import com.wh.hongniang.i18n.I18n
import com.wh.hongniang.i18n.t

@Composable
fun MeScreen(modifier: Modifier = Modifier, initialUser: UserProfile?, onNav: (String) -> Unit) {
    var me by remember { mutableStateOf(initialUser) }
    // 资料收集有变化（答题 / 确认）时重新拉一次，回到这页能马上看到「已完成」
    /** AI 余额（元）；null = 还没取到 */
    var aiBalance by remember { mutableStateOf<String?>(null) }
    /** 后台要求先做实人认证、而我还没做：显示一行「完成实人认证」（做过才能聊天 / 发动态 / 评论） */
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

    // 头部（头像到相亲资料卡）固定不动，下面的功能分组单独滚动
    Column(modifier = modifier.fillMaxSize()) {
        run {
            Column(modifier = Modifier.background(Brush.verticalGradient(listOf(Accent.copy(alpha = 0.14f), Bg))).padding(20.dp, 28.dp, 20.dp, 16.dp)) {
                Row(verticalAlignment = Alignment.Top) {
                    Avatar(u.avatar, 76)
                    Column(modifier = Modifier.weight(1f).padding(start = 16.dp, top = 4.dp)) {
                        Text(u.nickname, color = TextMain, fontSize = 21.sp, fontWeight = FontWeight.Bold)
                        Row(modifier = Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                "${if (u.gender == 1) t("me.male") else t("me.female")} ${u.age}",
                                color = if (u.gender == 1) Color(0xFF6DB3FF) else Color(0xFFFF7A95), fontSize = 11.sp,
                                modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(Bg3).padding(horizontal = 10.dp, vertical = 2.dp),
                            )
                        }
                        if (u.shortId != null) Text(t("me.id", "id" to u.shortId), color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
                    }
                    // 扫一扫（邀请名片）
                    Box(
                        Modifier.padding(top = 4.dp).size(38.dp).clip(CircleShape).background(Bg3)
                            .noRippleClick(startScan),
                        contentAlignment = Alignment.Center,
                    ) { ScanIcon(TextMain, 18.dp) }
                }
                Text(u.signature.ifEmpty { t("me.noSignature") }, color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(top = 14.dp))
                // 点击进关注/粉丝列表
                Row(modifier = Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(26.dp)) {
                    Row(Modifier.noRippleClick { onNav("follows/following") }, verticalAlignment = Alignment.CenterVertically) {
                        Text("${u.following}", color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                        Text(" " + t("me.following"), color = TextSub, fontSize = 13.sp)
                    }
                    Row(Modifier.noRippleClick { onNav("follows/fans") }, verticalAlignment = Alignment.CenterVertically) {
                        Text("${u.fans}", color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                        Text(" " + t("me.fans"), color = TextSub, fontSize = 13.sp)
                    }
                }
                // 我的相亲画像：基本情况（点选问答，必做）+ AI 深聊（可选）。没做完基本情况不能主动找人聊天
                MePortraitCard(u, Modifier.padding(top = 16.dp), onNav)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Line))

        var picking by remember { mutableStateOf(false) }
        if (picking) LanguageDialog { picking = false }
        val langName = if (I18n.choice == I18n.SYSTEM) t("lang.system") else I18n.languages.firstOrNull { it.first == I18n.choice }?.second.orEmpty()
        LazyColumn(Modifier.weight(1f).fillMaxWidth().background(Bg2), contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                MeGroup(t("me.group.content")) {
                    MeRow(t("me.myMoments"), last = true) { onNav("my-moments") }
                }
            }
            // AI 费用：深聊这类 AI 功能按用量花模型费（平台余额或自己的 Key）；点进去是网页
            item {
                MeGroup("AI 费用") {
                    MeRow("AI 余额", value = aiBalance?.let { "¥$it" }, last = true) { onNav(hnH5("/ai-fee")) }
                }
            }
            // 账号与安全：实人认证（后台要求且还没做时才出现）、登录设备（换手机刷脸找回后会多出来，可以移除）；点进去都是网页
            item {
                MeGroup("账号与安全") {
                    if (needKyc) {
                        MeRow("完成实人认证", value = "做过才能聊天 · ¥1") { onNav(hnH5("/kyc?next=/me")) }
                        Box(Modifier.fillMaxWidth().padding(start = 16.dp).height(0.5.dp).background(Line))
                    }
                    MeRow("登录设备", value = deviceCount?.let { "$it 台" }, last = true) { onNav(hnH5("/devices")) }
                }
            }
            item {
                MeGroup(t("me.group.settings")) {
                    // 编辑资料 = 进 AI 红娘的资料收集；头像 / 昵称 / 照片墙单独一行
                    MeRow(t("me.editProfile")) { onNav("interview") }
                    MeRow(t("hn.basic")) { onNav("edit-profile") }
                    // 视频见面：默认关，自己和对方都打开才能互相发起视频通话
                    Row(modifier = Modifier.fillMaxWidth().padding(16.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(t("me.videoMeet"), color = TextMain, fontSize = 15.sp)
                            Text(t("me.videoMeetSub"), color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                        }
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
                    Box(Modifier.fillMaxWidth().padding(start = 16.dp).height(0.5.dp).background(Line))
                    MeRow(t("lang.title"), value = langName, last = u.gender != 1) { picking = true }
                    // 男方专属：视频通话默认是否开启自己画面（默认关闭；女方无此设置）
                    if (u.gender == 1) {
                        var camOn by remember { mutableStateOf(Api.camDefaultOn) }
                        Row(modifier = Modifier.fillMaxWidth().padding(16.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(t("me.camDefault"), color = TextMain, fontSize = 15.sp)
                                Text(t("me.camDefaultSub"), color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                            }
                            androidx.compose.material3.Switch(
                                checked = camOn,
                                onCheckedChange = { camOn = it; Api.camDefaultOn = it },
                                colors = androidx.compose.material3.SwitchDefaults.colors(checkedTrackColor = Accent),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** 「我的」页一个功能分组：小标题 + 白色圆角卡片 */
@Composable
private fun MeGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp)) {
        Text(title, color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(start = 6.dp, bottom = 6.dp))
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Bg), content = content)
    }
}

@Composable
private fun MeRow(label: String, value: String? = null, last: Boolean = false, onClick: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp, 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = TextMain, fontSize = 15.sp, modifier = Modifier.weight(1f))
        if (value != null) Text(value, color = TextSub, fontSize = 14.sp, modifier = Modifier.padding(end = 6.dp))
        Text("›", color = TextDim, fontSize = 18.sp)
    }
    if (!last) Box(Modifier.fillMaxWidth().padding(start = 16.dp).height(0.5.dp).background(Line))
}

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
