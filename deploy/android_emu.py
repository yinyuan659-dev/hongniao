# -*- coding: utf-8 -*-
"""
在本机的安卓模拟器里看 App（2026-11-27 做群聊安卓端时加的）。只是个小工具：开模拟器、装包、截图、按文字点。

  python deploy/android_emu.py start            开模拟器（现成的虚拟机 elder35，-read-only：退出后不留任何改动），等它开完机
  python deploy/android_emu.py install [apk]    装包（默认 android/app/build/outputs/apk/debug/app-debug.apk），并把会弹系统页面的几项权限先处理掉
  python deploy/android_emu.py login f|m        让 App 用女 / 男测试号进入（见下面「测试号」），并重新打开 App
  python deploy/android_emu.py open             打开 App
  python deploy/android_emu.py shot <名字>      截图到 design/live/<名字>.png（先缩到 360 宽再存）
  python deploy/android_emu.py texts            列出屏幕上现在有的文字和位置
  python deploy/android_emu.py tap <文字> [第几个]   点屏幕上的这段文字（完全一样的优先，没有就找包含的）
  python deploy/android_emu.py tapxy <x> <y>    点坐标（屏幕是 1080×2400）
  python deploy/android_emu.py swipe <x1> <y1> <x2> <y2> [毫秒]
  python deploy/android_emu.py text <英文数字>  往输入框里打字（adb 打不了中文）
  python deploy/android_emu.py back             返回键
  python deploy/android_emu.py stop             关模拟器

测试号：App 是一机一号（设备号 = 系统给的 ANDROID_ID），模拟器是台新设备，正常打开会走注册、注册出新账号。
要用测试号，得让 App 把设备号换成测试号的那个。**正式代码里没有这个口子**：测的时候临时在 Api.kt 的 resolveDeviceId
开头加两行（标着 TEMP-EMU-TEST）去读 App 私有目录里的 hn_dev_override.txt，只编一个装在模拟器里的包，测完把那两行删掉、
重新出包。login 这一步就是把 deploy/dev_f.json / dev_m.json 里的设备号写进那个文件（不打印）。
包里没有那两行的话 login 不起作用，App 会停在注册页——这时候不要注册。
"""
import io
import json
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SDK = os.path.join(os.environ['LOCALAPPDATA'], 'Android', 'Sdk')
ADB = os.path.join(SDK, 'platform-tools', 'adb.exe')
EMU = os.path.join(SDK, 'emulator', 'emulator.exe')
PKG = 'com.wh.hongniang'
AVD = 'elder35'
# 我们的模拟器固定用这一对端口（控制台 5580、adb 5581），在 adb 里叫 emulator-5580。见 our_serial 的说明
PORT = 5580


_serial = None


def our_serial():
    """
    我们自己那台虚拟机（名字是 AVD）的序列号；没开着返回 None。
    这台电脑上可能同时开着别的模拟器：2026-11-28 就碰到一台雷电模拟器，在 adb 里也叫 emulator-5554，
    当时这个脚本只看「有没有 emulator- 开头的设备」，结果把包装到了那一台上（已卸掉）。
    所以只认名字对得上的那一台，所有命令都带着它的序列号发；别的设备一律不碰。

    名字要从设备自己身上问（getprop，和后面发命令走的是同一条连接）。不能用 `adb emu avd name`：那是去问本机 5554 端口上的控制台，
    别的模拟器占着 adb 的 5555、我们的模拟器占着控制台的 5554 时，问到的是我们的名字，命令却发给了别人（第二次就是这么错的）。
    所以我们的模拟器固定开在 PORT 这一对端口上，不和别的模拟器抢 5554 / 5555。
    """
    out = subprocess.run([ADB, 'devices'], capture_output=True, timeout=30).stdout.decode('utf-8', 'replace')
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 2 or parts[0] != 'emulator-%d' % PORT or parts[1] != 'device':
            continue
        try:
            got = subprocess.run([ADB, '-s', parts[0], 'shell', 'getprop', 'ro.boot.qemu.avd_name'], capture_output=True, timeout=15).stdout.decode('utf-8', 'replace').strip()
        except subprocess.TimeoutExpired:
            got = ''
        if got == AVD:
            return parts[0]
    return None


