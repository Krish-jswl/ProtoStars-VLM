
export class PIIFusion {
    calculateIoU(box1, box2) {
        if (!box1 || !box2) return 0;
        const [x1, y1, w1, h1] = box1;
        const [x2, y2, w2, h2] = box2;

        const left = Math.max(x1, x2);
        const right = Math.min(x1 + w1, x2 + w2);
        const top = Math.max(y1, y2);
        const bottom = Math.min(y1 + h1, y2 + h2);

        if (left < right && top < bottom) {
            const intersection = (right - left) * (bottom - top);
            const union = (w1 * h1) + (w2 * h2) - intersection;
            return intersection / union;
        }
        return 0;
    }

    combineConfidence(c1, c2) {
        // Independent probability combination
        return 1 - ((1 - c1) * (1 - c2));
    }

    fuse(detections) {
        const fused = [];
        
        for (const det of detections) {
            let merged = false;
            
            // Try to merge with an existing detection
            for (const existing of fused) {
                // If same type and high overlap
                const iou = this.calculateIoU(
                    [det.bbox.x, det.bbox.y, det.bbox.width, det.bbox.height], 
                    [existing.bbox.x, existing.bbox.y, existing.bbox.width, existing.bbox.height]
                );
                
                // If IoU > 0.5 or exactly same Box
                if (existing.type === det.type && iou > 0.5) {
                    existing.sources = [...new Set([...existing.sources, ...det.sources])];
                    existing.confidence = this.combineConfidence(existing.confidence, det.confidence);
                    
                    // Prefer DOM bounding box if available, otherwise average them
                    if (det.sources.includes('DOM') && !existing.sources.includes('DOM')) {
                        existing.bbox = det.bbox; 
                    }
                    merged = true;
                    break;
                }
            }

            if (!merged) {
                // Add copy to avoid mutating original
                fused.push({
                    type: det.type,
                    bbox: { ...det.bbox },
                    confidence: det.confidence,
                    sources: [...det.sources]
                });
            }
        }

        // Cap confidence at 0.99
        fused.forEach(f => {
            f.confidence = Math.min(0.99, f.confidence);
        });

        return fused;
    }
}
