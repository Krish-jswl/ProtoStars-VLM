export class FaceDetectorService {
    constructor() {
        this.nativeDetector = null;
        if ("FaceDetector" in window) {
            try {
                this.nativeDetector = new window.FaceDetector();
            } catch(e) {
                console.warn("FaceDetector supported but failed to initialize", e);
            }
        }
    }

    async detectFaces(imageCanvas, scaleX = 1.0, scaleY = 1.0) {
        const detections = [];
        if (this.nativeDetector) {
            try {
                const faces = await this.nativeDetector.detect(imageCanvas);
                for (const face of faces) {
                    const rect = face.boundingBox;
                    detections.push({
                        type: "FACE",
                        bbox: {
                            // Convert physical pixels back to CSS pixels for consistency
                            x: rect.x / scaleX,
                            y: rect.y / scaleY,
                            width: rect.width / scaleX,
                            height: rect.height / scaleY
                        },
                        confidence: 0.9,
                        sources: ["SHAPE_DETECTION"]
                    });
                }
            } catch(e) {
                console.warn("Native face detection failed", e);
            }
        } else {
            // Fallback to face-api.js would go here
            console.log("No native FaceDetector found. Needs face-api fallback.");
        }
        return detections;
    }
}
