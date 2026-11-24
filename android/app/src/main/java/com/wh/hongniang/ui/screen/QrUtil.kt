package com.wh.hongniang.ui.screen

import android.graphics.Bitmap
import androidx.core.graphics.drawable.toBitmap
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.CaptureActivity

/** 竖屏扫码页（zxing-embedded 默认横屏） */
class PortraitCaptureActivity : CaptureActivity()

/** 识别图片里的二维码（聊天大图「识别二维码」）；先用局部二值化，认不出再用全局直方图（截图、深色底的码） */
fun decodeQr(bitmap: Bitmap): String? {
    val w = bitmap.width
    val h = bitmap.height
    val pixels = IntArray(w * h)
    bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
    val source = com.google.zxing.RGBLuminanceSource(w, h, pixels)
    val hints = mapOf(
        com.google.zxing.DecodeHintType.TRY_HARDER to true,
        com.google.zxing.DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
    )
    val binarizers = listOf(com.google.zxing.common.HybridBinarizer(source), com.google.zxing.common.GlobalHistogramBinarizer(source), com.google.zxing.common.HybridBinarizer(source.invert()))
    for (b in binarizers) {
        runCatching { return com.google.zxing.qrcode.QRCodeReader().decode(com.google.zxing.BinaryBitmap(b), hints).text }
    }
    return null
}

/** 下载（或从 Coil 缓存取）一张图再识别二维码；长边缩到 2048 以内 */
suspend fun decodeQrFromUrl(context: android.content.Context, url: String): String? {
    val req = coil.request.ImageRequest.Builder(context).data(url).allowHardware(false).size(2048).build()
    val result = coil.Coil.imageLoader(context).execute(req) as? coil.request.SuccessResult ?: return null
    return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { decodeQr(result.drawable.toBitmap()) }
}
