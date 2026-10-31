// Runs on every page. On clothing shops it shows a "Try On" button over product pictures
// and opens the try-on widget in the corner of the page.
(() => {
  if (window.top !== window) return;

  const WIDGET_PAGE = chrome.runtime.getURL("widget.html");
  const WIDGET_ORIGIN = new URL(WIDGET_PAGE).origin;

  // ---------- is this a clothing shop? ----------
  const SHOPS =
    /(^|\.)(zara|hm|uniqlo|asos|zalando|nike|adidas|puma|shein|mango|gap|levi|next|myntra|ajio|nykaafashion|tatacliq|amazon|flipkart|meesho|vinted|farfetch|ssense|revolve|urbanoutfitters|abercrombie|hollisterco|ae|pullandbear|bershka|stradivarius|massimodutti|cosstores|arket|primark|boohoo|prettylittlething|nordstrom|macys|musinsa|uniqlo|everlane|lululemon|gymshark|snitch|bewakoof|souledstore|westside|maxfashion|fabindia)\.[a-z.]+$/i;
  const NOT_SHOPS = /(^|\.)(google|youtube|github|reddit|wikipedia|stackoverflow|twitter|x|facebook|linkedin|instagram|ikea|netflix|localhost)\.[a-z.]+$/i;
  const PLATFORM = /cdn\.shopify\.com|demandware|woocommerce|Magento_|bigcommerce|salesforce-commerce/i;
  const CLOTHES = /\b(dress(es)?|jeans|t-?shirts?|shirts?|tops|hoodies?|jackets?|coats?|sweaters?|trousers|skirts?|kurtas?|sarees?|blazers?|shorts)\b/gi;

  function isFashionSite() {
    const host = location.hostname;
    if (NOT_SHOPS.test(host)) return false;
    if (SHOPS.test(host)) return true;
    const head = document.head?.innerHTML || "";
    const text = `${document.title} ${document.body?.textContent?.slice(0, 30000) || ""}`;
    const clothingWords = new Set((text.match(CLOTHES) || []).map((w) => w.toLowerCase())).size;
    const shopWords = /add to (bag|cart|basket)|size guide|select size/i.test(text);
    return (PLATFORM.test(head) || shopWords) && clothingWords >= 2;
  }

  // ---------- what kind of item is it? ----------
  const CATEGORIES = [
    ["dress", /\b(dress(es)?|gown|jumpsuit|playsuit|romper|saree|sari|lehenga)\b/i],
    ["outerwear", /\b(jacket|coat|blazer|parka|puffer|bomber|trench|gilet|cardigan|overshirt)s?\b/i],
    ["bottom", /\b(jeans|trousers|pants|shorts|skirts?|leggings|joggers|chinos|cargos?|palazzos?)\b/i],
    ["shoes", /\b(shoes?|sneakers?|trainers?|boots?|sandals?|heels|loafers?|slippers?|flip-?flops?)\b/i],
    ["hat", /\b(hats?|caps?|beanies?|berets?)\b/i],
    ["eyewear", /\b(sunglasses|glasses|eyewear|spectacles)\b/i],
    ["top", /\b(t-?shirts?|tees?|shirts?|tops?|blouses?|hoodies?|sweatshirts?|sweaters?|jumpers?|polos?|tanks?|kurtas?|kurtis?|tunics?)\b/i],
  ];
  function guessCategory(...texts) {
    for (const text of texts) {
      if (!text) continue;
      for (const [cat, re] of CATEGORIES) if (re.test(text)) return cat;
    }
    return "top";
  }

  // ---------- product info from the page's structured data ----------
  function pageProduct() {
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const type = [].concat(node["@type"] || []).join(" ");
      if (/Product/.test(type)) found.push(node);
      if (node["@graph"]) walk(node["@graph"]);
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        walk(JSON.parse(s.textContent));
      } catch {}
    });
    const p = found[0];
    if (!p) return null;
    let image = [].concat(p.image || [])[0];
    if (image && typeof image === "object") image = image.url || image.contentUrl;
    if (!image && p.hasVariant) image = [].concat([].concat(p.hasVariant)[0]?.image || [])[0];
    if (!image) return null;
    const name = String(p.name || document.title);
    const crumbs = document.querySelector('nav[aria-label*="bread" i], [class*="breadcrumb" i]')?.textContent;
    return {
      url: new URL(image, location.href).href,
      title: name,
      category: guessCategory(name, crumbs, location.pathname),
    };
  }

  // ---------- picking the right picture ----------
  // Largest picture from srcset / <picture>, instead of the small one on screen.
  function bestSrc(img) {
    const sets = [img.getAttribute("srcset"), img.dataset.srcset];
    img.closest("picture")?.querySelectorAll("source").forEach((s) => sets.push(s.getAttribute("srcset")));
    let best = img.currentSrc || img.src;
    let bestW = 0;
    for (const set of sets) {
      if (!set) continue;
      for (const part of set.split(/,\s+/)) {
        const [url, size = ""] = part.trim().split(/\s+/);
        const w = parseInt(size, 10) * (size.endsWith("x") ? 1000 : 1) || 1;
        if (url && w > bestW) {
          bestW = w;
          best = url;
        }
      }
    }
    try {
      return new URL(best, location.href).href;
    } catch {
      return img.currentSrc || img.src;
    }
  }

  // Shop grids often swap to a back-view picture on hover; the first big picture in the card is the front.
  function frontImage(img) {
    const card = img.closest("a[href]");
    if (!card) return img;
    const first = [...card.querySelectorAll("img")].find((i) => (i.naturalWidth || i.width) >= 150);
    return first || img;
  }

  function garmentFor(img) {
    const front = frontImage(img);
    const card = img.closest("a[href]");
    const product = pageProduct();
    const title = front.alt || img.alt || card?.textContent?.trim().slice(0, 100) || product?.title || "";
    return {
      url: bestSrc(front),
      title,
      category: guessCategory(title, card?.getAttribute("href"), product?.title, location.pathname),
    };
  }

  // ---------- "Try On" hover button ----------
  let hoverHost, hoverBtn, hoverImg;
  function makeHoverButton() {
    hoverHost = document.createElement("div");
    hoverHost.style.cssText = "position:fixed;z-index:2147483646;display:none;top:0;left:0";
    const shadow = hoverHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      button{font:600 13px/1 system-ui,sans-serif;padding:8px 12px;border:0;border-radius:999px;cursor:pointer;
        background:#111;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.3)}
      button:hover{background:#7c9cff;color:#0b0d12}
    </style><button type="button">Try On</button>`;
    hoverBtn = shadow.querySelector("button");
    hoverBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!extensionAlive()) {
        hoverBtn.textContent = "Refresh page to try on";
        return;
      }
      if (hoverImg) tryOn(garmentFor(hoverImg));
    });
    document.documentElement.appendChild(hoverHost);
  }

  function imageAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === hoverHost || el === frame) return null;
      const img = el.tagName === "IMG" ? el : null;
      if (!img) continue;
      const r = img.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 150) return img;
    }
    return null;
  }

  let raf = 0;
  function onPointerMove(e) {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (hoverHost.contains(e.target) || e.target === hoverHost) return;
      const img = imageAt(e.clientX, e.clientY);
      hoverImg = img;
      if (!img) {
        hoverHost.style.display = "none";
        return;
      }
      const r = img.getBoundingClientRect();
      const x = r.right - 92;
      // top-right corner, unless something (like a sticky header) covers it: then bottom-right, then next to the pointer
      const card = img.closest("a[href]") || img.parentElement;
      const visibleAt = (y) => {
        if (y < 0 || y + 34 > innerHeight) return false;
        const top = document.elementsFromPoint(x + 40, y + 16).find((el) => el !== hoverHost);
        return !!top && (top === img || card.contains(top));
      };
      const y = [r.top + 10, r.bottom - 44].find(visibleAt) ?? e.clientY - 50;
      hoverHost.style.display = "block";
      hoverHost.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    });
  }

  // ---------- the widget iframe ----------
  let frame = null;
  let widgetId = null;
  let ready = false;
  let inWindow = false; // widget moved to its own popup window
  let queue = [];

  function openWidget() {
    if (frame || inWindow) return;
    widgetId = crypto.randomUUID();
    ready = false;
    frame = document.createElement("iframe");
    frame.src = `${WIDGET_PAGE}#id=${widgetId}`;
    frame.allow = "camera";
    frame.title = "Live Try-On";
    setFrameSize(false);
    document.documentElement.appendChild(frame);
  }

  const MARGIN = 20;
  let framePos = null; // {x, y} once the user dragged it; null = pinned bottom-left
  let frameBig = false;
  let frameW = 380;
  let frameH = 600;
  let dragRaf = 0;

  // Position is a GPU transform (no layout), and writes are batched to one per animation frame.
  function paintFrame() {
    dragRaf = 0;
    if (!frame) return;
    const maxX = Math.max(0, innerWidth - frameW);
    const maxY = Math.max(0, innerHeight - frameH);
    const pos = framePos ?? { x: MARGIN, y: innerHeight - frameH - MARGIN };
    pos.x = Math.min(Math.max(0, pos.x), maxX);
    pos.y = Math.min(Math.max(0, pos.y), maxY);
    frame.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
  }

  function schedulePaint() {
    if (!dragRaf) dragRaf = requestAnimationFrame(paintFrame);
  }

  function moveFrame(dx, dy) {
    if (!frame) return;
    if (!framePos) {
      const r = frame.getBoundingClientRect();
      framePos = { x: r.left, y: r.top };
    }
    framePos.x += dx;
    framePos.y += dy;
    schedulePaint();
  }

  function setFrameSize(big) {
    frameBig = big;
    frameW = big ? Math.min(720, innerWidth - 2 * MARGIN) : 380;
    frameH = Math.min(big ? 560 : 600, innerHeight - 2 * MARGIN);
    frame.style.cssText = `position:fixed;left:0;top:0;z-index:2147483647;border:0;border-radius:20px;
      box-shadow:0 24px 60px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.08);color-scheme:normal;background:#0e1014;
      will-change:transform;transition:width .2s ease,height .2s ease;width:${frameW}px;height:${frameH}px`;
    paintFrame();
  }

  window.addEventListener("resize", () => frame && setFrameSize(frameBig));

  function closeWidget() {
    frame?.remove();
    frame = null;
    widgetId = null;
    ready = false;
    queue = [];
    framePos = null;
    frameBig = false;
    cancelAnimationFrame(dragRaf);
    dragRaf = 0;
  }

  // After the extension is reloaded or updated, this old copy of the script loses its link to it
  // and every chrome.runtime call throws. Only a page refresh brings in a working copy.
  function extensionAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function toWidget(msg) {
    const send = () => {
      if (!extensionAlive()) return;
      try {
        chrome.runtime.sendMessage({ ...msg, widgetId }).catch(() => {});
      } catch {}
    };
    if (ready) send();
    else queue.push(send);
  }

  function tryOn(garment) {
    openWidget();
    toWidget({ type: "TRY_ON", garment, cart: !!cartButton() });
  }

  function onWidgetMessage(data) {
    switch (data.type) {
      case "READY": {
        ready = true;
        const product = pageProduct();
        if (product) toWidget({ type: "PAGE_PRODUCT", garment: product, cart: !!cartButton() });
        queue.splice(0).forEach((send) => send());
        break;
      }
      case "CLOSE":
        closeWidget();
        break;
      case "RESIZE":
        if (frame) setFrameSize(data.big);
        break;
      case "DRAG":
        if (Number.isFinite(data.dx) && Number.isFinite(data.dy)) moveFrame(data.dx, data.dy);
        break;
      case "ADD_TO_CART":
        cartButton()?.click();
        break;
      case "MOVED_TO_WINDOW": {
        const id = widgetId;
        frame?.remove();
        frame = null;
        widgetId = id; // the popup window keeps the same id, so messages still reach it
        inWindow = true;
        ready = true;
        break;
      }
      case "WINDOW_CLOSED":
        inWindow = false;
        closeWidget();
        break;
    }
  }

  // Messages from the widget iframe
  window.addEventListener("message", (e) => {
    if (!frame || e.source !== frame.contentWindow || e.origin !== WIDGET_ORIGIN) return;
    if (e.data?.widgetId !== widgetId) return;
    onWidgetMessage(e.data);
  });

  // Messages from the background (toolbar button, popup window)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "TOGGLE") {
      enable();
      if (frame) closeWidget();
      else openWidget();
    } else if (msg?.widgetId && msg.widgetId === widgetId) {
      onWidgetMessage(msg);
    }
  });

  // ---------- add to cart ----------
  const CART_SELECTORS = [
    'form[action*="/cart/add"] [type="submit"]', // Shopify
    ".single_add_to_cart_button", // WooCommerce
    "#product-addtocart-button", // Magento
    "button.add-to-cart", // Salesforce Commerce
    '[data-testid*="add-to-cart" i]',
    '[data-test*="add-to-bag" i]',
  ];
  function cartButton() {
    const visible = (el) => el && el.offsetParent !== null && !el.disabled;
    for (const sel of CART_SELECTORS) {
      const el = [...document.querySelectorAll(sel)].find(visible);
      if (el) return el;
    }
    return [...document.querySelectorAll("button, input[type=submit]")].find(
      (el) => visible(el) && /^\s*(add to (bag|cart|basket)|buy now)\s*$/i.test(el.textContent || el.value || "")
    );
  }

  // ---------- turn on ----------
  let enabled = false;
  function enable() {
    if (enabled) return;
    enabled = true;
    makeHoverButton();
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("scroll", () => (hoverHost.style.display = "none"), { passive: true });
  }

  if (isFashionSite()) enable();
  else setTimeout(() => isFashionSite() && enable(), 3000); // shops that load their content late
})();
