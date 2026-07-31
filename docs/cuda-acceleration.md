# 后处理模型 CUDA GPU 加速方案

## 架构

```
models/
├── asr/          # ASR 语音模型（HuggingFace 格式目录）
└── llm/          # 后处理 LLM 模型（GGUF 文件）
    └── Qwen3.5-4B-Q4_K_M.gguf  (2.6 GB)

app/
├── post_process_model.py  # 后处理核心：配置 + llama.cpp 加载 + 推理
├── models_registry.py     # list_llm_models() 扫描 models/llm/*.gguf
└── model.py               # transcribe() 末尾集成 LLM 后处理
```

## Provider 模式

| Provider | 引擎 | 说明 |
|----------|------|------|
| none | 透传 | 不启用 LLM 清理 |
| local | llama-cpp-python + GGUF | 本地 GPU 推理 |
| endpoint | OpenAI-compatible API | 云端模型 |

## 性能

| 场景 | CPU | CUDA GPU | 加速比 |
|------|-----|----------|--------|
| LLM 推理 | 17,000ms | 325ms | 52x |

## CUDA 编译

PyPI wheel 是 CPU-only。CUDA 加速必须从源码编译。

### 1. 创建 CUDA_HOME（从 pip 包）

```bash
CUDA_HOME=/tmp/pip-cuda
mkdir -p $CUDA_HOME/{bin,include,lib64}
ln -sf $(which nvcc) $CUDA_HOME/bin/nvcc

SITE=$(python -c "import site; print(site.getsitepackages()[0])")
for pkg in cublas cuda_runtime cuda_nvrtc cuda_cupti cu13; do
    [ -d "$SITE/nvidia/$pkg/include" ] && \
        ln -sf $SITE/nvidia/$pkg/include/*.h $CUDA_HOME/include/
done
find $SITE/nvidia -maxdepth 3 -name "lib*.so*" | while read lib; do
    ln -sf "$lib" $CUDA_HOME/lib64/
done
```

### 2. Patch Blackwell 驱动 Bug

RTX 5060 Ti 上 `cudaDeviceProp.sharedMemPerBlockOptin` 返回异常值，导致 SoftMax kernel 崩溃。

```bash
# 下载 + 解压源码
pip download llama-cpp-python --no-binary :all: --no-deps -d /tmp/src
tar xzf /tmp/src/llama_cpp_python-0.3.34.tar.gz -C /tmp/build/

# Patch
sed -i 's/info\.devices\[id\]\.smpbo = prop\.sharedMemPerBlockOptin;/\
info.devices[id].smpbo = (prop.sharedMemPerBlockOptin > 1024 * 1024) \
? prop.sharedMemPerBlock : prop.sharedMemPerBlockOptin;/' \
  /tmp/build/llama_cpp_python-0.3.34/vendor/llama.cpp/ggml/src/ggml-cuda/ggml-cuda.cu
```

### 3. 编译安装

```bash
CUDAToolkit_ROOT=$CUDA_HOME FORCE_CMAKE=1 \
  CMAKE_ARGS="-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120" \
  pip install /tmp/build/llama_cpp_python-0.3.34/ --force-reinstall
```

## 模型

从 HuggingFace 下载 unsloth 4-bit 量化 GGUF：

```bash
ALL_PROXY=http://127.0.0.1:7897 hf download unsloth/Qwen3.5-4B-GGUF \
  Qwen3.5-4B-Q4_K_M.gguf --local-dir models/llm/
```

不能用 Ollama 的 GGUF：Ollama 用极新版 llama.cpp 序列化，`qwen35.rope.dimension_sections` 数组长度 3，llama-cpp-python 0.3.34 内置引擎只认长度 4。

## 环境

| 项目 | 值 |
|------|-----|
| GPU | NVIDIA GeForce RTX 5060 Ti (Blackwell, CC 12.0, 16 GB) |
| CUDA | 12.8 (pip nvidia-cublas-cu12 + cuda-toolkit) |
| llama-cpp-python | 0.3.34 源码编译 + CUDA + Blackwell patch |
| 模型 | unsloth/Qwen3.5-4B-GGUF Q4_K_M |
| 合规 | 纯 pip + Miniforge，无商业授权依赖 |
