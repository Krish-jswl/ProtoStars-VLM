
/**
 * Lightweight OCR trigger policy.
 * Decides whether OCR should run based on DOM coverage signals.
 * Does NOT execute OCR itself.
 */
export class OCRTriggerPolicy {
    evaluate(domElements) {
        let textBearingCount = 0;
        let canvasCount = 0;
        let imgCount = 0;
        let totalVisible = 0;

        for (const el of domElements) {
            if (!el.visible) continue;
            totalVisible++;
            if (el.text && el.text.length > 10) textBearingCount++;
            if (el.tag === 'canvas') canvasCount++;
            if (el.tag === 'img') imgCount++;
        }

        // Trigger OCR when visible elements exist but few carry text
        const textCoverage = totalVisible > 0 ? textBearingCount / totalVisible : 1;

        if (canvasCount > 0) {
            return { shouldRunOCR: true, reason: 'Canvas element detected — may contain text as pixels', estimatedValue: 'high' };
        }

        if (imgCount > 3 && textCoverage < 0.3) {
            return { shouldRunOCR: true, reason: 'Many images with low DOM text coverage', estimatedValue: 'medium' };
        }

        if (textCoverage < 0.2 && totalVisible > 5) {
            return { shouldRunOCR: true, reason: 'Low DOM text coverage on content-rich page', estimatedValue: 'medium' };
        }

        return { shouldRunOCR: false, reason: 'DOM text coverage sufficient', estimatedValue: 'low' };
    }
}
