#!/bin/bash
# 初始化数据迁移脚本 - 只需运行一次
# 将容器内数据迁移到宿主机持久化目录

set -e

SERVER_HOST="ubuntu@18.143.63.185"
DATA_DIR="/home/ubuntu/jm/pool-data"
CONTAINER_NAME="jimeng-api"
SSH_KEY="C:/Users/32677/Desktop/dj/tools/ts2.pem"

echo "=== 初始化数据迁移 ==="

ssh -i "$SSH_KEY" "$SERVER_HOST" "
    # 创建数据目录
    mkdir -p $DATA_DIR
    
    # 检查容器是否运行
    if ! docker ps -q -f name=$CONTAINER_NAME | grep -q .; then
        echo '错误: 容器未运行'
        exit 1
    fi
    
    # 复制数据
    echo '从容器复制数据...'
    docker cp $CONTAINER_NAME:/app/tmp/pool-data/. $DATA_DIR/ 2>/dev/null || echo '容器内无数据'
    
    # 显示结果
    echo '数据已迁移到宿主机:'
    ls -la $DATA_DIR/
    
    echo ''
    echo '=== 迁移完成 ==='
    echo '下次发布时，push.sh 会自动使用此目录作为数据卷挂载'
"