def adb(*args, data=None, timeout=60, check=False):
    global _serial
    if _serial is None:
        _serial = our_serial()
        if _serial is None:
            raise SystemExit('我们的模拟器（%s）没开着，先 start。连着的别的设备不是我们的，不碰。' % AVD)
    r = subprocess.run([ADB, '-s', _serial] + list(args), input=data, capture_output=True, timeout=timeout)
    if check and r.returncode != 0:
        raise SystemExit('adb %s 失败：%s' % (args[0], (r.stderr or r.stdout).decode('utf-8', 'replace')[-300:]))
    return r.stdout


def sh(cmd, **kw):
    return adb('shell', cmd, **kw).decode('utf-8', 'replace')


def start():
    global _serial
    if our_serial():
        print('模拟器已经开着')
    else:
        log = open(os.path.join(os.environ['TEMP'], 'hn_emulator.log'), 'wb')
        # 画面怎么渲染：默认用软件渲染（哪台电脑都能跑）。软件渲染下 App 里的内嵌网页是一片白、也点不动（原生页面正常），
        # 要看内嵌网页就先设 $env:HN_EMU_GPU='host'（用这台电脑的显卡）再 start
        gpu = os.environ.get('HN_EMU_GPU') or 'swiftshader_indirect'
        subprocess.Popen([EMU, '-avd', AVD, '-port', str(PORT), '-read-only', '-no-snapshot', '-no-boot-anim', '-no-audio', '-no-window', '-gpu', gpu],
                         stdout=log, stderr=log, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS)
    end = time.time() + 300
    while time.time() < end:
        _serial = _serial or our_serial()
        if _serial and sh('getprop sys.boot_completed').strip() == '1':
            break
        time.sleep(3)
    else:
        raise SystemExit('5 分钟了模拟器还没开完机，看 %TEMP%\\hn_emulator.log')
    sh('settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 1')
    print('模拟器开好了：Android %s，屏幕 %s' % (sh('getprop ro.build.version.release').strip(), sh('wm size').strip()))


def install(apk=None):
    apk = apk or os.path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
    out = adb('install', '-r', apk, timeout=300).decode('utf-8', 'replace')
    print('装包：' + out.strip().splitlines()[-1])
    # App 进去以后会要这几样，没有就跳到系统页面去：通知、忽略电池优化、悬浮窗。先给上，免得挡住
    sh('pm grant %s android.permission.POST_NOTIFICATIONS' % PKG)
    sh('dumpsys deviceidle whitelist +%s' % PKG)
    sh('appops set %s SYSTEM_ALERT_WINDOW allow' % PKG)


def login(who):
    path = os.path.join(ROOT, 'deploy', 'dev_f.json' if who == 'f' else 'dev_m.json')
    dev = json.load(open(path, encoding='utf-8'))
    did = dev.get('deviceId') or dev.get('device_id') or next(v for v in dev.values() if isinstance(v, str) and v.startswith('web_'))
    if not re.fullmatch(r'[A-Za-z0-9_]+', did):
        raise SystemExit('设备号里有意外的字符')
    # 测试包关了可调试标志（build.gradle.kts 里 isDebuggable = false），run-as 用不了；这个模拟器镜像（google_apis）可以 adb root
    adb('root')
    time.sleep(2)
    adb('wait-for-device')
    base = '/data/user/0/%s' % PKG
    sh('am force-stop %s' % PKG)
    # 清掉上一个号留下的登录状态（token 等），再写覆盖文件，属主改回 App 自己
    sh('rm -rf %s/shared_prefs %s/files/hn_dev_override.txt; mkdir -p %s/files' % (base, base, base))
    adb('shell', 'cat > %s/files/hn_dev_override.txt' % base, data=did.encode())
    sh('chown -R $(stat -c %%u:%%g %s) %s/files; restorecon -R %s/files' % (base, base, base))
    n = sh('wc -c < %s/files/hn_dev_override.txt' % base).strip()
    print('已写入%s测试号的设备号（%s 字节，不打印内容）' % ('女' if who == 'f' else '男', n))
    open_app()


