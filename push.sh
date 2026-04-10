#!/bin/bash
# jimeng-free-api 发布脚本（低停机版本）
# 构建和启动分离，只有切换时有秒级中断
# VS Code 里直接点右上角运行按钮执行
# 用法: ./push.sh [quick]

set -e

LOCAL_DIR="C:/d盘/zf/jimengfreeapiallself"
SERVER_HOST="ubuntu@18.143.63.185"
SERVER_DIR="/home/ubuntu/jm/jimeng-free-api-all"
DATA_DIR="/home/ubuntu/jm/pool-data"
BACKUP_DIR="/home/ubuntu/jm/backups"
SSH_KEY="C:/Users/32677/Desktop/dj/tools/ts2.pem"
CONTAINER_NAME="jimeng-api"
FILE_NAME="jimeng-free-api-deploy.tar.gz"

MODE="${1:-full}"

echo "=== 开始发布 jimeng-free-api [模式: $MODE] ==="

cd "$LOCAL_DIR"
rm -rf $FILE_NAME

if [ "$MODE" = "quick" ]; then
    echo "[快速模式] 本地构建..."
    if [ ! -d "node_modules" ]; then
        yarn install --registry https://registry.npmmirror.com/
    fi
    yarn build
    echo "[快速模式] 打包 dist..."
    tar zcvf $FILE_NAME dist/ package.json configs/ public/ 2>/dev/null || true
else
    echo "[完整模式] 打包源码..."
    tar zcvf $FILE_NAME \
        --exclude='node_modules' --exclude='dist' --exclude='tmp' \
        --exclude='logs' --exclude='*.tar.gz' --exclude='.git' \
        --exclude='.idea' --exclude='*.bak' \
        .
fi

echo "上传到服务器..."
scp -i $SSH_KEY $FILE_NAME $SERVER_HOST:$SERVER_DIR/

echo "服务器端操作..."
ssh -i $SSH_KEY $SERVER_HOST "
    set -e
    mkdir -p $BACKUP_DIR
    TIMESTAMP=\$(date +%Y%m%d-%H%M%S)
    
    cd $SERVER_DIR
    
    # 备份
    tar zcvf $BACKUP_DIR/code-\$TIMESTAMP.tar.gz --exclude='node_modules' --exclude='*.tar.gz' . 2>/dev/null
    echo \"代码备份: code-\$TIMESTAMP.tar.gz\"
    if [ -d $DATA_DIR ] && [ \"\$(ls -A $DATA_DIR 2>/dev/null)\" ]; then
        tar zcvf $BACKUP_DIR/data-\$TIMESTAMP.tar.gz -C $DATA_DIR . 2>/dev/null
        echo \"数据备份: data-\$TIMESTAMP.tar.gz\"
    fi
    
    # 解压新代码
    tar zxvf $FILE_NAME --overwrite
    
    if [ '$MODE' = 'full' ]; then
        echo '构建新镜像（旧容器继续运行）...'
        # 构建新镜像，但不停旧容器
        docker build -t ${CONTAINER_NAME}:\$TIMESTAMP .
        docker tag ${CONTAINER_NAME}:\$TIMESTAMP $CONTAINER_NAME:latest
        echo '镜像构建完成'
    fi
    
    # 快速切换（只有这一步有中断，秒级）
    echo '切换容器（约3-5秒中断）...'
    docker stop $CONTAINER_NAME 2>/dev/null || true
    docker rm $CONTAINER_NAME 2>/dev/null || true
    
    if [ '$MODE' = 'quick' ]; then
        docker run -d --name $CONTAINER_NAME --restart unless-stopped -p 8000:8000 \
            -v $SERVER_DIR/dist:/app/dist:ro \
            -v $SERVER_DIR/package.json:/app/package.json:ro \
            -v $SERVER_DIR/configs:/app/configs:ro \
            -v $SERVER_DIR/public:/app/public:ro \
            -v $DATA_DIR:/app/tmp/pool-data \
            -e ADMIN_KEY=admin-secret-key \
            $CONTAINER_NAME
    else
        docker run -d --name $CONTAINER_NAME --restart unless-stopped -p 8000:8000 \
            -v $DATA_DIR:/app/tmp/pool-data \
            -e ADMIN_KEY=admin-secret-key \
            $CONTAINER_NAME:latest
    fi
    
    sleep 2
    docker ps -f name=$CONTAINER_NAME --format 'table {{.Names}}\t{{.Status}}'
    echo '服务已恢复'
"

echo "查看日志..."
ssh -i $SSH_KEY $SERVER_HOST "docker logs -f --tail=20 $CONTAINER_NAME"
