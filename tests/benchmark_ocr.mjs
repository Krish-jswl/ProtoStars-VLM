import Tesseract from 'tesseract.js';

async function run() {
    const startInit = performance.now();
    const worker = await Tesseract.createWorker('eng', 1, {
        logger: m => {}
    });
    const initTime = performance.now() - startInit;
    console.log(`Init time: ${Math.round(initTime)} ms`);
    
    const tinyBase64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
    
    const startInfer = performance.now();
    await worker.recognize(tinyBase64);
    const inferTime = performance.now() - startInfer;
    console.log(`Inference time: ${Math.round(inferTime)} ms`);
    
    const memory = process.memoryUsage();
    console.log(`Memory Usage: ${Math.round(memory.heapUsed / 1024 / 1024)} MB`);
    
    await worker.terminate();
}

run().catch(console.error);
