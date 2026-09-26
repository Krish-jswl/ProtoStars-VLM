
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
        let profileImageCount = 0;
        let totalVisible = 0;

        for (const el of domElements) {
            if (!el.visible) continue;
            totalVisible++;
            if (el.text && el.text.length > 10) textBearingCount++;
            if (el.tag === 'canvas') canvasCount++;
            if (el.tag === 'img') {
                imgCount++;
                const identity = [el.id, el.name, el.ariaLabel, el.label, el.placeholder]
                    .filter(Boolean).join(' ').toLowerCase();
                const width = Number(el.bbox?.width) || 0;
                const height = Number(el.bbox?.height) || 0;
                const ratio = width && height ? width / height : 0;
                if (/avatar|profile|face|photo|pfp|profile[-_ ]?pic/.test(identity) ||
                    (width >= 24 && width <= 180 && height >= 24 && height <= 180 &&
                        ratio >= 0.72 && ratio <= 1.38)) {
                    profileImageCount++;
                }
            }
        }

        // Trigger OCR only when the observation contains a real image/canvas
        // signal. A page with many short controls but no image content should
        // stay on the cheap DOM path; otherwise normal task pages can be
        // needlessly sent through a heavyweight OCR worker.
        const textCoverage = totalVisible > 0 ? textBearingCount / totalVisible : 1;
        const imageRatio = totalVisible > 0 ? imgCount / totalVisible : 0;

        if (canvasCount > 0) {
            return {
                shouldRunOCR: true,
                reason: 'Canvas element detected — may contain text as pixels',
                estimatedValue: 'high',
                textCoverage,
                imageRatio
            };
        }

        if (profileImageCount > 0) {
            return {
                shouldRunOCR: true,
                reason: 'Profile/avatar image detected — nearby text may be rendered visually',
                estimatedValue: 'medium',
                textCoverage,
                imageRatio
            };
        }

        if (imgCount >= 3 && imageRatio >= 0.5) {
            return {
                shouldRunOCR: true,
                reason: 'Image-heavy page detected',
                estimatedValue: 'medium',
                textCoverage,
                imageRatio
            };
        }

        return {
            shouldRunOCR: false,
            reason: 'DOM text coverage sufficient or no image-heavy content',
            estimatedValue: 'low',
            textCoverage,
            imageRatio
        };
    }
}
