package com.wh.hongniang.ui.screen

import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.wh.hongniang.i18n.t
import com.wh.hongniang.net.Api
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** 从扫码结果里提取邀请名片码（名片二维码内容 https://域名/t/?u=短号） */
fun parseInviteCode(text: String): String? {
    if (!text.contains("/t/")) return null
    return Regex("[?&]u=(\\d{1,19})").find(text)?.groupValues?.get(1)
}

/**
 * 扫到的二维码统一在这里处理（扫一扫、聊天图片「识别二维码」共用）：
 * 邀请名片 → 私聊。
 */
@Composable
fun rememberScanHandler(onNav: (String) -> Unit): (String) -> Unit {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    fun toast(msg: String) = Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()

    fun openByInvite(code: String) = scope.launch {
        runCatching {
            Api.request("/im/conversations/open-by-code", "POST", buildJsonObject { put("code", JsonPrimitive(code)) }) as JsonObject
        }.onSuccess { data ->
            val convId = data["conversationId"]?.jsonPrimitive?.content ?: return@onSuccess
            val peer = data["peer"]?.jsonObject
            val peerId = peer?.get("id")?.jsonPrimitive?.content ?: ""
            val nickname = peer?.get("nickname")?.jsonPrimitive?.content ?: ""
            onNav("chatroom/$convId?targetId=$peerId&title=${Uri.encode(nickname)}")
        }.onFailure { toast(it.message ?: t("qr.openChatFailed")) }
    }

    return remember(onNav) {
        { raw: String ->
            val invite = parseInviteCode(raw.trim())
            if (invite != null) openByInvite(invite) else toast(t("qr.unrecognized"))
        }
    }
}

/** 扫一扫（我的页 / 消息页「+」和搜索框共用），返回「打开扫码」的函数 */
@Composable
fun rememberQrScan(onNav: (String) -> Unit): () -> Unit {
    val handle = rememberScanHandler(onNav)
    val launcher = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let(handle)
    }
    return {
        launcher.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(t("qr.scanPrompt"))
                .setBeepEnabled(false)
                .setOrientationLocked(true)
                .setCaptureActivity(PortraitCaptureActivity::class.java),
        )
    }
}
