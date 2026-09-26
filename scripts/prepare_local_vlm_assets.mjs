#!/usr/bin/env node
/**
 * Explicit, build-time-only asset preparation for the local VLM.
 * This script is never called by the extension at runtime. The extension sets
 * allowRemoteModels=false and loads only the files verified in model_manifest.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelId = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const revision = '7e3e67edbbed1bf9888184d9df282b700a323964';
const base = `https://huggingface.co/${modelId}/resolve/${revision}/`;
const modelRoot = join(root, 'extension', 'local_agent', 'models');
const files = [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'processor_config.json',
    'special_tokens_map.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'vocab.json',
    'merges.txt',
    'added_tokens.json',
    'chat_template.json',
    'onnx/decoder_model_merged_q4f16.onnx',
    'onnx/embed_tokens_q4f16.onnx',
    'onnx/vision_encoder_q4f16.onnx'
];

async function exists(path) {
    try { await stat(path); return true; } catch (_) { return false; }
}

async function download(relative) {
    const target = join(modelRoot, modelId, relative);
    await mkdir(dirname(target), { recursive: true });
    if (await exists(target)) await rm(target);
    process.stdout.write(`Downloading ${relative}\n`);
    const response = await fetch(base + relative, { headers: { 'User-Agent': 'privacy-vision-agent-local-vlm-builder' } });
    if (!response.ok) throw new Error(`Unable to download ${relative}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(target, bytes);
}

async function main() {
    const force = process.argv.includes('--force');
    for (const relative of files) {
        const target = join(modelRoot, modelId, relative);
        if (force || !(await exists(target))) await download(relative);
    }
    const entries = [];
    for (const relative of files) {
        const target = join(modelRoot, modelId, relative);
        const bytes = await readFile(target);
        entries.push({
            path: `${modelId}/${relative}`,
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex')
        });
    }
    const manifest = {
        model: modelId,
        revision,
        dtype: 'q4f16',
        parameterCount: 256000000,
        source: `https://huggingface.co/${modelId}`,
        files: entries,
        notice: 'The model is Apache-2.0 licensed. Runtime inference is local-only; no Hub request is made by the extension.'
    };
    await mkdir(modelRoot, { recursive: true });
    await writeFile(join(modelRoot, 'model_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`Prepared ${entries.length} local model files (${entries.reduce((sum, item) => sum + item.size, 0)} bytes).\n`);
}

main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
