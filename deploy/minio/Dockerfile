# MinIO 自建镜像。
# 背景（2026-11）：MinIO 开源版已停止维护，官方不再提供 Docker 镜像（国内镜像站拉不到 minio/minio），
# dl.min.io 也不再提供下载（返回 410）。这里从官方中国站 dl.minio.org.cn 下载最后一个带完整功能的社区版二进制。
# 下面的 SHA256 对应的文件已用 MinIO 官方 minisign 公钥
#   RWTx5Zr1tiHQLwG9keckT0c45M3AGeHD6IvimQHpyRywVWGbP1aVSGav
# 验证过签名（2026-11-22）。换版本时要重新验证并更新 SHA256。
FROM alpine:3.20
ARG MINIO_RELEASE=RELEASE.2025-04-22T22-12-26Z
ARG MINIO_SHA256=53e2a2cb16c5366ea6fbbc479c19ddb4c6a0948273e752f740fb1fbf27bb817c
RUN wget -q -O /usr/bin/minio "https://dl.minio.org.cn/server/minio/release/linux-amd64/archive/minio.${MINIO_RELEASE}" \
    && echo "${MINIO_SHA256}  /usr/bin/minio" | sha256sum -c - \
    && chmod +x /usr/bin/minio
VOLUME /data
EXPOSE 9000
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data"]
