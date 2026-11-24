# -*- coding: utf-8 -*-
"""服务器运维小工具（需要 pip install paramiko）。
密码不写在这里：从环境变量 HN_PW 读取（值见 `服务器凭据-勿提交.md`）；主机指纹固定校验，对不上就拒绝连接。

用法（PowerShell，先 $env:HN_PW='...'; $env:PYTHONIOENCODING='utf-8'）:
  python remote.py run <本地脚本.sh> [超时秒]     在服务器上用 bash 执行本地脚本
  python remote.py put <本地文件> <远程路径>       上传单个文件
  python remote.py putdir <本地目录> <远程目录>    上传目录（会先清空远程目录；跳过 node_modules / dist / build / .git）
"""
import io
import os
import sys
import tarfile

import paramiko

HOST = '120.55.59.158'
FP = 'SHA256:7OjRQ1t8M8W3L+zvAZglw8KG+6ZfYDt5113CqCjWTok'
SKIP = {'node_modules', 'dist', '.git', 'build', '.gradle'}


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, 'root', os.environ['HN_PW'], timeout=20, look_for_keys=False, allow_agent=False)
    got = c.get_transport().get_remote_server_key().fingerprint
    if got != FP:
        c.close()
        raise SystemExit(f'主机指纹不符: {got}')
    c.get_transport().set_keepalive(30)
    return c


def run(c, script, timeout):
    stdin, stdout, stderr = c.exec_command('bash -s', timeout=timeout, get_pty=False)
    stdin.write(script)
    stdin.channel.shutdown_write()
    ch = stdout.channel
    ch.set_combine_stderr(True)
    out = sys.stdout.buffer
    while True:
        data = ch.recv(65536)
        if not data:
            break
        out.write(data)
        out.flush()
    return ch.recv_exit_status()


def main():
    op = sys.argv[1]
    c = connect()
    try:
        if op == 'run':
            script = open(sys.argv[2], 'r', encoding='utf-8').read().replace('\r\n', '\n')
            timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 600
            code = run(c, script, timeout)
            print(f'\n[exit {code}]')
            sys.exit(code)
        elif op == 'put':
            sftp = c.open_sftp()
            sftp.put(sys.argv[2], sys.argv[3])
            print('uploaded', sys.argv[3], sftp.stat(sys.argv[3]).st_size)
        elif op == 'putdir':
            local, remote = sys.argv[2], sys.argv[3]
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode='w:gz') as tar:
                for root, dirs, files in os.walk(local):
                    dirs[:] = [d for d in dirs if d not in SKIP]
                    for f in files:
                        full = os.path.join(root, f)
                        rel = os.path.relpath(full, local).replace('\\', '/')
                        tar.add(full, arcname=rel)
            data = buf.getvalue()
            sftp = c.open_sftp()
            tmp = '/tmp/hn_upload.tgz'
            with sftp.open(tmp, 'wb') as fh:
                fh.set_pipelined(True)
                fh.write(data)
            code = run(c, f'set -e\nrm -rf "{remote}"\nmkdir -p "{remote}"\ntar -xzf {tmp} -C "{remote}"\nchmod -R go-w "{remote}"\nrm -f {tmp}\necho extracted to {remote}: $(find "{remote}" -type f | wc -l) files\n', 300)
            print(f'uploaded {len(data)} bytes [exit {code}]')
            sys.exit(code)
    finally:
        c.close()


if __name__ == '__main__':
    main()
