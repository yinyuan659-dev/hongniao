package com.wh.hongniang.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.wh.hongniang.rtc.CallManager
import com.wh.hongniang.ui.noRippleClick

/**
 * 视频按分钟收牵豆（只有男方付）要弹的两个框，放在 AppRoot 最上层，哪个页面发起的视频都能弹。样稿 design/10-qiandou.html。
 *   ① 男方点了视频：先看价格，点「开始视频」才拨出去（CallManager.feeAsk）。牵豆不够 1 分钟时按钮换成「去充值」。
 *   ② 牵豆不够（发起时 / 接听时 / 通话中用完被服务器挂断）：说清楚，可以去充值（CallManager.noBeans）。
 * 通话页上的那几样（来电页的价格行、通话中左上角的已用 / 还剩）在 CallScreen.kt。
 * onTopup：打开充值页（网页 /ai-fee/topup）。
 */
@Composable
fun CallFeeDialogs(onTopup: () -> Unit) {
    val context = LocalContext.current
    val ask by CallManager.feeAsk.collectAsState()
    val noBeans by CallManager.noBeans.collectAsState()
    val goTopup by CallManager.openTopup.collectAsState()
    LaunchedEffect(goTopup) {
        if (goTopup) {
            CallManager.openTopup.value = false
            onTopup()
        }
    }

    ask?.let { a ->
        val close = { CallManager.feeAsk.value = null }
        // 从底下升上来的一张卡：点卡片外面的暗处 = 取消
        Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Box(Modifier.fillMaxSize().noRippleClick(close), contentAlignment = Alignment.BottomCenter) {
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)).background(Color.White)
                        .noRippleClick {}.navigationBarsPadding().padding(start = 20.dp, end = 20.dp, top = 22.dp, bottom = 20.dp),
                ) {
                    Text(if (a.name.isEmpty()) "视频见面" else "和${a.name}视频见面", color = HnInk, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold)
                    Column(Modifier.padding(top = 10.dp)) {
                        FeeRow("价格", "${a.fee.perMin} 牵豆 / 分钟")
                        FeeLine()
                        FeeRow("谁付", "由你支付，对方不花钱")
                        FeeLine()
                        FeeRow("你的牵豆", if (a.fee.enough) "${a.fee.balance}，大约能聊 ${a.fee.minutes} 分钟" else "${a.fee.balance}，不够 1 分钟")
                    }
                    Text(
                        if (a.fee.enough) "接通后开始算，不满 1 分钟按 1 分钟。牵豆用完会自动挂断。" else "牵豆不够，至少要 ${a.fee.perMin}。充值后再打。",
                        color = if (a.fee.enough) HnInk2 else HnRose, fontSize = 12.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 8.dp),
                    )
                    Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        HnButton("取消", Modifier.weight(1f), ghost = true, height = 48.dp, onClick = close)
                        if (a.fee.enough) {
                            HnButton("开始视频", Modifier.weight(1.6f), height = 48.dp) {
                                close()
                                CallManager.startCall(context, a.calleeId, 2, a.name, a.avatar, feeConfirmed = true)
                            }
                        } else {
                            HnButton("去充值", Modifier.weight(1.6f), height = 48.dp) { close(); onTopup() }
                        }
                    }
                }
            }
        }
    }

    noBeans?.let { n ->
        val close = { CallManager.noBeans.value = null }
        Dialog(onDismissRequest = close) {
            Column(Modifier.clip(RoundedCornerShape(24.dp)).background(Color.White).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(n.title, color = HnInk, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center)
                Text(n.text, color = HnInk2, fontSize = 13.5.sp, lineHeight = 22.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 7.dp))
                Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    HnButton("知道了", Modifier.weight(1f), ghost = true, height = 44.dp, onClick = close)
                    HnButton("去充值", Modifier.weight(1.3f), height = 44.dp) { close(); onTopup() }
                }
            }
        }
    }
}

@Composable
private fun FeeRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = HnInk2, fontSize = 14.sp)
        Text(value, color = HnInk, fontSize = 14.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.End, modifier = Modifier.weight(1f).padding(start = 12.dp))
    }
}

@Composable
private fun FeeLine() {
    Box(Modifier.fillMaxWidth().height(0.5.dp).background(Color(0x14000000)))
}
