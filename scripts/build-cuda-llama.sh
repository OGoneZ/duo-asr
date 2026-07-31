#!/bin/bash
# 首次编译 CUDA 版 llama-cpp-python + 备份（只需运行一次）
set -e

CUDA_HOME=/tmp/pip-cuda
SRC_DIR=/tmp/llama-build/llama_cpp_python-0.3.34

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

if [ ! -f "$SRC_DIR/.patched" ]; then
    echo "=== Patching Blackwell driver bug ==="
    sed -i 's/info\.devices\[id\]\.smpbo = prop\.sharedMemPerBlockOptin;/info.devices[id].smpbo = (prop.sharedMemPerBlockOptin > 1024 * 1024) ? prop.sharedMemPerBlock : prop.sharedMemPerBlockOptin;/' \
        $SRC_DIR/vendor/llama.cpp/ggml/src/ggml-cuda/ggml-cuda.cu
    touch $SRC_DIR/.patched
fi

echo "=== 编译 llama-cpp-python CUDA 版 (约 5 分钟) ==="
export CUDAToolkit_ROOT=$CUDA_HOME
FORCE_CMAKE=1 CMAKE_ARGS="-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120" \
    pip install $SRC_DIR --force-reinstall --no-cache-dir

echo "=== 备份编译产物 ==="
mkdir -p /home/zhubaoduo/explore/asr-server/.cuda-libs
SYS=$(python -c "import site; print(site.getsitepackages()[0])")
rm -rf /home/zhubaoduo/explore/asr-server/.cuda-libs/llama_cpp
cp -r $SYS/llama_cpp /home/zhubaoduo/explore/asr-server/.cuda-libs/
cp -r $SYS/llama_cpp_python-* /home/zhubaoduo/explore/asr-server/.cuda-libs/

echo "=== 部署到 venv ==="
bash /home/zhubaoduo/explore/asr-server/scripts/rebuild-cuda-llama.sh
