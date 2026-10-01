"""把 DeepSeek Harness 桌面端自带的运行时依赖（@deepseek-ai/*、cordis 等）解到本项目的 node_modules。

仅用于开发测试：让 `npm test` 能对着真实的 dsh-llm / dsh-session-title / cordis 运行插件，
而不是只测假对象。安装插件本身不需要它。

用法：
    python scripts/extract-runtime.py "D:\\DeepSeek Harness"
"""
import json
import os
import struct
import sys

# 体积大且与标题功能无关的依赖不解出。
SKIP = (
    'libreoffice', '/aws-sdk', '/@aws', '/@smithy', '/@anthropic-ai', '/openai/', '/@opentelemetry',
    'google-auth', 'fontkit', '/undici', 'dsh-web-frontend', 'dsh-otel', '/@babel', '/@swc', '/pi-ai', '/@earendil',
)


def walk(node, path=''):
    for name, value in node.get('files', {}).items():
        full = f'{path}/{name}'
        if 'files' in value:
            yield from walk(value, full)
        else:
            yield full, value


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    asar = os.path.join(sys.argv[1], 'resources', 'app.asar')
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'node_modules')
    with open(asar, 'rb') as f:
        f.read(12)
        header_len = struct.unpack('<I', f.read(4))[0]
        header = json.loads(f.read(header_len))
        base = 16 + header_len
        count = 0
        for path, meta in walk(header):
            if not path.startswith('/dsh/node_modules/') or meta.get('unpacked'):
                continue
            if any(s in path for s in SKIP) or path.endswith(('.map', '.md', '.d.ts')):
                continue
            f.seek(base + int(meta['offset']))
            data = f.read(meta['size'])
            target = os.path.join(out, path[len('/dsh/node_modules/'):])
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'wb') as w:
                w.write(data)
            count += 1
    print(f'已解出 {count} 个文件到 {out}')


if __name__ == '__main__':
    main()
