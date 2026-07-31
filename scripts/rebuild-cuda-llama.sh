#!/bin/bash
# 快速恢复 CUDA 版 llama-cpp-python（从备份复制，<1 秒）
# 用法: uv sync 之后运行 bash scripts/rebuild-cuda-llama.sh
set -e

VENV=/home/zhubaoduo/explore/asr-server/.venv
BACKUP=/home/zhubaoduo/explore/asr-server/.cuda-libs

if [ ! -d "$BACKUP/llama_cpp/lib" ] || [ ! -f "$BACKUP/llama_cpp/lib/libggml-cuda.so" ]; then
    echo "ERROR: 没有 CUDA 备份。请先运行首次编译：bash scripts/build-cuda-llama.sh"
    exit 1
fi

rm -rf "$VENV/lib/python3.12/site-packages/llama_cpp"
rm -rf "$VENV/lib/python3.12/site-packages/llama_cpp_python-"*
cp -r "$BACKUP/llama_cpp" "$VENV/lib/python3.12/site-packages/"
cp -r "$BACKUP/llama_cpp_python-"* "$VENV/lib/python3.12/site-packages/" 2>/dev/null || true

CUDA=$(nm -D "$VENV/lib/python3.12/site-packages/llama_cpp/lib/libggml-cuda.so" 2>/dev/null | grep -c cublas)
echo "CUDA symbols: $CUDA $( [ "$CUDA" -gt 0 ] && echo '✓' || echo '✗ FAIL' )"
