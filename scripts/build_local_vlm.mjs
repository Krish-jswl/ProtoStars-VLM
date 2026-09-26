#!/usr/bin/env node
/**
 * Build the extension-local Transformers.js worker and copy the pinned
 * ONNX Runtime browser assets. Model weights are intentionally not downloaded
 * during a normal extension build or at runtime; they are verified in the
 * package directory and were fetched by the explicit asset-preparation step.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(root, 'extension');
const agentRoot = join(extensionRoot, 'local_agent');
const runtimeRoot = join(agentRoot, 'runtime', 'ort');
const modelRoot = join(agentRoot, 'models', 'HuggingFaceTB', 'SmolVLM-256M-Instruct');
const packageRoot = join(root, 'node_modules', '@huggingface', 'transformers');
const ortRoot = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const bundlePath = join(agentRoot, 'local_vlm_worker.bundle.js');
const manifestPath = join(agentRoot, 'models', 'model_manifest.json');

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch (_) {
        return false;
    }
}

async function sha256(path) {
    const hash = createHash('sha256');
    hash.update(await readFile(path));
    return hash.digest('hex');
}

async function copyRuntimeAssets() {
    await mkdir(runtimeRoot, { recursive: true });
    const files = [
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.wasm',
        'ort-wasm-simd-threaded.jsep.mjs',
        'ort-wasm-simd-threaded.jsep.wasm'
    ];
    for (const file of files) {
        const source = join(ortRoot, file);
        if (!(await exists(source))) {
            throw new Error(`Missing ONNX Runtime asset: ${source}. Run npm install first.`);
        }
        await cp(source, join(runtimeRoot, file));
    }
    for (const file of ['LICENSE', 'NOTICE']) {
        const source = join(ortRoot, '..', file);
        if (await exists(source)) await cp(source, join(runtimeRoot, `onnxruntime-${file.toLowerCase()}.txt`));
    }
}

async function verifyModelAssets() {
    if (!(await exists(manifestPath))) {
        throw new Error(`Missing ${manifestPath}. Prepare the pinned local model assets before building.`);
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.model !== 'HuggingFaceTB/SmolVLM-256M-Instruct') {
        throw new Error('Unexpected local model manifest');
    }
    for (const entry of manifest.files || []) {
        const path = join(agentRoot, 'models', entry.path);
        if (!(await exists(path))) {
            throw new Error(`Missing packaged local model asset: ${entry.path}`);
        }
        const size = (await stat(path)).size;
        if (entry.size !== size) throw new Error(`Size mismatch for ${entry.path}`);
        if (entry.sha256 && await sha256(path) !== entry.sha256) {
            throw new Error(`Checksum mismatch for ${entry.path}`);
        }
    }
    return manifest;
}

async function main() {
    if (!(await exists(packageRoot))) {
        throw new Error('Install @huggingface/transformers before building the local VLM worker.');
    }
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const ortPkg = JSON.parse(await readFile(join(root, 'node_modules', 'onnxruntime-web', 'package.json'), 'utf8'));
    const manifest = await verifyModelAssets();
    await mkdir(agentRoot, { recursive: true });
    await build({
        entryPoints: [join(agentRoot, 'local_vlm_worker.js')],
        outfile: bundlePath,
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['es2022'],
        legalComments: 'none',
        define: {
            'process.env.NODE_ENV': '"production"'
        },
        logLevel: 'warning'
    });
    await copyRuntimeAssets();
    const buildInfo = {
        transformers: pkg.version,
        onnxruntimeWeb: ortPkg.version,
        model: manifest.model,
        revision: manifest.revision,
        dtype: manifest.dtype,
        bundle: 'local_agent/local_vlm_worker.bundle.js',
        assets: 'local_agent/models/',
        wasm: 'local_agent/runtime/ort/'
    };
    await writeFile(join(agentRoot, 'BUILD_INFO.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
    process.stdout.write(`Built local VLM worker (${pkg.version}, ${ortPkg.version}).\n`);
}

main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
