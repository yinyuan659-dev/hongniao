package com.wh.hongniang

import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.PathParser
import com.wh.hongniang.ui.screen.IC_CAR
import com.wh.hongniang.ui.screen.IC_CHEVRON
import com.wh.hongniang.ui.screen.IC_LEAF
import com.wh.hongniang.ui.screen.IC_USERS
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 群的默认头像（没有封面时按类型画的小图标）是把 SVG 路径交给 PathParser 画的。
 * 路径写错了编译时发现不了，要到画那个头像的时候才出错，所以在这里先解析一遍：
 * 每条路径都解析得出来、以「移动到」开头、所有坐标都落在 24×24 的画板里（留一点余量给曲线的控制点）。
 */
class GroupIconPathTest {
    private fun check(name: String, paths: List<String>) {
        assertTrue("$name 没有路径", paths.isNotEmpty())
        paths.forEach { p ->
            val nodes = PathParser().parsePathString(p).toNodes()
            assertTrue("$name 解析出来是空的：$p", nodes.isNotEmpty())
            assertTrue("$name 不是以移动到开头：$p", nodes.first() is PathNode.MoveTo || nodes.first() is PathNode.RelativeMoveTo)
            // 把相对坐标累加成绝对坐标，看终点有没有跑到画板外面
            var x = 0f
            var y = 0f
            nodes.forEach { n ->
                when (n) {
                    is PathNode.MoveTo -> { x = n.x; y = n.y }
                    is PathNode.RelativeMoveTo -> { x += n.dx; y += n.dy }
                    is PathNode.LineTo -> { x = n.x; y = n.y }
                    is PathNode.RelativeLineTo -> { x += n.dx; y += n.dy }
                    is PathNode.HorizontalTo -> x = n.x
                    is PathNode.RelativeHorizontalTo -> x += n.dx
                    is PathNode.VerticalTo -> y = n.y
                    is PathNode.RelativeVerticalTo -> y += n.dy
                    is PathNode.CurveTo -> { x = n.x3; y = n.y3 }
                    is PathNode.RelativeCurveTo -> { x += n.dx3; y += n.dy3 }
                    is PathNode.ReflectiveCurveTo -> { x = n.x2; y = n.y2 }
                    is PathNode.RelativeReflectiveCurveTo -> { x += n.dx2; y += n.dy2 }
                    is PathNode.ArcTo -> { x = n.arcStartX; y = n.arcStartY }
                    is PathNode.RelativeArcTo -> { x += n.arcStartDx; y += n.arcStartDy }
                    else -> {}
                }
                assertTrue("$name 画到画板外面了 ($x, $y)：$p", x in -0.5f..24.5f && y in -0.5f..24.5f)
            }
        }
    }

    @Test
    fun defaultAvatarIconsParse() {
        check("旅行（车）", IC_CAR)
        check("活动（叶子）", IC_LEAF)
        check("测试（人）", IC_USERS)
        check("箭头", IC_CHEVRON)
    }
}
