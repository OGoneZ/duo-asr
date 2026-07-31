#!/bin/bash
# 一键编译 CUDA 版 llama-cpp-python 并部署到 venv
# 用法: bash scripts/rebuild-cuda-llama.sh
set -e

CUDA_HOME=/tmp/pip-cuda
SRC_DIR=/tmp/llama-build/llama_cpp_python-0.3.34
VENV=/home/zhubaoduo/explore/asr-server/.venv

# 1. 创建 CUDA_HOME（如果不存在）
if [ ! -f "$CUDA_HOME/bin/nvcc" ]; then
    echo "=== 创建 pip CUDA_HOME ==="
    mkdir -p $CUDA_HOME/{bin,include,lib64}
    ln -sf $(which nvcc) $CUDA_HOME/bin/nvcc
    SITE=$(python -c "import site; print(site.getsitepackages()[0])")
    for pkg in cublas cuda_runtime cuda_nvrtc cuda_cupti cu13; do
        [ -d "$SITE/nvidia/$pkg/include" ] && ln -sf $SITE/nvidia/$pkg/include/*.h $CUDA_HOME/include/
    done
    find $SITE/nvidia -maxdepth 3 -name "lib*.so*" | while read lib; do
        ln -sf "$lib" $CUDA_HOME/lib64/
    done
fi

# 2. Patch Blackwell 驱动 Bug（如果未 patch）
if [ ! -f "$SRC_DIR/.patched" ]; then
    echo "=== Patching Blackwell driver bug ==="
    sed -i 's/info\.devices\[id\]\.smpbo = prop\.sharedMemPerBlockOptin;/info.devices[id].smpbo = (prop.sharedMemPerBlockOptin > 1024 * 1024) ? prop.sharedMemPerBlock : prop.sharedMemPerBlockOptin;/' \
        $SRC_DIR/vendor/llama.cpp/ggml/src/ggml-cuda/ggml-cuda.cu
    touch $SRC_DIR/.patched
fi

# 3. 编译
echo "=== Building llama-cpp-python with CUDA ==="
export CUDAToolkit_ROOT=$CUDA_HOME
FORCE_CMAKE=1 CMAKE_ARGS="-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120" \
    pip install $SRC_DIR --force-reinstall --no-cache-dir

# 4. 部署到 venv
echo "=== Deploying to venv ==="
SYS=$(python -c "import site; print(site.getsitepackages()[0])")
rm -rf $VENV/lib/python3.12/site-packages/llama_cpp
rm -rf $VENV/lib/python3.12/site-packages/llama_cpp_python-*
cp -r $SYS/llama_cpp $VENV/lib/python3.12/site-packages/
cp -r $SYS/llama_cpp_python-* $VENV/lib/python3.12/site-packages/

# 5. 验证
echo "=== Verify ==="
CUDA_COUNT=$(nm -D $SYS/llama_cpp/lib/libggml-cuda.so 2>/dev/null | grep -c cublas)
if [ "$CUDA_COUNT" -gt 0 ]; then
    echo "OK: $CUDA_COUNT CUDA symbols in libggml-cuda.so"
else
    echo "FAIL: no CUDA symbols"
    exit 1
fi
