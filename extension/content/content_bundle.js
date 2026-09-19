(() => {
  // extension/content/dom_analyzer.js
  var DOMAnalyzer = class {
    isVisible(element) {
      if (!element || element.nodeType !== 1) return false;
      if (typeof element.checkVisibility === "function") {
        if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      if (rect.width === 0 || rect.height === 0) return false;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
      let parent = element.parentElement;
      while (parent && parent !== document.body) {
        const ps = window.getComputedStyle(parent);
        if (ps.overflow === "hidden" || ps.overflowY === "hidden") {
          const pr = parent.getBoundingClientRect();
          if (rect.bottom > pr.bottom + 2 || rect.top < pr.top - 2 || rect.right > pr.right + 2 || rect.left < pr.left - 2) {
            const visibleH = Math.min(rect.bottom, pr.bottom) - Math.max(rect.top, pr.top);
            const visibleW = Math.min(rect.right, pr.right) - Math.max(rect.left, pr.left);
            if (visibleH < 10 || visibleW < 10) return false;
          }
        }
        parent = parent.parentElement;
      }
      return true;
    }
    analyzeElement(element) {
      const rect = element.getBoundingClientRect();
      const tag = element.tagName.toLowerCase();
      let text = "";
      if (tag === "input" || tag === "textarea" || tag === "select") {
        text = (element.value || "").substring(0, 200).trim();
      } else {
        text = this._getDirectText(element).substring(0, 200);
      }
      return {
        id: element.id || "",
        role: element.getAttribute("role") || "",
        tag,
        text,
        bbox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        },
        visible: this.isVisible(element),
        enabled: !element.disabled,
        inputType: element.type || "",
        autocomplete: element.getAttribute("autocomplete") || ""
      };
    }
    analyzeDOM() {
      const results = [];
      const seen = /* @__PURE__ */ new Set();
      const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
      for (const el of document.querySelectorAll(interactiveSelectors)) {
        if (!this.isVisible(el)) continue;
        results.push(this.analyzeElement(el));
        seen.add(el);
      }
      const textSelectors = "p, span, div, strong, em, b, i, li, td, th, h1, h2, h3, h4, h5, h6, label, address, blockquote, pre, code, canvas, img";
      for (const el of document.querySelectorAll(textSelectors)) {
        if (seen.has(el)) continue;
        const tag = el.tagName.toLowerCase();
        if (tag !== "canvas" && tag !== "img") {
          const text = this._getDirectText(el);
          if (!text || text.length < 3) continue;
        }
        if (!this.isVisible(el)) continue;
        if (this._parentAlreadyCaptured(el, seen)) continue;
        results.push(this.analyzeElement(el));
        seen.add(el);
      }
      return results;
    }
    _getDirectText(element) {
      let text = "";
      for (const node of element.childNodes) {
        if (node.nodeType === 3) text += node.textContent;
      }
      return text.trim();
    }
    _parentAlreadyCaptured(element, seen) {
      let parent = element.parentElement;
      while (parent) {
        if (seen.has(parent)) return true;
        parent = parent.parentElement;
      }
      return false;
    }
  };

  // extension/content/action_executor.js
  var ActionExecutor = class {
    constructor(config) {
      this.config = config;
    }
    validateTarget(element) {
      if (!element) return { valid: false, reason: "Element not found" };
      const rect = element.getBoundingClientRect();
      if (this.config.actionValidation.requireVisible) {
        if (rect.width === 0 || rect.height === 0) return { valid: false, reason: "Element not visible (zero size)" };
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return { valid: false, reason: "Element not visible (styled)" };
      }
      if (element.disabled) return { valid: false, reason: "Element disabled" };
      return { valid: true };
    }
    execute(actionType, targetSelector, args = {}) {
      if (!this.config.actionValidation.allowedActions.includes(actionType)) {
        return { success: false, error: `Action ${actionType} not allowed` };
      }
      let element;
      try {
        element = document.querySelector(targetSelector);
      } catch (e) {
        return { success: false, error: `Invalid selector` };
      }
      const validation = this.validateTarget(element);
      if (!validation.valid) {
        return { success: false, error: validation.reason };
      }
      try {
        switch (actionType) {
          case "click":
            element.click();
            break;
          case "focus":
            element.focus();
            break;
          case "scroll":
            element.scrollBy({
              top: args.y || 0,
              left: args.x || 0,
              behavior: "smooth"
            });
            break;
          default:
            return { success: false, error: `Unknown action` };
        }
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
  };

  // extension/privacy/pii_detector.js
  var PIIDetector = class {
    constructor() {
      this.regexes = {
        EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        PHONE: /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/g,
        CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/g,
        AUTH_TOKEN: /\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]*|ghp_[a-zA-Z0-9]{36}|sk-[a-zA-Z0-9]{20,})\b/g
      };
    }
    /** Luhn check for credit card validation to reduce FP */
    _luhnCheck(numStr) {
      const digits = numStr.replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19) return false;
      let sum = 0;
      let alt = false;
      for (let i = digits.length - 1; i >= 0; i--) {
        let n = parseInt(digits[i], 10);
        if (alt) {
          n *= 2;
          if (n > 9) n -= 9;
        }
        sum += n;
        alt = !alt;
      }
      return sum % 10 === 0;
    }
    extractRegex(text, bbox, source) {
      const detections = [];
      for (const [type, regex] of Object.entries(this.regexes)) {
        regex.lastIndex = 0;
        let match;
        let safetyCount = 0;
        while ((match = regex.exec(text)) !== null && safetyCount < 50) {
          safetyCount++;
          if (type === "CREDIT_CARD") {
            if (!this._luhnCheck(match[0])) continue;
          }
          if (type === "PHONE") {
            const digitCount = match[0].replace(/\D/g, "").length;
            if (digitCount < 7) continue;
          }
          detections.push({ type, bbox, confidence: 0.75, sources: [source] });
        }
      }
      return detections;
    }
    detectDOM(element) {
      const detections = [];
      const bbox = element.bbox;
      const isInput = element.tag === "input" || element.tag === "textarea" || element.tag === "select";
      if (element.inputType === "password" && element.text) {
        detections.push({ type: "PASSWORD", bbox, confidence: 1, sources: ["DOM"] });
      }
      const ac = (element.autocomplete || "").toLowerCase();
      if ((ac === "email" || ac === "username") && element.text) {
        detections.push({ type: "EMAIL", bbox, confidence: 0.95, sources: ["DOM"] });
      }
      if (ac === "tel" || ac === "tel-national") {
        detections.push({ type: "PHONE", bbox, confidence: 0.95, sources: ["DOM"] });
      }
      if (ac === "cc-number" || ac === "cc-csc" || ac === "cc-exp") {
        detections.push({ type: "CREDIT_CARD", bbox, confidence: 0.95, sources: ["DOM"] });
      }
      if (ac === "name" || ac === "given-name" || ac === "family-name") {
        detections.push({ type: "PERSON", bbox, confidence: 0.9, sources: ["DOM"] });
      }
      if (ac === "street-address" || ac === "address-line1" || ac === "postal-code") {
        detections.push({ type: "ADDRESS", bbox, confidence: 0.9, sources: ["DOM"] });
      }
      if (isInput) {
        const idLower = (element.id || "").toLowerCase();
        if (idLower.includes("email") && !ac) {
          detections.push({ type: "EMAIL", bbox, confidence: 0.8, sources: ["DOM"] });
        }
        if ((idLower.includes("card") || idLower.includes("cc-")) && !ac) {
          detections.push({ type: "CREDIT_CARD", bbox, confidence: 0.8, sources: ["DOM"] });
        }
        if (idLower.includes("address") && !ac) {
          detections.push({ type: "ADDRESS", bbox, confidence: 0.8, sources: ["DOM"] });
        }
        if (idLower.includes("avatar") || idLower.includes("profile-pic")) {
          detections.push({ type: "FACE", bbox, confidence: 0.8, sources: ["DOM"] });
        }
      }
      const skipTagsForRegex = /* @__PURE__ */ new Set(["button", "a", "label", "h1", "h2", "h3", "h4", "h5", "h6"]);
      if (element.text && !skipTagsForRegex.has(element.tag)) {
        detections.push(...this.extractRegex(element.text, bbox, "DOM_REGEX"));
      }
      return detections;
    }
    detectOCR(ocrResult) {
      return this.extractRegex(ocrResult.text, ocrResult.bbox, "OCR");
    }
    detectAll(domElements, ocrResults) {
      let allDetections = [];
      for (const el of domElements) {
        allDetections.push(...this.detectDOM(el));
      }
      for (const ocr of ocrResults) {
        allDetections.push(...this.detectOCR(ocr));
      }
      return allDetections;
    }
  };

  // extension/privacy/pii_fusion.js
  var PIIFusion = class {
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
        const union = w1 * h1 + w2 * h2 - intersection;
        return intersection / union;
      }
      return 0;
    }
    combineConfidence(c1, c2) {
      return 1 - (1 - c1) * (1 - c2);
    }
    fuse(detections) {
      const fused = [];
      for (const det of detections) {
        let merged = false;
        for (const existing of fused) {
          const iou = this.calculateIoU(
            [det.bbox.x, det.bbox.y, det.bbox.width, det.bbox.height],
            [existing.bbox.x, existing.bbox.y, existing.bbox.width, existing.bbox.height]
          );
          if (existing.type === det.type && iou > 0.5) {
            existing.sources = [.../* @__PURE__ */ new Set([...existing.sources, ...det.sources])];
            existing.confidence = this.combineConfidence(existing.confidence, det.confidence);
            if (det.sources.includes("DOM") && !existing.sources.includes("DOM")) {
              existing.bbox = det.bbox;
            }
            merged = true;
            break;
          }
        }
        if (!merged) {
          fused.push({
            type: det.type,
            bbox: { ...det.bbox },
            confidence: det.confidence,
            sources: [...det.sources]
          });
        }
      }
      fused.forEach((f) => {
        f.confidence = Math.min(0.99, f.confidence);
      });
      return fused;
    }
  };

  // extension/privacy/redactor.js
  var Redactor = class {
    constructor() {
      this.REDACTION_COLOR = "#000000";
    }
    calculateOverlap(box1, box2) {
      if (!box1 || !box2) return 0;
      const left = Math.max(box1.x, box2.x);
      const right = Math.min(box1.x + box1.width, box2.x + box2.width);
      const top = Math.max(box1.y, box2.y);
      const bottom = Math.min(box1.y + box1.height, box2.y + box2.height);
      if (left < right && top < bottom) {
        return (right - left) * (bottom - top);
      }
      return 0;
    }
    planRedaction(piiDetections) {
      const counters = {};
      const planned = [];
      for (const det of piiDetections) {
        if (!counters[det.type]) counters[det.type] = 1;
        const token = `[${det.type}_${counters[det.type]}]`;
        counters[det.type]++;
        planned.push({
          ...det,
          token
        });
      }
      return planned;
    }
    sanitizeDOM(rawDomElements, plannedRedactions) {
      const sanitized = JSON.parse(JSON.stringify(rawDomElements));
      for (const el of sanitized) {
        let highestOverlap = 0;
        let bestToken = null;
        for (const plan of plannedRedactions) {
          const overlap = this.calculateOverlap(el.bbox, plan.bbox);
          if (overlap > highestOverlap) {
            highestOverlap = overlap;
            bestToken = plan.token;
          }
        }
        if (bestToken || el.inputType === "password") {
          el.text = bestToken || "[PASSWORD_1]";
          if (el.value) el.value = bestToken || "[PASSWORD_1]";
        }
      }
      return sanitized;
    }
    async redactImage(rawCanvas, plannedRedactions, scaleX = 1, scaleY = 1) {
      const redactedCanvas = document.createElement("canvas");
      redactedCanvas.width = rawCanvas.width;
      redactedCanvas.height = rawCanvas.height;
      const ctx = redactedCanvas.getContext("2d");
      ctx.drawImage(rawCanvas, 0, 0);
      ctx.fillStyle = this.REDACTION_COLOR;
      for (const plan of plannedRedactions) {
        const { x, y, width, height } = plan.bbox;
        ctx.fillRect(
          Math.floor(x * scaleX),
          Math.floor(y * scaleY),
          Math.ceil(width * scaleX),
          Math.ceil(height * scaleY)
        );
      }
      return redactedCanvas;
    }
  };

  // extension/privacy/privacy_gate.js
  var PrivacyGate = class {
    constructor() {
      this.KNOWN_TYPES = /* @__PURE__ */ new Set([
        "EMAIL",
        "PHONE",
        "PERSON",
        "ADDRESS",
        "CREDIT_CARD",
        "PASSWORD",
        "AUTH_TOKEN",
        "FACE"
      ]);
    }
    verifyDOM(rawDom, sanitizedDom, plannedRedactions) {
      for (let i = 0; i < rawDom.length; i++) {
        const raw = rawDom[i];
        const san = sanitizedDom[i];
        if (san.text && san.text.startsWith("[") && san.text.endsWith("]")) {
          if (raw.text && raw.text.length > 3 && san.text === raw.text) {
            throw new Error(`Sanitized text matches raw text for element ${raw.id || raw.tag}`);
          }
        }
        if (san.inputType === "password") {
          if (san.text !== "[PASSWORD_1]" && !san.text.startsWith("[PASSWORD")) {
            throw new Error("Password field not properly sanitized");
          }
        }
      }
      return true;
    }
    verifyImage(redactedCanvas, plannedRedactions, scaleX = 1, scaleY = 1) {
      if (!redactedCanvas) throw new Error("Missing redacted canvas");
      const ctx = redactedCanvas.getContext("2d");
      const imgData = ctx.getImageData(0, 0, redactedCanvas.width, redactedCanvas.height).data;
      for (const plan of plannedRedactions) {
        const cx = Math.floor((plan.bbox.x + plan.bbox.width / 2) * scaleX);
        const cy = Math.floor((plan.bbox.y + plan.bbox.height / 2) * scaleY);
        if (cx >= 0 && cx < redactedCanvas.width && cy >= 0 && cy < redactedCanvas.height) {
          const idx = (cy * redactedCanvas.width + cx) * 4;
          const r = imgData[idx];
          const g = imgData[idx + 1];
          const b = imgData[idx + 2];
          if (r !== 0 || g !== 0 || b !== 0) {
            throw new Error(`Incomplete visual redaction at (${cx}, ${cy}) for ${plan.type}`);
          }
        } else {
          throw new Error("Coordinate mismatch, out of bounds");
        }
      }
      return true;
    }
    verify(rawContext, sanitizedContext, plannedRedactions) {
      const violations = [];
      try {
        for (const plan of plannedRedactions) {
          if (!this.KNOWN_TYPES.has(plan.type)) {
            throw new Error(`Unknown/unhandled sensitive detection: ${plan.type}`);
          }
        }
        this.verifyDOM(rawContext.dom, sanitizedContext.dom, plannedRedactions);
        this.verifyImage(sanitizedContext.image, plannedRedactions, rawContext.scaleX, rawContext.scaleY);
      } catch (e) {
        violations.push(e.message);
      }
      return {
        allowed: violations.length === 0,
        violations
      };
    }
  };

  // extension/privacy/secret_provider.js
  var ALLOWED_REFS = /* @__PURE__ */ new Set(["email", "phone", "username", "password"]);
  var REF_VALID_INPUTS = {
    email: /* @__PURE__ */ new Set(["email", "text"]),
    phone: /* @__PURE__ */ new Set(["tel", "text"]),
    username: /* @__PURE__ */ new Set(["text", "email"]),
    password: /* @__PURE__ */ new Set(["password"])
  };
  var LocalSecretProvider = class {
    constructor() {
      this._secrets = /* @__PURE__ */ new Map();
    }
    /** Set a secret for development/testing. */
    set(secretRef, value) {
      if (!ALLOWED_REFS.has(secretRef)) {
        throw new Error(`Unknown secret ref: ${secretRef}`);
      }
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("Secret value must be a non-empty string");
      }
      this._secrets.set(secretRef, value);
    }
    /** Check if a secret ref exists. */
    has(secretRef) {
      return this._secrets.has(secretRef);
    }
    /** Get a secret value. NEVER log the return value. */
    get(secretRef) {
      if (!ALLOWED_REFS.has(secretRef)) {
        return null;
      }
      return this._secrets.get(secretRef) || null;
    }
    /** List available refs (names only, never values). */
    listAvailableRefs() {
      return [...this._secrets.keys()];
    }
    /** Clear all secrets from memory. */
    clear() {
      this._secrets.clear();
    }
    /** Validate that a target element is compatible with a secret ref. */
    static validateTarget(element, secretRef) {
      if (!element) return { valid: false, reason: "Element not found" };
      const tag = element.tagName?.toLowerCase();
      if (tag !== "input" && tag !== "textarea") {
        return { valid: false, reason: "Target must be input or textarea" };
      }
      if (element.disabled) {
        return { valid: false, reason: "Target is disabled" };
      }
      if (element.readOnly) {
        return { valid: false, reason: "Target is read-only" };
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return { valid: false, reason: "Target is not visible (zero size)" };
      }
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return { valid: false, reason: "Target is not visible (styled)" };
      }
      const inputType = (element.type || "text").toLowerCase();
      const allowed = REF_VALID_INPUTS[secretRef];
      if (allowed && !allowed.has(inputType)) {
        return { valid: false, reason: `Input type "${inputType}" incompatible with secret ref "${secretRef}"` };
      }
      return { valid: true };
    }
    /** Insert a secret into a target element with proper DOM events. */
    static insertSecret(element, value) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(element, value);
      } else {
        element.value = value;
      }
      const EventCtor = element.ownerDocument?.defaultView?.Event || Event;
      element.dispatchEvent(new EventCtor("input", { bubbles: true }));
      element.dispatchEvent(new EventCtor("change", { bubbles: true }));
    }
  };

  // extension/shared/logger.js
  var Logger = class {
    constructor(module) {
      this.module = module;
    }
    info(msg, data = {}) {
      console.log(`[INFO][${this.module}] ${msg}`, data);
    }
    warn(msg, data = {}) {
      console.warn(`[WARN][${this.module}] ${msg}`, data);
    }
    error(msg, data = {}) {
      console.error(`[ERROR][${this.module}] ${msg}`, data);
    }
  };

  // extension/shared/config.js
  var Config = {
    agentEnabled: true,
    logLevel: "info",
    backendUrl: "http://localhost:8000",
    actionValidation: {
      requireVisible: true,
      allowedActions: ["click", "scroll", "focus", "select", "wait", "type_local"]
    }
  };

  // extension/content/privacy_pipeline_runner.js
  var logger = new Logger("PrivacyPipelineRunner");
  var PrivacyPipelineRunner = class {
    constructor() {
      this.analyzer = new DOMAnalyzer();
      this.executor = new ActionExecutor(Config);
      this.detector = new PIIDetector();
      this.fusion = new PIIFusion();
      this.redactor = new Redactor();
      this.gate = new PrivacyGate();
      this.secretProvider = new LocalSecretProvider();
    }
    async run() {
      const timing = {};
      const t0 = performance.now();
      let t = performance.now();
      const domElements = this.analyzer.analyzeDOM();
      timing.dom = performance.now() - t;
      t = performance.now();
      const dataUri = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "CAPTURE_TAB" }, (res) => {
          if (res?.dataUri) resolve(res.dataUri);
          else reject(new Error("Capture failed"));
        });
      });
      timing.screenshot = performance.now() - t;
      t = performance.now();
      const processedCanvas = await this._preprocessImage(dataUri);
      timing.preprocess = performance.now() - t;
      const ocrResults = [];
      timing.ocr = 0;
      t = performance.now();
      const rawDetections = this.detector.detectAll(domElements, ocrResults);
      const fusedDetections = this.fusion.fuse(rawDetections);
      timing.pii = performance.now() - t;
      t = performance.now();
      const plan = this.redactor.planRedaction(fusedDetections);
      timing.plan = performance.now() - t;
      const scaleX = processedCanvas.width / window.innerWidth;
      const scaleY = processedCanvas.height / window.innerHeight;
      t = performance.now();
      const redactedCanvas = await this.redactor.redactImage(processedCanvas, plan, scaleX, scaleY);
      timing.redact = performance.now() - t;
      const sanitizedDom = this.redactor.sanitizeDOM(domElements, plan);
      const rawContext = { dom: domElements, scaleX, scaleY };
      const sanitizedContext = { dom: sanitizedDom, image: redactedCanvas };
      t = performance.now();
      const gateResult = this.gate.verify(rawContext, sanitizedContext, plan);
      timing.gate = performance.now() - t;
      timing.total = performance.now() - t0;
      if (!gateResult.allowed) {
        logger.warn("Privacy gate blocked", { violations: gateResult.violations });
        return { allowed: false, violations: gateResult.violations, timing };
      }
      const sanitizedPayload = {
        page: {
          url: window.location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight }
        },
        dom: sanitizedDom.map((el) => ({
          id: el.id || "",
          tag: el.tag || "",
          role: el.role || "",
          text: el.text || "",
          inputType: el.inputType || "",
          bbox: el.bbox || { x: 0, y: 0, width: 1, height: 1 },
          visible: !!el.visible,
          enabled: !!el.enabled
        })),
        image: redactedCanvas.toDataURL("image/jpeg", 0.8)
      };
      logger.info("Privacy pipeline passed", { timing });
      return { allowed: true, sanitizedContext: sanitizedPayload, timing };
    }
    async executeValidatedAction(action) {
      const ALLOWED = /* @__PURE__ */ new Set(["click", "scroll", "focus", "select", "wait", "type_local"]);
      if (!ALLOWED.has(action.type)) {
        return { success: false, error: "Action type not allowed" };
      }
      if (action.type === "wait") {
        const ms = Math.min(action.args?.ms || 500, 5e3);
        await new Promise((r) => setTimeout(r, ms));
        return { success: true };
      }
      if (action.type === "type_local") {
        return this._executeTypeLocal(action);
      }
      const selector = action.target ? `#${action.target}` : null;
      if (!selector) return { success: false, error: "No target specified" };
      return this.executor.execute(action.type, selector, action.args || {});
    }
    _executeTypeLocal(action) {
      const secretRef = action.args?.secret_ref;
      if (!secretRef) {
        return { success: false, error: "Missing secret_ref" };
      }
      if (!this.secretProvider.has(secretRef)) {
        return { success: false, error: "Secret not available" };
      }
      const selector = action.target ? `#${action.target}` : null;
      if (!selector) return { success: false, error: "No target specified" };
      let element;
      try {
        element = document.querySelector(selector);
      } catch (e) {
        return { success: false, error: "Invalid selector" };
      }
      const validation = LocalSecretProvider.validateTarget(element, secretRef);
      if (!validation.valid) {
        return { success: false, error: validation.reason };
      }
      const value = this.secretProvider.get(secretRef);
      if (!value) return { success: false, error: "Secret not available" };
      LocalSecretProvider.insertSecret(element, value);
      return { success: true };
    }
    async _preprocessImage(dataUri) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const MAX_WIDTH = 1920;
          let w = img.width, h = img.height;
          if (w > MAX_WIDTH) {
            h = Math.floor(h * MAX_WIDTH / w);
            w = MAX_WIDTH;
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas);
        };
        img.src = dataUri;
      });
    }
  };

  // extension/content/content_main.js
  var logger2 = new Logger("ContentScript");
  var analyzer = new DOMAnalyzer();
  var executor = new ActionExecutor(Config);
  var pipeline = new PrivacyPipelineRunner();
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "ANALYZE_DOM") {
      logger2.info("Analyzing DOM");
      sendResponse({ elements: analyzer.analyzeDOM() });
    }
    if (request.type === "EXECUTE_ACTION") {
      logger2.info("Executing action", { type: request.actionType });
      sendResponse(executor.execute(request.actionType, request.selector, request.args));
    }
    if (request.type === "PRIVACY_PIPELINE") {
      pipeline.run().then(sendResponse);
      return true;
    }
    if (request.type === "EXECUTE_VALIDATED_ACTION") {
      pipeline.executeValidatedAction(request.action).then(sendResponse);
      return true;
    }
    return true;
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === "AGENT_TEST_TRIGGER") {
      chrome.runtime.sendMessage({ type: "START_AGENT" });
    }
  });
})();
