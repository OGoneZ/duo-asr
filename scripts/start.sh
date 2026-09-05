#!/bin/bash
# 一键启动：同步依赖 → 恢复 CUDA 版 llama-cpp-python → 后台启动服务。
# uv sync 会用 PyPI 的 CPU wheel 覆盖 CUDA 编译的 llama-cpp-python，
# 导致 LLM 后处理掉回 CPU（单次转写 0.5s → 18s），所以必须紧跟 restore。
# 用法: bash scripts/start.sh
set -e

cd "$(dirname "$0")/.."

echo "=== uv sync ==="
uv sync

echo "=== 恢复 CUDA 版 llama-cpp-python ==="
bash scripts/rebuild-cuda-llama.sh

export MLX_CUDA_CONV_CACHE_SIZE=${MLX_CUDA_CONV_CACHE_SIZE:-4096}
export MLX_CUDA_GRAPH_CACHE_SIZE=${MLX_CUDA_GRAPH_CACHE_SIZE:-4096}
export MLX_CUDA_SDPA_CACHE_SIZE=${MLX_CUDA_SDPA_CACHE_SIZE:-1024}
export MLX_CUDA_FFT_CACHE_SIZE=${MLX_CUDA_FFT_CACHE_SIZE:-1024}
# MLX 的 thrashing 检测在长跑服务上会把本可降速完成的请求直接抛异常打回 500，
# 关掉它；缓存已调大，真实 thrashing 概率本身很低。
export MLX_ENABLE_CACHE_THRASHING_CHECK=${MLX_ENABLE_CACHE_THRASHING_CHECK:-0}

echo "=== 启动服务 (nohup, 日志 logs/stdout.log) ==="
nohup .venv/bin/python main.py >> logs/stdout.log 2>&1 &
echo "已启动, pid $!"
