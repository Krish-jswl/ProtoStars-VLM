
export class OCRProvider {
    /**
     * Initializes the OCR model (e.g. loading workers, compiling WASM)
     */
    async initialize() {
        throw new Error("Not implemented");
    }

    /**
     * @param {ImageData | HTMLCanvasElement} image 
     * @returns {Promise<Array<{text: string, bbox: number[], confidence: number, source: string}>>}
     */
    async recognize(image) {
        throw new Error("Not implemented");
    }

    /**
     * Cleans up resources
     */
    async dispose() {
        throw new Error("Not implemented");
    }
}
