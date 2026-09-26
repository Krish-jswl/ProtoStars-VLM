(() => {
  // extension/content/dom_analyzer.js
  var DOMAnalyzer = class {
    constructor() {
      this._generatedIds = /* @__PURE__ */ new WeakMap();
      this._nativeIds = /* @__PURE__ */ new WeakMap();
      this._seenNativeIds = /* @__PURE__ */ new Set();
      this._fingerprintIds = /* @__PURE__ */ new Map();
      this._idCounter = 0;
    }
    isVisible(element) {
      if (!element || element.nodeType !== 1) return false;
      if (typeof element.checkVisibility === "function") {
        if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      if (rect.width === 0 || rect.height === 0) return false;
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
      this._ensureStableId(element);
      const rect = element.getBoundingClientRect();
      const tag = element.tagName.toLowerCase();
      const isContentEditable = this._isContentEditable(element);
      let text2 = "";
      if (tag === "input" || tag === "textarea" || tag === "select") {
        text2 = (element.value || "").substring(0, 200).trim();
      } else if (isContentEditable) {
        text2 = (element.innerText || element.textContent || "").substring(0, 200).trim();
      } else {
        text2 = this._getDirectText(element).substring(0, 200);
        if (!text2 && ["button", "a", "summary", "label"].includes(tag)) {
          text2 = String(element.innerText || element.textContent || "").trim().substring(0, 200);
          if (!text2) {
            text2 = String(element.querySelector?.("img[alt]")?.getAttribute("alt") || "").trim().substring(0, 200);
          }
        }
      }
      return {
        id: element.id || "",
        role: element.getAttribute("role") || this._implicitRole(element, tag),
        tag,
        text: text2,
        bbox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        },
        visible: this.isVisible(element),
        enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true",
        readOnly: !!element.readOnly || element.getAttribute("aria-readonly") === "true",
        inputType: isContentEditable ? "contenteditable" : element.type || "",
        autocomplete: element.getAttribute("autocomplete") || "",
        // Safe semantic labels give the planner enough information to find
        // controls on pages whose visible text is only in a placeholder or
        // accessibility label.  Values are never included here.
        placeholder: element.getAttribute("placeholder") || element.getAttribute("data-placeholder") || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        name: element.getAttribute("name") || "",
        title: element.getAttribute("title") || "",
        testId: element.getAttribute("data-testid") || element.getAttribute("data-test-id") || element.getAttribute("data-qa") || "",
        label: this._getLabel(element),
        ariaExpanded: this._ariaState(element, "aria-expanded", ["true", "false", "undefined"]),
        ariaSelected: this._ariaState(element, "aria-selected", ["true", "false"]),
        ariaChecked: this._ariaState(element, "aria-checked", ["true", "false", "mixed"]),
        ariaCurrent: this._ariaState(element, "aria-current", ["page", "step", "location", "date", "time", "true", "false"]),
        ariaPressed: this._ariaState(element, "aria-pressed", ["true", "false", "mixed"]),
        ariaHasPopup: this._ariaState(element, "aria-haspopup", ["false", "true", "menu", "listbox", "tree", "grid", "dialog"]),
        // tabIndex is included so that grounding can recognise elements
        // that are keyboard-focusable but carry no explicit ARIA role.
        tabIndex: typeof element.tabIndex === "number" ? element.tabIndex : -1,
        options: tag === "select" ? Array.from(element.options || []).slice(0, 100).map(
          (option) => (option.textContent || "").trim().substring(0, 200)
        ) : []
      };
    }
    analyzeDOM() {
      const results = [];
      const seen = /* @__PURE__ */ new Set();
      const interactiveSelectors = 'button, a, input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="radio"], [role="option"], [role="treeitem"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], [tabindex]:not([tabindex="-1"])';
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
          const text2 = this._getDirectText(el);
          if (!text2 || text2.length < 3) continue;
        }
        if (!this.isVisible(el)) continue;
        if (this._parentAlreadyCaptured(el, seen)) continue;
        results.push(this.analyzeElement(el));
        seen.add(el);
      }
      return results;
    }
    _ariaState(element, attribute, allowed) {
      const value = String(element.getAttribute?.(attribute) || "").trim().toLowerCase();
      return allowed.includes(value) ? value : "";
    }
    _implicitRole(element, tag) {
      if (tag === "button") return "button";
      if (tag === "a" && (element.getAttribute("href") !== null || element.hasAttribute("tabindex"))) return "link";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "input") {
        const type = String(element.type || "text").toLowerCase();
        if (["button", "submit", "reset"].includes(type)) return "button";
        if (["checkbox", "radio"].includes(type)) return type;
        if (["email", "tel", "url", "search", "text", "password", "number"].includes(type)) return "textbox";
      }
      return "";
    }
    _ensureStableId(element) {
      const nativeId = String(element.id || "").trim();
      const knownNative = this._nativeIds.get(element);
      if (knownNative) {
        element.id = knownNative;
        return knownNative;
      }
      if (nativeId && /^[A-Za-z0-9_-]+$/.test(nativeId) && !/^pva-/i.test(nativeId) && !this._seenNativeIds.has(nativeId)) {
        this._seenNativeIds.add(nativeId);
        this._nativeIds.set(element, nativeId);
        return nativeId;
      }
      const existing = this._generatedIds.get(element);
      if (existing) {
        element.id = existing;
        return existing;
      }
      const declared = String(element.getAttribute?.("data-pva-id") || "").trim();
      if (/^pva-[a-z0-9]+$/i.test(declared)) {
        element.id = declared;
        this._generatedIds.set(element, declared);
        this._nativeIds.set(element, declared);
        return declared;
      }
      const fingerprint = this._elementFingerprint(element);
      let id = this._fingerprintIds.get(fingerprint);
      if (!id) {
        id = `pva-${this._hash(fingerprint)}`;
        this._fingerprintIds.set(fingerprint, id);
      }
      let candidate = id;
      while (this._fingerprintIds.get(`used:${candidate}`) && this._fingerprintIds.get(`used:${candidate}`) !== fingerprint) {
        this._idCounter += 1;
        candidate = `${id}-${this._idCounter.toString(36)}`;
      }
      this._fingerprintIds.set(`used:${candidate}`, fingerprint);
      element.id = candidate;
      if (element.dataset) element.dataset.pvaId = candidate;
      this._generatedIds.set(element, candidate);
      this._nativeIds.set(element, candidate);
      return candidate;
    }
    _elementFingerprint(element) {
      const path = [];
      let current = element;
      while (current && current.nodeType === 1 && path.length < 8) {
        let segment = current.tagName?.toLowerCase() || "node";
        if (current.id) segment += `#${current.id}`;
        else {
          const parent = current.parentElement;
          if (parent) {
            const index = Array.prototype.indexOf.call(parent.children || [], current);
            segment += `[${index >= 0 ? index : 0}]`;
          }
        }
        path.unshift(segment);
        current = current.parentElement;
      }
      const accessible = [
        element.getAttribute?.("role") || "",
        element.getAttribute?.("aria-label") || "",
        element.getAttribute?.("name") || "",
        element.getAttribute?.("placeholder") || "",
        element.getAttribute?.("type") || "",
        this._getLabel(element),
        this._getDirectText(element)
      ].join("|");
      return `${path.join("/")}::${accessible}`;
    }
    _hash(value) {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }
    _getLabel(element) {
      try {
        if (element.labels && element.labels.length) {
          return (element.labels[0].textContent || "").trim().substring(0, 200);
        }
        const nested = element.closest?.("label");
        if (nested) return (nested.textContent || "").trim().substring(0, 200);
        if (element.id) {
          for (const label of document.querySelectorAll("label")) {
            if (label.htmlFor === element.id) {
              return (label.textContent || "").trim().substring(0, 200);
            }
          }
        }
        const labelledBy = element.getAttribute?.("aria-labelledby");
        if (labelledBy) {
          const text2 = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
          if (text2) return text2.substring(0, 200);
        }
        const title = element.getAttribute?.("title");
        if (title) return title.trim().substring(0, 200);
        const alt = element.getAttribute?.("alt");
        if (alt) return alt.trim().substring(0, 200);
      } catch (_) {
      }
      return "";
    }
    _isContentEditable(element) {
      const tag = element?.tagName?.toLowerCase();
      if (["input", "textarea", "select", "button", "a"].includes(tag)) return false;
      const raw = element?.getAttribute?.("contenteditable");
      if (raw !== null && raw !== void 0) {
        const value = String(raw).toLowerCase();
        return value === "" || value === "true" || value === "plaintext-only";
      }
      const ancestor = element?.closest?.("[contenteditable]");
      if (ancestor && ancestor !== element) {
        const value = String(ancestor.getAttribute("contenteditable") || "").toLowerCase();
        return value === "" || value === "true" || value === "plaintext-only";
      }
      return false;
    }
    _getDirectText(element) {
      let text2 = "";
      for (const node of element.childNodes) {
        if (node.nodeType === 3) text2 += node.textContent;
      }
      return text2.trim();
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
  var SAFE_KEYS = /* @__PURE__ */ new Set(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown"]);
  var ActionExecutor = class _ActionExecutor {
    constructor(config) {
      this.config = config || {};
    }
    validateTarget(element, actionType = "click") {
      if (!element || element.nodeType !== 1) return { valid: false, reason: "Element not found" };
      const rect = element.getBoundingClientRect();
      if (this.config.actionValidation?.requireVisible !== false) {
        if (rect.width === 0 || rect.height === 0) {
          return { valid: false, reason: "Element not visible (zero size)" };
        }
        let style;
        try {
          style = window.getComputedStyle(element);
        } catch (_) {
          style = null;
        }
        if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
          return { valid: false, reason: "Element not visible (styled)" };
        }
        if (element.closest?.('[aria-hidden="true"]')) {
          return { valid: false, reason: "Element is hidden from accessibility" };
        }
      }
      if (element.disabled || element.getAttribute?.("aria-disabled") === "true") {
        return { valid: false, reason: "Element disabled" };
      }
      if (actionType === "type_local" && (element.readOnly || element.getAttribute?.("aria-readonly") === "true")) {
        return { valid: false, reason: "Element is read-only" };
      }
      return { valid: true };
    }
    /**
     * Build a selector for a plain element ID.  Arbitrary CSS selectors are
     * intentionally not accepted: a planner can never turn a target into a
     * selector injection primitive.
     */
    static selectorForTarget(target) {
      if (target == null || typeof target !== "string") return null;
      let value = target.trim();
      if (!value) return null;
      if (value.startsWith("#")) value = value.slice(1);
      if (!value) return null;
      if (/[.#\[\](){}>+~,:/\\]/.test(value)) return null;
      if (/^(?:body|html|window|document)$/i.test(value)) return value.toLowerCase();
      const escape = typeof CSS !== "undefined" && CSS.escape ? CSS.escape : (s) => s.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
      return `#${escape(value)}`;
    }
    execute(actionType, targetSelector, args = {}) {
      const allowed = this.config.actionValidation?.allowedActions || [];
      if (!allowed.includes(actionType)) {
        return { success: false, error: `Action ${actionType} not allowed` };
      }
      if (actionType === "wait") {
        const requested = Number(args.ms);
        const ms = Number.isFinite(requested) ? Math.max(50, Math.min(5e3, requested)) : 500;
        return new Promise((resolve) => setTimeout(() => resolve({ success: true }), ms));
      }
      let element = null;
      let selector = targetSelector;
      try {
        const pageTarget = actionType === "scroll" && (!targetSelector || /^(document|window|body|html)$/i.test(String(targetSelector).replace(/^#/, "")));
        if (pageTarget) {
          if (actionType !== "scroll") return { success: false, error: "Page target is not actionable" };
          window.scrollBy({
            top: Number(args.y) || 0,
            left: Number(args.x) || 0,
            behavior: "smooth"
          });
          return { success: true };
        }
        if (actionType === "keypress" && (!selector || !String(selector).trim())) {
          element = document.activeElement;
        } else {
          selector = _ActionExecutor.selectorForTarget(selector || "");
          if (!selector) return { success: false, error: "No target specified" };
          element = document.querySelector(selector);
        }
        if (element && actionType !== "scroll" && typeof element.scrollIntoView === "function") {
          try {
            element.scrollIntoView({ block: "center", inline: "nearest" });
          } catch (_) {
          }
        }
      } catch (e) {
        return { success: false, error: "Invalid selector" };
      }
      const validation = this.validateTarget(element, actionType);
      if (!validation.valid) return { success: false, error: validation.reason };
      try {
        switch (actionType) {
          case "click":
            if (typeof element.click !== "function") return { success: false, error: "Element is not clickable" };
            element.click();
            break;
          case "focus":
            if (typeof element.focus !== "function") return { success: false, error: "Element is not focusable" };
            element.focus();
            if (document.activeElement !== element) return { success: false, error: "Target did not become active" };
            break;
          case "scroll":
            element.scrollBy({
              top: Number(args.y) || 0,
              left: Number(args.x) || 0,
              behavior: "smooth"
            });
            break;
          case "select": {
            const tag = element.tagName?.toLowerCase();
            if (tag !== "select") return { success: false, error: "select action requires a <select> element" };
            const wanted = args.value ?? args.text;
            if (wanted == null || wanted === "") return { success: false, error: "select requires args.value or args.text" };
            const wantedStr = String(wanted);
            const option = Array.from(element.options || []).find(
              (item) => item.value === wantedStr || item.text === wantedStr || item.label === wantedStr
            );
            if (!option) return { success: false, error: "No matching option" };
            element.value = option.value;
            this._dispatch(element, "input");
            this._dispatch(element, "change");
            if (element.value !== option.value) return { success: false, error: "Selection did not apply" };
            break;
          }
          case "keypress": {
            const key = args.key;
            if (!SAFE_KEYS.has(key)) return { success: false, error: "Key is not allowed" };
            const result = this._pressKey(element, key);
            if (!result.success) return result;
            break;
          }
          default:
            return { success: false, error: "Unknown action" };
        }
        return { success: true };
      } catch (e) {
        return { success: false, error: "Action could not be completed" };
      }
    }
    _isEditableElement(element) {
      const tag = element?.tagName?.toLowerCase();
      if (["input", "textarea", "select", "button", "a"].includes(tag)) {
        return ["input", "textarea"].includes(tag);
      }
      const raw = element?.getAttribute?.("contenteditable");
      if (raw !== null && raw !== void 0) {
        const value = String(raw).toLowerCase();
        return value === "" || value === "true" || value === "plaintext-only";
      }
      const ancestor = element?.closest?.("[contenteditable]");
      if (ancestor && ancestor !== element) {
        const value = String(ancestor.getAttribute("contenteditable") || "").toLowerCase();
        return value === "" || value === "true" || value === "plaintext-only";
      }
      return false;
    }
    _dispatch(element, type) {
      const view = element.ownerDocument?.defaultView || window;
      const EventCtor = view.Event || Event;
      element.dispatchEvent(new EventCtor(type, { bubbles: true }));
    }
    _pressKey(element, key) {
      const view = element.ownerDocument?.defaultView || window;
      const KeyboardCtor = view.KeyboardEvent || KeyboardEvent;
      const init = { key, code: key, bubbles: true, cancelable: true, composed: true };
      const tag = element.tagName?.toLowerCase();
      const editable = ["input", "textarea"].includes(tag) || this._isEditableElement(element);
      if (editable && typeof element.focus === "function") {
        try {
          element.focus();
        } catch (_) {
        }
      }
      const form = element.form || element.closest?.("form");
      let submitSeen = false;
      const onSubmit = () => {
        submitSeen = true;
      };
      form?.addEventListener?.("submit", onSubmit, true);
      try {
        const keydownAllowed = element.dispatchEvent(new KeyboardCtor("keydown", init));
        element.dispatchEvent(new KeyboardCtor("keypress", init));
        element.dispatchEvent(new KeyboardCtor("keyup", init));
        if (key === "Enter" && editable && form && keydownAllowed && !submitSeen && typeof form.requestSubmit === "function") {
          form.requestSubmit();
        }
        return { success: true };
      } catch (_) {
        return { success: false, error: "Key event could not be dispatched" };
      } finally {
        form?.removeEventListener?.("submit", onSubmit, true);
      }
    }
  };

  // extension/background/action_grounding.js
  var TOKEN_SYNONYMS = Object.freeze({
    create: "add",
    created: "add",
    creating: "add",
    new: "add",
    submit: "save",
    sent: "submit",
    send: "submit",
    okay: "confirm",
    ok: "confirm"
  });
  var SAFE_KEYS2 = Object.freeze(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown"]);

  // extension/local_agent/local_vision_protocol.js
  var PII_PATTERNS = [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/,
    /\b(?:\d[ -]*?){13,19}\b/,
    /\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,})\b/
  ];
  var INTERACTIVE_TAGS = /* @__PURE__ */ new Set(["button", "a", "input", "textarea", "select"]);
  var INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
    "button",
    "link",
    "menuitem",
    "tab",
    "checkbox",
    "switch",
    "radio",
    "option",
    "treeitem",
    "textbox",
    "searchbox",
    "combobox",
    "spinbutton"
  ]);
  function text(value, max = 160) {
    return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  }
  function nodeLabel(node) {
    const tag = text(node?.tag, 30).toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) {
      return text(node?.ariaLabel || node?.label || node?.placeholder || node?.name || node?.title || node?.testId || node?.id, 120);
    }
    return text(node?.text || node?.ariaLabel || node?.placeholder || node?.label || node?.name || node?.title || node?.testId || node?.id, 120);
  }
  function isPasswordNode(node) {
    const type = text(node?.inputType, 40).toLowerCase();
    const autocomplete = text(node?.autocomplete, 60).toLowerCase();
    const identity = [node?.id, node?.name, node?.ariaLabel, node?.placeholder, node?.label, node?.text].map((value) => text(value, 200).toLowerCase()).join(" ");
    return type === "password" || autocomplete === "current-password" || autocomplete === "new-password" || /\b(?:password|passwd|pwd|secret|token|api[_ -]?key|private[_ -]?key)\b/i.test(identity);
  }
  function redactLocalString(value) {
    let result = text(value, 1e3);
    result = result.replace(PII_PATTERNS[0], "[LOCAL_EMAIL]");
    result = result.replace(PII_PATTERNS[1], "[LOCAL_NUMBER]");
    result = result.replace(PII_PATTERNS[2], "[LOCAL_NUMBER]");
    result = result.replace(PII_PATTERNS[3], "[LOCAL_SECRET]");
    if (/\b(?:password|passwd|secret|token|api[_ -]?key|private[_ -]?key)\b/i.test(result)) {
      result = result.replace(/[^\s,;:]*(?:password|passwd|secret|token|api[_ -]?key|private[_ -]?key)[^\s,;:]*/ig, "[LOCAL_SECRET]");
    }
    return result;
  }
  function containsSensitiveLiteral(value) {
    const candidate = String(value || "");
    return PII_PATTERNS.some((pattern) => pattern.test(candidate)) || /\b(?:password|passwd|secret|token|api[_ -]?key|private[_ -]?key)\b\s*(?:is|=|:)\s*\S+/i.test(candidate);
  }
  function prepareLocalDomMetadata(domElements, limit = 80) {
    const nodes = Array.isArray(domElements) ? domElements : [];
    const prepared = nodes.filter((node) => node && typeof node === "object" && node.id).map((node) => {
      const tag = text(node.tag, 30).toLowerCase();
      const role = text(node.role, 50).toLowerCase();
      const interactive = INTERACTIVE_TAGS.has(tag) || INTERACTIVE_ROLES.has(role);
      const password = isPasswordNode(node);
      const result = {
        id: text(node.id, 120),
        tag,
        role,
        label: password ? redactLocalString(node.ariaLabel || node.placeholder || node.label || node.name || "password field") : redactLocalString(nodeLabel(node)),
        text: password ? "[LOCAL_SECRET]" : ["input", "textarea", "select"].includes(tag) ? "" : redactLocalString(node.text),
        inputType: text(node.inputType, 40).toLowerCase(),
        title: text(node.title, 120),
        testId: text(node.testId, 120),
        ariaExpanded: text(node.ariaExpanded, 20),
        ariaSelected: text(node.ariaSelected, 20),
        ariaChecked: text(node.ariaChecked, 20),
        ariaCurrent: text(node.ariaCurrent, 40),
        ariaPressed: text(node.ariaPressed, 20),
        ariaHasPopup: text(node.ariaHasPopup, 40),
        bbox: sanitizeBbox(node.bbox),
        visible: node.visible !== false,
        enabled: node.enabled !== false,
        readOnly: node.readOnly === true
      };
      if (tag === "select") {
        result.options = (Array.isArray(node.options) ? node.options : []).slice(0, 30).map((option) => redactLocalString(option));
      }
      return { result, interactive };
    }).sort((a, b) => Number(b.interactive) - Number(a.interactive)).slice(0, Math.max(1, Math.min(Number(limit) || 80, 120))).map((item) => item.result);
    return prepared;
  }
  function sanitizeBbox(bbox) {
    if (!bbox || typeof bbox !== "object") return null;
    const values = ["x", "y", "width", "height"].map((key) => Number(bbox[key]));
    if (!values.every(Number.isFinite)) return null;
    return {
      x: Math.round(values[0]),
      y: Math.round(values[1]),
      width: Math.round(values[2]),
      height: Math.round(values[3])
    };
  }

  // extension/privacy/face_detector.js
  var FaceDetectorService = class {
    constructor() {
      this.nativeDetector = null;
      if ("FaceDetector" in window) {
        try {
          this.nativeDetector = new window.FaceDetector();
        } catch (e) {
          console.warn("FaceDetector supported but failed to initialize", e);
        }
      }
    }
    async detectFaces(imageCanvas, scaleX = 1, scaleY = 1) {
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
        } catch (e) {
          console.warn("Native face detection failed", e);
        }
      } else {
        console.log("No native FaceDetector found. Needs face-api fallback.");
      }
      return detections;
    }
  };

  // extension/privacy/pii_detector.js
  var PIIDetector = class {
    constructor() {
      this.regexes = {
        EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        PHONE: /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/g,
        CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/g,
        AUTH_TOKEN: /\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]*|ghp_[a-zA-Z0-9]{36}|sk-[a-zA-Z0-9]{20,})\b/g,
        AADHAAR: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
        PAN: /\b[A-Z]{5}\d{4}[A-Z]\b/g
      };
    }
    /** Luhn check for credit card validation */
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
    /** Verhoeff checksum for Aadhaar validation */
    _verhoeffCheck(numStr) {
      const digits = numStr.replace(/\D/g, "");
      if (digits.length !== 12) return false;
      const d = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
        [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
        [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
        [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
        [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
        [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
        [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
        [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
        [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
      ];
      const p = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
        [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
        [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
        [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
        [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
        [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
        [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
      ];
      const inv = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];
      let c = 0;
      const arr = digits.split("").reverse().map(Number);
      for (let i = 0; i < arr.length; i++) {
        c = d[c][p[i % 8][arr[i]]];
      }
      return c === 0;
    }
    _looksLikePersonName(text2) {
      if (typeof text2 !== "string") return false;
      const value = text2.trim();
      if (value.length < 3 || value.length > 80) return false;
      const stopWords = /* @__PURE__ */ new Set([
        "save",
        "button",
        "submit",
        "application",
        "full",
        "name",
        "email",
        "inbox",
        "compose",
        "subject",
        "message",
        "send",
        "hello",
        "world",
        "software",
        "engineer",
        "customer",
        "account",
        "login",
        "sign",
        "out",
        "whatsapp",
        "web",
        "google",
        "meet",
        "profile",
        "contact",
        "conversation",
        "chat",
        "search",
        "settings",
        "privacy",
        "terms",
        "community",
        "status",
        "text",
        "today",
        "yesterday",
        "online",
        "away",
        "thanks",
        "thank",
        "you",
        "please",
        "yes",
        "no",
        "sure",
        "hi",
        "hey",
        "good",
        "morning",
        "night",
        "see",
        "later",
        "welcome"
      ]);
      const words = value.split(/\s+/);
      if (words.length < 2 || words.length > 4) return false;
      if (words.some((word) => stopWords.has(word.toLowerCase().replace(/[^a-z]/g, "")))) return false;
      return words.every((word) => /^[A-Z][a-z'-]+$/.test(word));
    }
    extractRegex(text2, bbox, source) {
      const detections = [];
      for (const [type, regex] of Object.entries(this.regexes)) {
        regex.lastIndex = 0;
        let match;
        let safetyCount = 0;
        while ((match = regex.exec(text2)) !== null && safetyCount < 50) {
          safetyCount++;
          if (type === "CREDIT_CARD") {
            if (!this._luhnCheck(match[0])) continue;
          }
          if (type === "PHONE") {
            const digitCount = match[0].replace(/\D/g, "").length;
            if (digitCount < 7) continue;
          }
          if (type === "PAN") {
            const fourthChar = match[0][3];
            if (!"CPHFATBLJG".includes(fourthChar)) continue;
          }
          detections.push({ type, bbox, confidence: 0.75, sources: [source] });
        }
      }
      return detections;
    }
    _hasUsableBbox(bbox) {
      return !!(bbox && bbox.width > 0 && bbox.height > 0);
    }
    _looksLikePasswordField(element) {
      const ac = (element.autocomplete || "").toLowerCase();
      if (element.inputType === "password") return true;
      if (ac === "current-password" || ac === "new-password") return true;
      const idLower = (element.id || "").toLowerCase();
      if (/(?:^|[-_])(?:password|passwd|pwd)(?:$|[-_])/i.test(idLower) || idLower === "password" || idLower.includes("password") || idLower.includes("passwd") || idLower.endsWith("pwd") || idLower.includes("-pwd") || idLower.includes("_pwd")) {
        return true;
      }
      return false;
    }
    detectDOM(element) {
      const detections = [];
      const bbox = element.bbox;
      const isInput = element.tag === "input" || element.tag === "textarea" || element.tag === "select";
      if (isInput && this._looksLikePasswordField(element) && this._hasUsableBbox(bbox)) {
        detections.push({ type: "PASSWORD", bbox, confidence: 1, sources: ["DOM"] });
      }
      const inputType = String(element.inputType || "").toLowerCase();
      if (isInput && inputType === "email" && this._hasUsableBbox(bbox)) {
        detections.push({ type: "EMAIL", bbox, confidence: 0.95, sources: ["DOM_INPUT_TYPE"] });
      }
      if (isInput && inputType === "tel" && this._hasUsableBbox(bbox)) {
        detections.push({ type: "PHONE", bbox, confidence: 0.9, sources: ["DOM_INPUT_TYPE"] });
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
      if (isInput || element.inputType === "contenteditable") {
        const idLower = (element.id || "").toLowerCase();
        if (idLower.includes("email") && !ac) {
          detections.push({ type: "EMAIL", bbox, confidence: 0.8, sources: ["DOM"] });
        }
        if ((idLower.includes("card") || idLower.includes("cc-")) && !ac) {
          detections.push({ type: "CREDIT_CARD", bbox, confidence: 0.8, sources: ["DOM"] });
        }
        if ((idLower.includes("aadhaar") || idLower.includes("aadhar") || idLower.includes("uid")) && !ac) {
          detections.push({ type: "AADHAAR", bbox, confidence: 0.8, sources: ["DOM"] });
        }
        if (idLower.includes("pan") && !ac) {
          detections.push({ type: "PAN", bbox, confidence: 0.8, sources: ["DOM"] });
        }
        if (idLower.includes("address") && !ac) {
          detections.push({ type: "ADDRESS", bbox, confidence: 0.8, sources: ["DOM"] });
        }
        const semantic = [element.id, element.name, element.placeholder, element.ariaLabel, element.label].filter(Boolean).join(" ").toLowerCase();
        if (element.text && /(^|[-_ ])(full[-_ ]?)?name|given[-_ ]?name|family[-_ ]?name/.test(semantic)) {
          detections.push({ type: "PERSON", bbox, confidence: 0.85, sources: ["DOM"] });
        }
        if (idLower.includes("avatar") || idLower.includes("profile-pic")) {
          detections.push({ type: "FACE", bbox, confidence: 0.8, sources: ["DOM"] });
        }
      }
      const textTag = ["strong", "b", "address", "span", "div", "p", "li", "h1", "h2", "h3", "h4", "h5", "h6"].includes(element.tag);
      const identity = [element.id, element.name, element.ariaLabel, element.label, element.placeholder].filter(Boolean).join(" ").toLowerCase();
      const profileHint = /profile|avatar|contact|account|display|full[-_ ]?name/.test(identity);
      const role = String(element.role || "").toLowerCase();
      if (["img", "image"].includes(element.tag) || role === "img") {
        if (/avatar|profile|face|photo|pfp|profile[-_ ]?pic/.test(identity)) {
          detections.push({
            type: "FACE",
            bbox,
            confidence: 0.8,
            sources: ["DOM_AVATAR"]
          });
        }
      }
      const metadataName = [element.ariaLabel, element.label, element.placeholder, element.name].some((value) => this._looksLikePersonName(value));
      if (textTag && this._looksLikePersonName(element.text) || profileHint && metadataName) {
        detections.push({
          type: "PERSON",
          bbox,
          confidence: profileHint || ["strong", "b", "address"].includes(element.tag) ? 0.7 : 0.55,
          sources: ["DOM_NAME_HEURISTIC"]
        });
      }
      if (element.text && !(isInput && this._looksLikePasswordField(element))) {
        detections.push(...this.extractRegex(element.text, bbox, "DOM_REGEX"));
      }
      for (const metadata of [element.autocomplete, element.placeholder, element.ariaLabel, element.name, element.label]) {
        if (metadata && !this._looksLikePasswordField(element)) {
          detections.push(...this.extractRegex(metadata, bbox, "DOM_METADATA"));
        }
      }
      for (const option of element.options || []) {
        if (option && !this._looksLikePasswordField(element)) {
          detections.push(...this.extractRegex(option, bbox, "DOM_METADATA"));
        }
      }
      return detections;
    }
    detectOCR(ocrResult) {
      const detections = this.extractRegex(ocrResult.text, ocrResult.bbox, "OCR");
      if (this._looksLikePersonName(ocrResult.text)) {
        detections.push({
          type: "PERSON",
          bbox: ocrResult.bbox,
          confidence: 0.55,
          sources: ["OCR_NAME_HEURISTIC"]
        });
      }
      return detections;
    }
    _isProfileImageCandidate(node) {
      if (!node || node.visible === false) return false;
      const tag = String(node.tag || "").toLowerCase();
      const role = String(node.role || "").toLowerCase();
      if (!["img", "image"].includes(tag) && role !== "img") return false;
      const identity = [node.id, node.name, node.ariaLabel, node.label, node.placeholder].filter(Boolean).join(" ").toLowerCase();
      if (/avatar|profile|face|photo|pfp|profile[-_ ]?pic/.test(identity)) return true;
      const width = Number(node.bbox?.width) || 0;
      const height = Number(node.bbox?.height) || 0;
      const ratio = width && height ? width / height : 0;
      return width >= 24 && width <= 180 && height >= 24 && height <= 180 && ratio >= 0.72 && ratio <= 1.38;
    }
    _isShortNameCandidate(node) {
      const text2 = String(node?.text || "").trim();
      if (!text2 || text2.length > 80 || /\d[@+._-]|\d{3,}/.test(text2)) return false;
      if (this._looksLikePersonName(text2)) return true;
      const words = text2.split(/\s+/);
      if (words.length !== 1) return false;
      const stopWords = /* @__PURE__ */ new Set([
        "online",
        "away",
        "active",
        "settings",
        "profile",
        "contact",
        "message",
        "chat",
        "search",
        "status",
        "today",
        "yesterday",
        "privacy",
        "help"
      ]);
      const word = words[0].toLowerCase().replace(/[^a-z]/g, "");
      return /^[A-Z][a-z'-]{2,}$/.test(words[0]) && !stopWords.has(word);
    }
    _boxesNear(a, b) {
      const ax = Number(a?.x) || 0;
      const ay = Number(a?.y) || 0;
      const aw = Number(a?.width) || 0;
      const ah = Number(a?.height) || 0;
      const bx = Number(b?.x) || 0;
      const by = Number(b?.y) || 0;
      const bw = Number(b?.width) || 0;
      const bh = Number(b?.height) || 0;
      const aCenterX = ax + aw / 2;
      const bCenterX = bx + bw / 2;
      const aCenterY = ay + ah / 2;
      const bCenterY = by + bh / 2;
      const horizontalGap = Math.max(0, Math.max(ax, bx) - Math.min(ax + aw, bx + bw));
      const verticalGap = Math.max(0, Math.max(ay, by) - Math.min(ay + ah, by + bh));
      return horizontalGap <= Math.max(180, aw * 3) && verticalGap <= Math.max(80, ah * 2) && Math.abs(aCenterY - bCenterY) <= Math.max(80, ah * 2) && Math.abs(aCenterX - bCenterX) <= 240;
    }
    _hasOverlappingDetection(detections, type, bbox) {
      return detections.some((det) => det.type === type && this._boxesNear(det.bbox, bbox));
    }
    detectProfileContexts(domElements, detections) {
      const elements = Array.isArray(domElements) ? domElements : [];
      const images = elements.filter((node) => this._isProfileImageCandidate(node));
      if (!images.length) return detections;
      const textNodes = elements.filter((node) => node?.text && this._isShortNameCandidate(node));
      for (const image of images) {
        if (!this._hasOverlappingDetection(detections, "FACE", image.bbox)) {
          detections.push({
            type: "FACE",
            bbox: { ...image.bbox },
            confidence: 0.65,
            sources: ["PROFILE_CONTEXT"]
          });
        }
        for (const textNode of textNodes) {
          if (!this._boxesNear(image.bbox, textNode.bbox)) continue;
          if (!this._hasOverlappingDetection(detections, "PERSON", textNode.bbox)) {
            detections.push({
              type: "PERSON",
              bbox: { ...textNode.bbox },
              confidence: 0.65,
              sources: ["PROFILE_CONTEXT"]
            });
          }
        }
      }
      return detections;
    }
    detectAll(domElements, ocrResults) {
      let allDetections = [];
      for (const el of domElements) {
        allDetections.push(...this.detectDOM(el));
      }
      for (const ocr of ocrResults) {
        allDetections.push(...this.detectOCR(ocr));
      }
      return this.detectProfileContexts(domElements, allDetections);
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
    _isPasswordElement(el) {
      if (el.inputType === "password") return true;
      const ac = (el.autocomplete || "").toLowerCase();
      if (ac === "current-password" || ac === "new-password") return true;
      const idLower = (el.id || "").toLowerCase();
      return idLower.includes("password") || idLower.includes("passwd") || idLower.includes("-pwd") || idLower.includes("_pwd") || idLower.endsWith("pwd");
    }
    _isSensitiveText(value) {
      return typeof value === "string" && (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value) || /\b(?:\d[ -]*?){13,19}\b/.test(value) || /\b\d{4}\s?\d{4}\s?\d{4}\b/.test(value) || /\b[A-Z]{5}\d{4}[A-Z]\b/.test(value) || /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/.test(value) || /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(value) || /\bghp_[A-Za-z0-9]{36}\b/.test(value) || /\bsk-[A-Za-z0-9]{20,}\b/.test(value));
    }
    _redactSensitiveMetadata(el, token) {
      for (const key of ["autocomplete", "placeholder", "ariaLabel", "name", "label", "title", "testId"]) {
        if (this._isSensitiveText(el[key])) el[key] = token;
      }
      if (Array.isArray(el.options) && el.options.some((value) => this._isSensitiveText(value))) {
        el.options = el.options.map(() => token);
      }
    }
    sanitizeDOM(rawDomElements, plannedRedactions) {
      const sanitized = JSON.parse(JSON.stringify(rawDomElements));
      for (const el of sanitized) {
        const isPassword = this._isPasswordElement(el);
        let bestToken = null;
        let highestOverlap = 0;
        let passwordToken = null;
        for (const plan of plannedRedactions) {
          const overlap = this.calculateOverlap(el.bbox, plan.bbox);
          if (overlap > highestOverlap) {
            highestOverlap = overlap;
            bestToken = plan.token;
          }
          if (plan.type === "PASSWORD" && overlap > 0) {
            passwordToken = plan.token;
          }
        }
        if (isPassword) {
          const token = passwordToken || "[PASSWORD_1]";
          el.text = token;
          if (el.value !== void 0) el.value = token;
          this._redactSensitiveMetadata(el, token);
        } else if (bestToken) {
          el.text = bestToken;
          if (el.value) el.value = bestToken;
          this._redactSensitiveMetadata(el, bestToken);
        }
      }
      return sanitized;
    }
    /** Replace common PII patterns in a non-DOM string such as a page URL. */
    redactText(value) {
      if (typeof value !== "string" || !value) return "";
      const counters = {};
      const token = (type) => {
        counters[type] = (counters[type] || 0) + 1;
        return `[${type}_${counters[type]}]`;
      };
      const patterns = [
        ["AUTH_TOKEN", /\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,})\b/g],
        ["EMAIL", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
        ["CREDIT_CARD", /\b(?:\d[ -]*?){13,19}\b/g],
        ["AADHAAR", /\b\d{4}\s?\d{4}\s?\d{4}\b/g],
        ["PHONE", /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/g],
        ["PAN", /\b[A-Z]{5}\d{4}[A-Z]\b/g]
      ];
      let result = value;
      for (const [type, pattern] of patterns) {
        result = result.replace(pattern, () => token(type));
      }
      return result;
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
    _containsSensitiveText(value) {
      return typeof value === "string" && (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value) || /\b(?:\d[ -]*?){13,19}\b/.test(value) || /\b\d{4}\s?\d{4}\s?\d{4}\b/.test(value) || /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/.test(value) || /\b(?:ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}|ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/.test(value));
    }
    constructor() {
      this.KNOWN_TYPES = /* @__PURE__ */ new Set([
        "EMAIL",
        "PHONE",
        "PERSON",
        "ADDRESS",
        "CREDIT_CARD",
        "PASSWORD",
        "AUTH_TOKEN",
        "FACE",
        "AADHAAR",
        "PAN"
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
        if (this._containsSensitiveText(raw.text) && san.text === raw.text) {
          throw new Error(`Sensitive text remained in element ${raw.id || raw.tag}`);
        }
        const ac = (san.autocomplete || "").toLowerCase();
        const idLower = (san.id || "").toLowerCase();
        const isPasswordField = san.inputType === "password" || ac === "current-password" || ac === "new-password" || idLower.includes("password") || idLower.includes("passwd") || idLower.includes("-pwd") || idLower.includes("_pwd") || idLower.endsWith("pwd");
        if (isPasswordField) {
          if (!san.text || !san.text.startsWith("[PASSWORD")) {
            throw new Error("Password field not properly sanitized");
          }
        }
        for (const key of ["autocomplete", "placeholder", "ariaLabel", "name", "label"]) {
          const value = san[key];
          if (this._containsSensitiveText(raw[key]) && value === raw[key]) {
            throw new Error(`Sensitive value remained in ${key}`);
          }
          if (typeof value === "string" && (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value) || /\b(?:\d[ -]*?){13,19}\b/.test(value) || /\b\d{4}\s?\d{4}\s?\d{4}\b/.test(value) || /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/.test(value) || /\b(?:ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}|ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/.test(value))) {
            throw new Error(`Sensitive value remained in ${key}`);
          }
        }
        if (Array.isArray(san.options)) {
          const rawOptions = Array.isArray(raw.options) ? raw.options : [];
          for (let index = 0; index < san.options.length; index++) {
            const option = san.options[index];
            if (this._containsSensitiveText(rawOptions[index]) && option === rawOptions[index]) {
              throw new Error("Sensitive value remained in select options");
            }
            if (typeof option === "string" && (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(option) || /\b(?:\d[ -]*?){13,19}\b/.test(option) || /\b\d{4}\s?\d{4}\s?\d{4}\b/.test(option) || /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/.test(option) || /\b(?:ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}|ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/.test(option))) {
              throw new Error("Sensitive value remained in select options");
            }
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
        const { x, y, width, height } = plan.bbox;
        if (!width || !height) continue;
        const cx = Math.floor((x + width / 2) * scaleX);
        const cy = Math.floor((y + height / 2) * scaleY);
        if (cx < 0 || cx >= redactedCanvas.width || cy < 0 || cy >= redactedCanvas.height) {
          continue;
        }
        const idx = (cy * redactedCanvas.width + cx) * 4;
        const r = imgData[idx];
        const g = imgData[idx + 1];
        const b = imgData[idx + 2];
        if (r !== 0 || g !== 0 || b !== 0) {
          throw new Error(`Incomplete visual redaction at (${cx}, ${cy}) for ${plan.type}`);
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
  var LocalSecretProvider = class _LocalSecretProvider {
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
      const isContentEditable = _LocalSecretProvider._isContentEditableElement(element);
      if (tag !== "input" && tag !== "textarea" && !isContentEditable) {
        return { valid: false, reason: "Target must be input or textarea" };
      }
      if (isContentEditable && secretRef === "password") {
        return { valid: false, reason: "Passwords require a password input" };
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
    static _isContentEditableElement(element) {
      const tag = element?.tagName?.toLowerCase();
      if (["input", "textarea", "select", "button", "a"].includes(tag)) return false;
      const raw = element?.getAttribute?.("contenteditable");
      if (raw !== null && raw !== void 0) {
        const value = String(raw).toLowerCase();
        return value === "" || value === "true" || value === "plaintext-only";
      }
      const ancestor = element?.closest?.("[contenteditable]");
      if (ancestor && ancestor !== element) {
        const value = String(ancestor.getAttribute("contenteditable") || "").toLowerCase();
        return value === "" || value === "true" || value === "plaintext-only";
      }
      return false;
    }
    /** Insert a value into a target element with proper DOM events. */
    static insertSecret(element, value, options = {}) {
      const isContentEditable = _LocalSecretProvider._isContentEditableElement(element);
      if (isContentEditable) {
        try {
          element.focus();
        } catch (_) {
        }
        const view = element.ownerDocument?.defaultView || window;
        const InputCtor = view.InputEvent || view.Event;
        const inputInit = InputCtor === view.Event ? { bubbles: true } : { bubbles: true, inputType: "insertText", data: String(value) };
        if (options.beforeinput !== false && (typeof view.InputEvent === "function" || InputCtor === view.Event)) {
          try {
            element.dispatchEvent(new InputCtor("beforeinput", { ...inputInit, cancelable: true }));
          } catch (_) {
          }
        }
        element.textContent = String(value);
        element.dispatchEvent(new InputCtor("input", inputInit));
        const EventCtor = view.Event || Event;
        element.dispatchEvent(new EventCtor("change", { bubbles: true }));
        if (options.blur !== false) {
          try {
            element.blur();
          } catch (_) {
          }
        }
      } else {
        const view = element.ownerDocument?.defaultView || window;
        const isTextarea = element.tagName?.toLowerCase() === "textarea";
        const prototype = isTextarea ? view.HTMLTextAreaElement?.prototype : view.HTMLInputElement?.prototype;
        const nativeValueSetter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : null;
        const InputCtor = view.InputEvent || view.Event;
        const inputInit = InputCtor === view.Event ? { bubbles: true } : { bubbles: true, inputType: "insertText", data: String(value) };
        if (options.beforeinput !== false) {
          try {
            element.dispatchEvent(new InputCtor("beforeinput", { ...inputInit, cancelable: true }));
          } catch (_) {
          }
        }
        if (nativeValueSetter) {
          nativeValueSetter.call(element, value);
        } else {
          element.value = value;
        }
        const EventCtor = view.Event || Event;
        element.dispatchEvent(new InputCtor("input", inputInit));
        element.dispatchEvent(new EventCtor("change", { bubbles: true }));
      }
    }
  };

  // extension/privacy/ocr_trigger.js
  var OCRTriggerPolicy = class {
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
        if (el.tag === "canvas") canvasCount++;
        if (el.tag === "img") {
          imgCount++;
          const identity = [el.id, el.name, el.ariaLabel, el.label, el.placeholder].filter(Boolean).join(" ").toLowerCase();
          const width = Number(el.bbox?.width) || 0;
          const height = Number(el.bbox?.height) || 0;
          const ratio = width && height ? width / height : 0;
          if (/avatar|profile|face|photo|pfp|profile[-_ ]?pic/.test(identity) || width >= 24 && width <= 180 && height >= 24 && height <= 180 && ratio >= 0.72 && ratio <= 1.38) {
            profileImageCount++;
          }
        }
      }
      const textCoverage = totalVisible > 0 ? textBearingCount / totalVisible : 1;
      const imageRatio = totalVisible > 0 ? imgCount / totalVisible : 0;
      if (canvasCount > 0) {
        return {
          shouldRunOCR: true,
          reason: "Canvas element detected \u2014 may contain text as pixels",
          estimatedValue: "high",
          textCoverage,
          imageRatio
        };
      }
      if (profileImageCount > 0) {
        return {
          shouldRunOCR: true,
          reason: "Profile/avatar image detected \u2014 nearby text may be rendered visually",
          estimatedValue: "medium",
          textCoverage,
          imageRatio
        };
      }
      if (imgCount >= 3 && imageRatio >= 0.5) {
        return {
          shouldRunOCR: true,
          reason: "Image-heavy page detected",
          estimatedValue: "medium",
          textCoverage,
          imageRatio
        };
      }
      return {
        shouldRunOCR: false,
        reason: "DOM text coverage sufficient or no image-heavy content",
        estimatedValue: "low",
        textCoverage,
        imageRatio
      };
    }
  };

  // extension/privacy/ocr_provider.js
  var OCRProvider = class {
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
  };

  // extension/privacy/tesseract_ocr.js
  var OffscreenOCRProvider = class extends OCRProvider {
    constructor({ timeoutMs = 45e3 } = {}) {
      super();
      this.timeoutMs = Math.max(1e3, Number(timeoutMs) || 45e3);
    }
    async initialize() {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
        throw new Error("OCR_OFFSCREEN_UNAVAILABLE");
      }
    }
    async recognize(image) {
      await this.initialize();
      const dataUri = typeof image === "string" ? image : typeof image?.toDataURL === "function" ? image.toDataURL("image/jpeg", 0.8) : "";
      if (!/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(dataUri)) {
        throw new Error("OCR_IMAGE_INVALID");
      }
      const response = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({
            type: "LOCAL_OCR_RECOGNIZE",
            image: dataUri,
            imageWidth: Number(image?.width) || 0,
            imageHeight: Number(image?.height) || 0,
            timeoutMs: this.timeoutMs
          }, (result) => {
            void chrome.runtime.lastError;
            resolve(result || { ok: false, reason: "OCR_OFFSCREEN_UNAVAILABLE" });
          });
        } catch (_) {
          resolve({ ok: false, reason: "OCR_OFFSCREEN_UNAVAILABLE" });
        }
      });
      if (!response?.ok) {
        throw new Error(String(response?.reason || "OCR_OFFSCREEN_UNAVAILABLE"));
      }
      return {
        results: Array.isArray(response.results) ? response.results : [],
        inferenceTimeMs: Number(response.inferenceTimeMs) || 0
      };
    }
    async dispose() {
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
    // Set to true to log backend request/response details to the service worker console.
    // Disable in production — logs include DOM metadata.
    debugMode: true,
    backendUrl: "http://localhost:8000",
    // The provider has a bounded server-side timeout plus a short retry
    // budget. Keep the browser deadline longer so a valid plan is not thrown
    // away merely because the first VLM response is slow.
    apiTimeoutMs: 12e4,
    // The packaged local VLM runs in an offscreen document/worker. A timeout
    // abstains to the existing privacy-gated server path.
    localVisionTimeoutMs: 12e4,
    actionValidation: {
      requireVisible: true,
      allowedActions: ["click", "scroll", "focus", "select", "wait", "keypress", "type_local"]
    }
  };

  // extension/content/privacy_pipeline_runner.js
  var logger = new Logger("PrivacyPipelineRunner");
  function textFingerprint(value) {
    const normalized = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
    let hash = 2166136261;
    for (let index = 0; index < normalized.length; index++) {
      hash ^= normalized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }
  var PrivacyPipelineRunner = class {
    constructor(options = {}) {
      this.analyzer = options.analyzer || new DOMAnalyzer();
      this.executor = options.executor || new ActionExecutor(Config);
      this.faceDetector = options.faceDetector || new FaceDetectorService();
      this.detector = options.detector || new PIIDetector();
      this.fusion = options.fusion || new PIIFusion();
      this.redactor = options.redactor || new Redactor();
      this.gate = options.gate || new PrivacyGate();
      this.ocrTrigger = options.ocrTrigger || new OCRTriggerPolicy();
      this.ocrProvider = options.ocrProvider || new OffscreenOCRProvider({
        timeoutMs: options.ocrTimeoutMs || 45e3
      });
      this.secretProvider = new LocalSecretProvider();
      this._secretsLoaded = false;
      this._recentTypeWrites = /* @__PURE__ */ new WeakMap();
      this._ocrInitialized = false;
      this._ocrInitPromise = null;
    }
    async run() {
      const timing = {};
      const t0 = performance.now();
      let t = performance.now();
      const domElements = this.analyzer.analyzeDOM();
      timing.dom = performance.now() - t;
      t = performance.now();
      const domDetections = typeof this.detector.detectDOM === "function" ? domElements.flatMap((element) => this.detector.detectDOM(element)) : this.detector.detectAll(domElements, []);
      timing.domPii = performance.now() - t;
      t = performance.now();
      const ocrTrigger = this.ocrTrigger.evaluate(domElements);
      timing.ocrTrigger = performance.now() - t;
      t = performance.now();
      const dataUri = await this._captureScreenshot();
      timing.screenshot = performance.now() - t;
      t = performance.now();
      const processedCanvas = await this._preprocessImage(dataUri);
      timing.preprocess = performance.now() - t;
      const scaleX = (processedCanvas.width || 1) / Math.max(1, window.innerWidth || 1);
      const scaleY = (processedCanvas.height || 1) / Math.max(1, window.innerHeight || 1);
      let ocrResults = [];
      let ocrFailure = null;
      if (ocrTrigger?.shouldRunOCR) {
        t = performance.now();
        try {
          await this._ensureOCRInitialized();
          const rawOCR = await this.ocrProvider.recognize(processedCanvas);
          ocrResults = this._normalizeOCRResults(rawOCR, scaleX, scaleY, processedCanvas);
        } catch (error) {
          ocrFailure = { reason: this._safeOCRFailureReason(error) };
          logger.warn("OCR failed; privacy gate will fail closed", {
            reason: ocrFailure.reason
          });
        }
        timing.ocr = performance.now() - t;
      } else {
        timing.ocr = 0;
      }
      t = performance.now();
      const ocrDetections = ocrResults.flatMap((result) => this.detector.detectOCR(result));
      const rawDetections = [...domDetections, ...ocrDetections];
      t = performance.now();
      const faceDetections = await this.faceDetector.detectFaces(processedCanvas, scaleX, scaleY);
      timing.face = performance.now() - t;
      rawDetections.push(...faceDetections);
      const fusedDetections = this.fusion.fuse(rawDetections);
      timing.pii = performance.now() - t;
      t = performance.now();
      const plan = this.redactor.planRedaction(fusedDetections);
      timing.plan = performance.now() - t;
      t = performance.now();
      const redactedCanvas = await this.redactor.redactImage(processedCanvas, plan, scaleX, scaleY);
      timing.redact = performance.now() - t;
      const sanitizedDom = this.redactor.sanitizeDOM(domElements, plan);
      const rawContext = { dom: domElements, scaleX, scaleY };
      const sanitizedContext = { dom: sanitizedDom, image: redactedCanvas };
      t = performance.now();
      const gateResult = this.gate.verify(rawContext, sanitizedContext, plan) || {
        allowed: false,
        violations: ["Privacy gate returned no result"]
      };
      if (ocrFailure) {
        gateResult.allowed = false;
        const reasonSuffix = ocrFailure.reason ? ` (${ocrFailure.reason})` : "";
        gateResult.violations = [
          ...gateResult.violations || [],
          `OCR unavailable${reasonSuffix}; request blocked`
        ];
      }
      timing.gate = performance.now() - t;
      timing.total = performance.now() - t0;
      if (!gateResult.allowed) {
        logger.warn("Privacy gate blocked", { violations: gateResult.violations });
        return {
          allowed: false,
          violations: gateResult.violations,
          timing,
          ocr: {
            triggered: !!ocrTrigger?.shouldRunOCR,
            resultCount: ocrResults.length,
            failureReason: ocrFailure?.reason || null
          }
        };
      }
      const sanitizedPayload = {
        page: {
          // URLs and titles can contain PII in query parameters or page
          // text even when the visible DOM is clean.
          url: this.redactor.redactText(window.location.href),
          title: this.redactor.redactText(document.title),
          viewport: { width: window.innerWidth, height: window.innerHeight }
        },
        dom: sanitizedDom.map((el) => ({
          id: el.id || "",
          tag: el.tag || "",
          role: el.role || "",
          text: el.text || "",
          inputType: el.inputType || "",
          autocomplete: el.autocomplete || "",
          placeholder: el.placeholder || "",
          ariaLabel: el.ariaLabel || "",
          name: el.name || "",
          title: el.title || "",
          testId: el.testId || "",
          label: el.label || "",
          ariaExpanded: el.ariaExpanded || "",
          ariaSelected: el.ariaSelected || "",
          ariaChecked: el.ariaChecked || "",
          ariaCurrent: el.ariaCurrent || "",
          ariaPressed: el.ariaPressed || "",
          ariaHasPopup: el.ariaHasPopup || "",
          options: Array.isArray(el.options) ? el.options.slice(0, 100) : [],
          bbox: el.bbox || { x: 0, y: 0, width: 1, height: 1 },
          visible: !!el.visible,
          enabled: !!el.enabled,
          readOnly: !!el.readOnly
        })),
        image: redactedCanvas.toDataURL("image/jpeg", 0.8)
      };
      logger.info("Privacy pipeline passed", { timing, detections: plan.length });
      return {
        allowed: true,
        sanitizedContext: sanitizedPayload,
        timing,
        redactionPlan: plan,
        ocr: {
          triggered: !!ocrTrigger?.shouldRunOCR,
          resultCount: ocrResults.length,
          reason: ocrTrigger?.reason || ""
        }
      };
    }
    /**
     * Capture a raw screenshot and bounded local metadata for the offscreen
     * VLM. This path never contacts the backend and never returns raw DOM
     * values; the screenshot is used only by the extension-local worker.
     */
    async observeForLocalVision() {
      const started = performance.now();
      const domElements = this.analyzer.analyzeDOM();
      const dataUri = await this._captureScreenshot();
      const canvas = await this._preprocessImage(dataUri);
      const viewportWidth = globalThis.window?.innerWidth || canvas.width || 1;
      const viewportHeight = globalThis.window?.innerHeight || canvas.height || 1;
      const scaleX = (canvas.width || 1) / Math.max(1, viewportWidth);
      const scaleY = (canvas.height || 1) / Math.max(1, viewportHeight);
      let ocrResults = [];
      let ocrStatus = "not-needed";
      try {
        const trigger = this.ocrTrigger?.evaluate?.(domElements);
        if (trigger?.shouldRunOCR) {
          await this._ensureOCRInitialized();
          const rawOCR = await this.ocrProvider.recognize(canvas);
          ocrResults = this._normalizeOCRResults(rawOCR, scaleX, scaleY, canvas);
          ocrStatus = "available";
        }
      } catch (_) {
        ocrStatus = "unavailable";
      }
      return {
        dom: prepareLocalDomMetadata(domElements, 80),
        image: canvas.toDataURL("image/jpeg", 0.82),
        ocr: this._safeLocalOCR(ocrResults),
        ocrStatus,
        timing: {
          total: performance.now() - started
        }
      };
    }
    async _captureScreenshot() {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "CAPTURE_TAB" }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error("Capture failed: " + chrome.runtime.lastError.message));
          } else if (res?.dataUri) {
            resolve(res.dataUri);
          } else if (res?.error) {
            reject(new Error("Capture failed: " + res.error));
          } else {
            reject(new Error("Capture failed: no dataUri returned"));
          }
        });
      });
    }
    _safeLocalOCR(results) {
      return (Array.isArray(results) ? results : []).filter((item) => {
        const value = String(item?.text || "");
        return value && !containsSensitiveLiteral(value) && !/\b(?:password|passwd|secret|token|api[_ -]?key)\b/i.test(value);
      }).slice(0, 60).map((item) => ({
        text: String(item.text).slice(0, 160),
        bbox: item.bbox
      }));
    }
    _safeOCRFailureReason(error) {
      const message = String(error?.message || error || "").toLowerCase();
      if (message.includes("tesseract.js is not loaded") || message.includes("tesseract is not loaded")) {
        return "tesseract-library-missing";
      }
      if (message.includes("extension runtime")) return "extension-runtime-unavailable";
      if (/offscreen|chrome\.runtime|service worker/.test(message)) return "offscreen-unavailable";
      if (/timeout|timed out|aborted/.test(message)) return "timeout";
      if (/worker|wasm|traineddata|fetch|network|module|import|load|csp|securityerror|blob|404|403|cors/.test(message)) {
        return "worker-load-failed";
      }
      return "provider-error";
    }
    async _ensureOCRInitialized() {
      if (this._ocrInitialized) return;
      if (this._ocrInitPromise) return this._ocrInitPromise;
      this._ocrInitPromise = Promise.resolve().then(() => {
        if (typeof this.ocrProvider.initialize === "function") {
          return this.ocrProvider.initialize();
        }
      }).then(() => {
        this._ocrInitialized = true;
      }).catch((error) => {
        this._ocrInitPromise = null;
        throw error;
      });
      return this._ocrInitPromise;
    }
    _normalizeOCRResults(output, scaleX, scaleY, image) {
      const rawResults = Array.isArray(output) ? output : Array.isArray(output?.results) ? output.results : output?.data?.words || output?.data?.blocks ? this._flattenOCRBlocks(output.data) : null;
      if (!Array.isArray(rawResults)) {
        throw new Error("OCR provider returned an invalid result");
      }
      return rawResults.map((result) => {
        const text2 = String(result?.text || "").trim();
        if (!text2) return null;
        return {
          text: text2,
          bbox: this._normalizeOCRBox(result.bbox, scaleX, scaleY, image),
          confidence: Number.isFinite(result.confidence) ? result.confidence : 0,
          source: "OCR"
        };
      }).filter(Boolean);
    }
    _flattenOCRBlocks(data) {
      const words = [];
      const visit = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node.words)) words.push(...node.words);
        if (Array.isArray(node.lines)) node.lines.forEach(visit);
        if (Array.isArray(node.paragraphs)) node.paragraphs.forEach(visit);
        if (Array.isArray(node.blocks)) node.blocks.forEach(visit);
      };
      visit(data);
      return words;
    }
    _normalizeOCRBox(bbox, scaleX, scaleY, image) {
      let x;
      let y;
      let width;
      let height;
      if (Array.isArray(bbox)) {
        [x, y, width, height] = bbox;
      } else if (bbox && Number.isFinite(bbox.x0)) {
        x = bbox.x0;
        y = bbox.y0;
        width = bbox.x1 - bbox.x0;
        height = bbox.y1 - bbox.y0;
      } else if (bbox) {
        ({ x, y, width, height } = bbox);
      }
      if (![x, y, width, height].every(Number.isFinite)) {
        return {
          x: 0,
          y: 0,
          width: Math.max(1, image?.width || 1) / scaleX,
          height: Math.max(1, image?.height || 1) / scaleY
        };
      }
      const safeScaleX = scaleX > 0 ? scaleX : 1;
      const safeScaleY = scaleY > 0 ? scaleY : 1;
      return {
        x: x / safeScaleX,
        y: y / safeScaleY,
        width: Math.max(0, width) / safeScaleX,
        height: Math.max(0, height) / safeScaleY
      };
    }
    async executeValidatedAction(action) {
      const ALLOWED = /* @__PURE__ */ new Set(["click", "scroll", "focus", "select", "wait", "keypress", "type_local"]);
      if (!ALLOWED.has(action.type)) {
        return { success: false, error: "Action type not allowed" };
      }
      if (action.type === "wait") {
        const requested = Number(action.args?.ms);
        const ms = Number.isFinite(requested) ? Math.max(50, Math.min(5e3, Math.round(requested))) : 500;
        await new Promise((r) => setTimeout(r, ms));
        return { success: true };
      }
      if (action.type === "type_local") {
        await this._ensureSecretsLoaded();
        if (!action.args?.secret_ref && (typeof action.args?.text === "string" || typeof action.args?.value === "string")) {
          const textAction = {
            ...action,
            args: {
              ...action.args || {},
              text: action.args?.text ?? action.args?.value
            }
          };
          return this._executeTypeText(textAction);
        }
        return this._executeTypeLocal(action);
      }
      const selector = action.type === "keypress" && !String(action.target || "").trim() ? "" : ActionExecutor.selectorForTarget(action.target);
      if (!selector && !["scroll", "keypress"].includes(action.type)) {
        return { success: false, error: "No target specified" };
      }
      const executionTarget = action.type === "keypress" && !String(action.target || "").trim() ? "" : selector || "body";
      return this.executor.execute(action.type, executionTarget, action.args || {});
    }
    /** Normalize backend secret_ref values (password / PASSWORD_1 / [PASSWORD_1]). */
    _normalizeSecretRef(ref) {
      if (!ref || typeof ref !== "string") return null;
      const cleaned = ref.trim().replace(/^\[|\]$/g, "");
      const lower = cleaned.toLowerCase();
      const base = lower.replace(/_\d+$/, "");
      if (["email", "phone", "username", "password"].includes(base)) return base;
      return lower;
    }
    async _ensureSecretsLoaded() {
      if (this._secretsLoaded) return;
      this._secretsLoaded = true;
      try {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
          const data = await chrome.storage.local.get(["pva_secrets"]);
          const secrets = data.pva_secrets || {};
          for (const [key, value] of Object.entries(secrets)) {
            if (typeof value === "string" && value.length > 0) {
              try {
                this.secretProvider.set(key, value);
              } catch (_) {
              }
            }
          }
        }
      } catch (_) {
      }
    }
    /** Apply secrets from a SET_SECRETS message (in-memory + optional persist). */
    setSecrets(secrets, persist = true) {
      if (!secrets || typeof secrets !== "object") return;
      for (const [key, value] of Object.entries(secrets)) {
        if (typeof value === "string" && value.length > 0) {
          try {
            this.secretProvider.set(key, value);
          } catch (_) {
          }
        }
      }
      this._secretsLoaded = true;
      if (persist && typeof chrome !== "undefined" && chrome.storage?.local) {
        chrome.storage.local.get(["pva_secrets"], (data) => {
          const merged = { ...data.pva_secrets || {}, ...secrets };
          chrome.storage.local.set({ pva_secrets: merged });
        });
      }
    }
    _isPasswordTarget(element) {
      if (!element) return false;
      const type = String(element.type || "").toLowerCase();
      const autocomplete = String(element.getAttribute?.("autocomplete") || "").toLowerCase();
      const identity = [
        element.id,
        element.name,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("placeholder"),
        element.labels?.[0]?.textContent,
        element.textContent
      ].filter(Boolean).join(" ").toLowerCase();
      return type === "password" || autocomplete === "current-password" || autocomplete === "new-password" || /(^|[-_ ])(password|passwd|pwd)([-_ ]|$)/i.test(identity) || /password|passwd|pwd/i.test(identity);
    }
    _isIdentityTarget(element) {
      if (!element) return false;
      const type = String(element.type || "").toLowerCase();
      const autocomplete = String(element.getAttribute?.("autocomplete") || "").toLowerCase();
      const identity = [
        element.id,
        element.name,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("placeholder"),
        element.getAttribute?.("title"),
        element.getAttribute?.("data-testid"),
        element.labels?.[0]?.textContent
      ].filter(Boolean).join(" ").toLowerCase();
      return ["email", "tel", "url"].includes(type) || ["email", "username", "tel", "search", "current-password", "new-password"].includes(autocomplete) || /\b(?:e[-\s]?mail|username|user\s*name|user\s*id|account|login|log\s*in|sign\s*in|credential|phone|telephone)\b/.test(identity);
    }
    _isContentEditable(element) {
      const tag = element?.tagName?.toLowerCase();
      if (["input", "textarea", "select", "button", "a"].includes(tag)) return false;
      const raw = element?.getAttribute?.("contenteditable");
      if (raw !== null && raw !== void 0) {
        const value = String(raw).toLowerCase();
        return value === "" || value === "true" || value === "plaintext-only";
      }
      const ancestor = element?.closest?.("[contenteditable]");
      if (ancestor && ancestor !== element) {
        const value = String(ancestor.getAttribute("contenteditable") || "").toLowerCase();
        return value === "" || value === "true" || value === "plaintext-only";
      }
      return false;
    }
    _isTextInput(element, { allowPassword = false } = {}) {
      const tag = element?.tagName?.toLowerCase();
      if (tag === "textarea" || this._isContentEditable(element)) return true;
      if (tag !== "input") return false;
      const type = String(element.type || "text").toLowerCase();
      if (type === "password") return allowPassword;
      return ["text", "search", "email", "url", "tel", "number"].includes(type);
    }
    _prepareEditable(element, secretRef = null) {
      if (!element) return { valid: false, reason: "Element not found" };
      const allowPassword = secretRef === "password";
      if (!this._isTextInput(element, { allowPassword })) {
        return { valid: false, reason: "Target must be an editable text control" };
      }
      if (element.disabled || element.getAttribute?.("aria-disabled") === "true") {
        return { valid: false, reason: "Target is disabled" };
      }
      if (element.readOnly || element.getAttribute?.("aria-readonly") === "true") {
        return { valid: false, reason: "Target is read-only" };
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { valid: false, reason: "Target is not visible" };
      let style;
      try {
        style = window.getComputedStyle(element);
      } catch (_) {
        style = null;
      }
      if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
        return { valid: false, reason: "Target is not visible" };
      }
      if (secretRef) {
        const validation = LocalSecretProvider.validateTarget(element, secretRef);
        if (!validation.valid) return validation;
      }
      try {
        element.focus();
      } catch (_) {
      }
      if (document.activeElement !== element) return { valid: false, reason: "Target did not become active" };
      return { valid: true };
    }
    _readEditableText(element) {
      if (this._isContentEditable(element)) {
        return String(element.innerText || element.textContent || "");
      }
      return String(element.value ?? "");
    }
    _verifyEditableText(element, expected) {
      const normalize = (value) => String(value || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
      const wanted = normalize(expected);
      if (!wanted) return false;
      const candidates = [
        this._readEditableText(element),
        element?.textContent,
        element?.innerText,
        element?.value
      ];
      return candidates.some((value) => normalize(value).includes(wanted));
    }
    _replaceEditableWithoutInput(element, value) {
      if (this._isContentEditable(element)) {
        element.textContent = String(value);
      } else {
        const view = element.ownerDocument?.defaultView || window;
        const isTextarea = element.tagName?.toLowerCase() === "textarea";
        const prototype = isTextarea ? view.HTMLTextAreaElement?.prototype : view.HTMLInputElement?.prototype;
        const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : null;
        if (setter) setter.call(element, String(value));
        else element.value = String(value);
      }
      const EventCtor = element.ownerDocument?.defaultView?.Event || Event;
      element.dispatchEvent(new EventCtor("change", { bubbles: true }));
    }
    _executeTypeText(action) {
      const selector = ActionExecutor.selectorForTarget(action.target);
      if (!selector) return { success: false, error: "No target specified" };
      let element;
      try {
        element = document.querySelector(selector);
      } catch (_) {
        return { success: false, error: "Invalid selector" };
      }
      if (!element) return { success: false, error: "Element not found" };
      if (this._isPasswordTarget(element)) {
        return { success: false, error: "Use secret_ref for password fields" };
      }
      if (this._isIdentityTarget(element)) {
        return { success: false, error: "Use secret_ref for identity fields" };
      }
      const prepared = this._prepareEditable(element);
      if (!prepared.valid) return { success: false, error: prepared.reason };
      const value = String(action.args?.text ?? action.args?.value ?? "");
      if (value.length > 2e3) return { success: false, error: "Text is too long" };
      const normalize = (text2) => String(text2 || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
      const actual = normalize(this._readEditableText(element));
      const wanted = normalize(value);
      const fingerprint = textFingerprint(value);
      const recent = this._recentTypeWrites.get(element);
      if (recent && recent.fingerprint === fingerprint && Date.now() - recent.at < 1500 && (!actual || actual === wanted)) {
        return { success: true, verified: true, idempotent: true };
      }
      if (wanted && actual === wanted) {
        this._recentTypeWrites.set(element, { fingerprint, at: Date.now() });
        return { success: true, verified: true, idempotent: true };
      }
      const repeated = Boolean(wanted) && (actual === wanted + wanted || actual === `${wanted} ${wanted}`);
      LocalSecretProvider.insertSecret(element, value, {
        blur: false,
        // Ordinary message/task text uses one input event. A synthetic
        // beforeinput followed by input can be interpreted as two inserts
        // by controlled editors.
        beforeinput: false
      });
      const afterInsert = normalize(this._readEditableText(element));
      const duplicatedAfterInsert = Boolean(wanted) && (afterInsert === wanted + wanted || afterInsert === `${wanted} ${wanted}`);
      if (duplicatedAfterInsert) {
        this._replaceEditableWithoutInput(element, value);
      }
      this._recentTypeWrites.set(element, { fingerprint, at: Date.now() });
      if (!this._verifyEditableText(element, value)) {
        if (this._isContentEditable(element)) {
          return { success: true, verified: true, inferred: true };
        }
        this._recentTypeWrites.delete(element);
        return { success: false, error: "Text could not be verified", verified: false };
      }
      return { success: true, verified: true, idempotent: repeated };
    }
    _executeTypeLocal(action) {
      const secretRef = this._normalizeSecretRef(action.args?.secret_ref);
      if (!secretRef) return { success: false, error: "Missing local secret reference" };
      if (!this.secretProvider.has(secretRef)) {
        return { success: false, error: "Local email/password is not configured in the extension popup" };
      }
      const selector = ActionExecutor.selectorForTarget(action.target);
      if (!selector) return { success: false, error: "No target specified" };
      let element;
      try {
        element = document.querySelector(selector);
      } catch (_) {
        return { success: false, error: "Invalid selector" };
      }
      const prepared = this._prepareEditable(element, secretRef);
      if (!prepared.valid) return { success: false, error: prepared.reason };
      const value = this.secretProvider.get(secretRef);
      if (!value) return { success: false, error: "Secret not available" };
      LocalSecretProvider.insertSecret(element, value, { blur: false });
      return { success: true, verified: true };
    }
    async _preprocessImage(dataUri) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };
        const timeout = setTimeout(() => {
          finish(reject, new Error("Screenshot preprocessing timed out"));
        }, 15e3);
        img.onload = () => {
          try {
            const MAX_WIDTH = 1920;
            let w = img.width, h = img.height;
            if (w <= 0 || h <= 0) throw new Error("Screenshot has no dimensions");
            if (w > MAX_WIDTH) {
              h = Math.floor(h * MAX_WIDTH / w);
              w = MAX_WIDTH;
            }
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            clearTimeout(timeout);
            finish(resolve, canvas);
          } catch (e) {
            clearTimeout(timeout);
            finish(reject, e);
          }
        };
        img.onerror = () => {
          clearTimeout(timeout);
          finish(reject, new Error("Screenshot could not be decoded"));
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
  function safePreviewDetection(detection) {
    const bbox = detection?.bbox || {};
    return {
      type: String(detection?.type || "UNKNOWN").slice(0, 40),
      token: String(detection?.token || "").slice(0, 80),
      confidence: Number.isFinite(Number(detection?.confidence)) ? Number(detection.confidence) : 0,
      bbox: {
        x: Number(bbox.x) || 0,
        y: Number(bbox.y) || 0,
        width: Number(bbox.width) || 0,
        height: Number(bbox.height) || 0
      }
    };
  }
  var CONTENT_HANDLER_KEY = "__PVA_CONTENT_HANDLERS_V3__";
  var previousHandlers = globalThis[CONTENT_HANDLER_KEY];
  if (previousHandlers?.runtimeListener) {
    try {
      chrome.runtime.onMessage.removeListener(previousHandlers.runtimeListener);
    } catch (_) {
    }
  }
  if (previousHandlers?.windowListener) {
    try {
      window.removeEventListener("message", previousHandlers.windowListener);
    } catch (_) {
    }
  }
  var runtimeListener = (request, sender, sendResponse) => {
    if (request.type === "ANALYZE_DOM") {
      logger2.info("Analyzing DOM");
      const elements = analyzer.analyzeDOM();
      sendResponse({
        elements,
        // Local-only route fingerprint; query strings and page text are
        // intentionally excluded from this action-layer signal.
        route: `${window.location.origin}${window.location.pathname}`
      });
      return false;
    }
    if (request.type === "OCR_RUNTIME_STATUS") {
      sendResponse({
        available: typeof globalThis.Tesseract?.createWorker === "function"
      });
      return false;
    }
    if (request.type === "EXECUTE_ACTION") {
      logger2.info("Executing action", { type: request.actionType });
      const selector = ActionExecutor.selectorForTarget(request.target);
      sendResponse(executor.execute(request.actionType, selector, request.args));
      return false;
    }
    if (request.type === "SET_SECRETS") {
      pipeline.setSecrets(request.secrets || {}, request.persist !== false);
      sendResponse({ ok: true });
      return false;
    }
    if (request.type === "LOCAL_VISION_OBSERVE") {
      pipeline.observeForLocalVision().then(sendResponse).catch(() => {
        sendResponse({ error: "LOCAL_VISION_CAPTURE_UNAVAILABLE" });
      });
      return true;
    }
    if (request.type === "PRIVACY_PIPELINE") {
      pipeline.run().then(sendResponse).catch((e) => {
        logger2.error("Pipeline failed: " + e.message);
        sendResponse({ allowed: false, violations: [e.message] });
      });
      return true;
    }
    if (request.type === "PRIVACY_PREVIEW") {
      pipeline.run().then((result) => {
        sendResponse({
          allowed: !!result?.allowed,
          violations: Array.isArray(result?.violations) ? result.violations.slice(0, 10) : [],
          detections: Array.isArray(result?.redactionPlan) ? result.redactionPlan.slice(0, 200).map(safePreviewDetection) : [],
          screenshot: typeof result?.sanitizedContext?.image === "string" ? result.sanitizedContext.image : null,
          timing: result?.timing || {}
        });
      }).catch(() => {
        sendResponse({
          allowed: false,
          violations: ["Privacy preview unavailable"],
          detections: [],
          screenshot: null,
          timing: {}
        });
      });
      return true;
    }
    if (request.type === "EXECUTE_VALIDATED_ACTION") {
      pipeline.executeValidatedAction(request.action).then(sendResponse).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }
    return false;
  };
  var windowListener = (event) => {
    if (event.source !== window || !event.data) return;
    const localTestPage = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
    if (!localTestPage) return;
    if (event.data.type === "AGENT_TEST_TRIGGER") {
      const message = event.data.goal ? { type: "START_GOAL_AGENT", goal: String(event.data.goal).slice(0, 500) } : { type: "START_AGENT" };
      chrome.runtime.sendMessage(message);
    }
    if (event.data.type === "AGENT_SET_SECRETS" && event.data.secrets) {
      pipeline.setSecrets(event.data.secrets, false);
    }
  };
  globalThis[CONTENT_HANDLER_KEY] = { runtimeListener, windowListener };
  chrome.runtime.onMessage.addListener(runtimeListener);
  window.addEventListener("message", windowListener);
})();
