# jimeng-free-api 发布脚本 (PowerShell 用)
# 用法: .\push.ps1 [quick]
# 或右键→使用 PowerShell 运行

param(
    [string]$Mode = "full"  # full 或 quick
)

$ErrorActionPreference = "Stop"

# 配置
$LocalDir = "C:\d盘\zf\jimengfreeapiallself"
$ServerHost = "ubuntu@18.143.63.185"
$ServerDir = "/home/ubuntu/jm/jimeng-free-api-all"
$DataDir = "/home/ubuntu/jm/pool-data"
$BackupDir = "/home/ubuntu/jm/backups"
$SshKey = "C:\Users\32677\Desktop\dj\tools\ts2.pem"
$ContainerName = "jimeng-api"
$FileName = "jimeng-free-api-deploy.tar.gz"

Write-Host "=== 开始发布 jimeng-free-api ===" -ForegroundColor Yellow
Write-Host "模式: $Mode" -ForegroundColor Cyan

Set-Location $LocalDir
Remove-Item $FileName -ErrorAction SilentlyContinue

if ($Mode -eq "quick") {
    Write-Host "1. 快速模式：本地构建并打包..." -ForegroundColor Yellow
    if (-not (Test-Path "node_modules")) {
        Write-Host "安装依赖..." -ForegroundColor Yellow
        yarn install --registry https://registry.npmmirror.com/
    }
    Write-Host "本地构建 dist..." -ForegroundColor Yellow
    yarn build
    tar zcvf $FileName dist/ package.json configs/ public/ 2>$null
} else {
    Write-Host "1. 完整模式：打包源码..." -ForegroundColor Yellow
    # PowerShell tar 不支持 --exclude，用 7z 或先复制到临时目录
    $TempDir = "temp_deploy_$(Get-Random)"
    New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
    Copy-Item src, package.json, tsconfig.json, Dockerfile, configs, public -Destination $TempDir -Recurse -Force 2>$null
    Set-Location $TempDir
    tar zcvf "$LocalDir\$FileName" *
    Set-Location $LocalDir
    Remove-Item $TempDir -Recurse -Force
}

Write-Host "2. 上传到服务器..." -ForegroundColor Yellow
scp -i $SshKey $FileName "${ServerHost}:${ServerDir}/"

Write-Host "3-6. 服务器端操作..." -ForegroundColor Yellow
$RemoteScript = @"
set -e
mkdir -p $BackupDir
TIMESTAMP=\$(date +%Y%m%d-%H%M%S)

echo '备份当前代码和数据...'
CODE_BACKUP='$BackupDir/code-\$TIMESTAMP.tar.gz'
cd $ServerDir
tar zcvf \$CODE_BACKUP --exclude='node_modules' --exclude='*.tar.gz' . 2>/dev/null
echo "代码备份: \$CODE_BACKUP"

DATA_BACKUP='$BackupDir/data-\$TIMESTAMP.tar.gz'
if [ -d $DataDir ] && [ "\$(ls -A $DataDir 2>/dev/null)" ]; then
    tar zcvf \$DATA_BACKUP -C $DataDir . 2>/dev/null
    echo "数据备份: \$DATA_BACKUP"
fi

echo ''
echo '最近5个备份:'
ls -lt $BackupDir 2>/dev/null | head -6

echo '解压新代码...'
cd $ServerDir
tar zxvf $FileName --overwrite

echo '停止并重启容器...'
docker stop $ContainerName 2>/dev/null || true
docker rm $ContainerName 2>/dev/null || true

if [ '$Mode' = 'quick' ]; then
    echo '快速模式：使用已有镜像启动...'
    if ! docker images $ContainerName -q | grep -q .; then
        echo '错误: 没有找到镜像，请先运行完整模式'
        exit 1
    fi
    docker run -d --name $ContainerName --restart unless-stopped -p 8000:8000 \
        -v $ServerDir/dist:/app/dist:ro \
        -v $ServerDir/package.json:/app/package.json:ro \
        -v $ServerDir/configs:/app/configs:ro \
        -v $ServerDir/public:/app/public:ro \
        -v $DataDir:/app/tmp/pool-data \
        -e ADMIN_KEY=admin-secret-key \
        $ContainerName
else
    echo '完整模式：构建镜像并启动...'
    docker build -t $ContainerName .
    docker run -d --name $ContainerName --restart unless-stopped -p 8000:8000 \
        -v $DataDir:/app/tmp/pool-data \
        -e ADMIN_KEY=admin-secret-key \
        $ContainerName
fi

sleep 3
if docker ps -q -f name=$ContainerName | grep -q .; then
    echo '✓ 容器运行正常'
    docker exec $ContainerName ls -la /app/tmp/pool-data/ 2>/dev/null | head -6 || echo '  (空)'
else
    echo '✗ 容器启动失败'
    docker logs $ContainerName 2>&1 | tail -30
    exit 1
fi
"@

ssh -i $SshKey $ServerHost $RemoteScript

Write-Host "7. 查看实时日志 (按 Ctrl+C 退出)..." -ForegroundColor Yellow
ssh -i $SshKey $ServerHost "docker logs -f --tail=30 $ContainerName"

Remove-Item $FileName -ErrorAction SilentlyContinue
Write-Host "=== 发布完成 ===" -ForegroundColor Green
Write-Host ""
Write-Host "回滚方法:" -ForegroundColor Yellow
Write-Host "  ssh -i $SshKey $ServerHost"
Write-Host "  cd $ServerDir && ls -lt $BackupDir"
Write-Host "  # 恢复代码"
Write-Host "  rm -rf src dist && tar zxvf $BackupDir/code-xxx.tar.gz"
Write-Host "  docker restart $ContainerName"

pause