def open_app():
    sh('monkey -p %s -c android.intent.category.LAUNCHER 1' % PKG)
    time.sleep(4)


def shot(name):
    from PIL import Image
    raw = adb('exec-out', 'screencap', '-p', timeout=60)
    img = Image.open(io.BytesIO(raw)).convert('RGB')
    img = img.resize((360, round(img.height * 360 / img.width)), Image.LANCZOS)
    out = os.path.join(ROOT, 'design', 'live', name + '.png')
    img.save(out)
    print('截图 ' + out)


def nodes():
    """屏幕上的文字：[(文字, x 中心, y 中心, 左, 上, 右, 下)]"""
    sh('uiautomator dump /sdcard/hn_ui.xml >/dev/null 2>&1')
    raw = adb('exec-out', 'cat', '/sdcard/hn_ui.xml')
    out = []
    try:
        root = ET.fromstring(raw.decode('utf-8', 'replace'))
    except ET.ParseError:
        return out
    for n in root.iter('node'):
        text = n.get('text') or n.get('content-desc') or ''
        m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', n.get('bounds') or '')
        if text and m:
            l, t, r, b = map(int, m.groups())
            out.append((text, (l + r) // 2, (t + b) // 2, l, t, r, b))
    return out


def tap(text, nth=0):
    ns = nodes()
    hit = [n for n in ns if n[0] == text] or [n for n in ns if text in n[0]]
    if len(hit) <= nth:
        raise SystemExit('屏幕上没有「%s」。现在有：%s' % (text, ' | '.join(n[0].replace('\n', ' ')[:20] for n in ns)[:600]))
    sh('input tap %d %d' % (hit[nth][1], hit[nth][2]))
    print('点了「%s」(%d, %d)' % (hit[nth][0].replace('\n', ' ')[:30], hit[nth][1], hit[nth][2]))
    time.sleep(1.2)


def main():
    a = sys.argv[1:]
    op = a[0] if a else ''
    if op == 'start':
        start()
    elif op == 'install':
        install(a[1] if len(a) > 1 else None)
    elif op == 'login' and len(a) > 1 and a[1] in ('f', 'm'):
        login(a[1])
    elif op == 'open':
        open_app()
    elif op == 'shot' and len(a) > 1:
        shot(a[1])
    elif op == 'texts':
        for n in nodes():
            print('%4d,%4d  [%d,%d - %d,%d]  %s' % (n[1], n[2], n[3], n[4], n[5], n[6], n[0].replace('\n', ' ⏎ ')))
    elif op == 'tap' and len(a) > 1:
        tap(a[1], int(a[2]) if len(a) > 2 else 0)
    elif op == 'tapxy' and len(a) > 2:
        sh('input tap %s %s' % (int(a[1]), int(a[2])))
        time.sleep(1.2)
    elif op == 'swipe' and len(a) > 4:
        sh('input swipe %d %d %d %d %d' % (int(a[1]), int(a[2]), int(a[3]), int(a[4]), int(a[5]) if len(a) > 5 else 300))
        time.sleep(1)
    elif op == 'text' and len(a) > 1:
        if not re.fullmatch(r'[A-Za-z0-9 ._-]+', a[1]):
            raise SystemExit('adb 只能打英文和数字')
        sh('input text "%s"' % a[1].replace(' ', '%s'))
    elif op == 'back':
        sh('input keyevent 4')
        time.sleep(1)
    elif op == 'stop':
        adb('emu', 'kill')
        print('模拟器已关')
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
