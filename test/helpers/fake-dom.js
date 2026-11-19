/**
 * Testler için minik DOM taklidi.
 *
 * `meet-adapter.js` dosyasının kullandığı yüzeyi taklit eder:
 *   element : metin, sınıf, nitelik, seçici eşleme, klonlama, silme
 *   document: querySelector, querySelectorAll, title, location
 *
 * Genel amaçlı bir DOM kütüphanesi DEĞİLDİR; npm bağımlılığı yoktur.
 * Desteklenen CSS alt kümesi:
 *   tag, .sınıf, #id, [nitelik], [nitelik="değer"], [nitelik*="değer" i],
 *   [nitelik^="değer"], [nitelik$="değer"], [nitelik~="değer"],
 *   bileşik (tag.sınıf), alt öğe (boşluk), çocuk (>) ve virgüllü liste.
 */
'use strict';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;

/** Sınıf adlarını tek biçime getirir. */
function normalizeClasses(value) {
  if (!value) {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter(Boolean)
    .map((item) => String(item).trim())
    .filter(Boolean);
}

/** Virgüllü seçici listesini böler (köşeli parantez içi virgüller korunur). */
function splitSelectorList(selector) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  const text = String(selector);
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

/** Nitelik seçicisini ayrıştırır: [ad], [ad="değer"], [ad*="değer" i] ... */
function parseAttribute(raw) {
  const inner = raw.slice(1, -1);
  const match = inner.match(
    /^\s*([^\s~^$*|=\]]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(i|I)?\s*)?$/
  );
  if (!match) {
    throw new Error('Geçersiz nitelik seçicisi: ' + raw);
  }
  let value = null;
  if (match[3] !== undefined) {
    value = match[3];
  } else if (match[4] !== undefined) {
    value = match[4];
  } else if (match[5] !== undefined) {
    value = match[5];
  }
  return {
    name: match[1],
    op: match[2] || null,
    value: value,
    insensitive: Boolean(match[6]),
  };
}

/** Bileşik seçiciyi ayrıştırır: "div.aarpc", '[role="region"]' ... */
function parseCompound(text) {
  const spec = { tag: null, id: null, classes: [], attrs: [] };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '*') {
      i += 1;
      continue;
    }
    if (ch === '.' || ch === '#') {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_-]/.test(text[j])) {
        j += 1;
      }
      const name = text.slice(i + 1, j);
      if (!name) {
        throw new Error('Geçersiz seçici: ' + text);
      }
      if (ch === '.') {
        spec.classes.push(name);
      } else {
        spec.id = name;
      }
      i = j;
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      let quote = null;
      while (j < text.length) {
        const c = text[j];
        if (quote) {
          if (c === quote) {
            quote = null;
          }
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === ']') {
          break;
        }
        j += 1;
      }
      if (j >= text.length) {
        throw new Error('Kapatılmamış nitelik seçicisi: ' + text);
      }
      spec.attrs.push(parseAttribute(text.slice(i, j + 1)));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && /[A-Za-z0-9_-]/.test(text[j])) {
      j += 1;
    }
    if (j === i) {
      throw new Error('Geçersiz seçici: ' + text);
    }
    spec.tag = text.slice(i, j).toUpperCase();
    i = j;
  }
  return spec;
}

/**
 * Seçiciyi belirteçlere ayırır:
 *   [{type:'compound'}, {type:'combinator', value:' '|'>'}, ...]
 */
function parseComplex(selector) {
  const tokens = [];
  let current = '';
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) {
      tokens.push({ type: 'compound', spec: parseCompound(trimmed) });
    }
    current = '';
  };
  let i = 0;
  const text = String(selector);
  while (i < text.length) {
    const ch = text[i];
    if (ch === '[') {
      let j = i + 1;
      let quote = null;
      while (j < text.length) {
        const c = text[j];
        if (quote) {
          if (c === quote) {
            quote = null;
          }
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === ']') {
          break;
        }
        j += 1;
      }
      if (j >= text.length) {
        throw new Error('Kapatılmamış nitelik seçicisi: ' + text);
      }
      current += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '.') {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_-]/.test(text[j])) {
        j += 1;
      }
      current += text.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '#') {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_-]/.test(text[j])) {
        j += 1;
      }
      current += text.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '>') {
      flush();
      tokens.push({ type: 'combinator', value: '>' });
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      let k = i;
      while (k < text.length && /\s/.test(text[k])) {
        k += 1;
      }
      if (text[k] === '>') {
        i = k;
        continue;
      }
      tokens.push({ type: 'combinator', value: ' ' });
      i = k;
      continue;
    }
    current += ch;
    i += 1;
  }
  flush();
  if (!tokens.length) {
    throw new Error('Boş seçici');
  }
  return tokens;
}

/** Seçiciyi ayrıştırır (geçerlilik denetimi için dışa açılır). */
function parseSelector(selector) {
  return splitSelectorList(selector).map((part) => parseComplex(part));
}

/** Bileşik seçici ölçütü sağlanıyor mu? */
function matchCompound(element, spec) {
  if (!element || element.nodeType !== ELEMENT_NODE) {
    return false;
  }
  if (spec.tag && element.tagName !== spec.tag) {
    return false;
  }
  if (spec.id && element.getAttribute('id') !== spec.id) {
    return false;
  }
  for (const cls of spec.classes) {
    if (element.classes.indexOf(cls) === -1) {
      return false;
    }
  }
  for (const attr of spec.attrs) {
    const value = element.getAttribute(attr.name);
    if (value === null) {
      return false;
    }
    let haystack = value;
    let needle = attr.value === null ? '' : attr.value;
    if (attr.insensitive) {
      haystack = haystack.toLowerCase();
      needle = needle.toLowerCase();
    }
    if (attr.op === null) {
      continue;
    }
    if (attr.op === '=' && haystack !== needle) {
      return false;
    }
    if (attr.op === '*=' && haystack.indexOf(needle) === -1) {
      return false;
    }
    if (attr.op === '^=' && haystack.slice(0, needle.length) !== needle) {
      return false;
    }
    if (attr.op === '$=' && haystack.slice(-needle.length) !== needle) {
      return false;
    }
    if (attr.op === '~=' && haystack.split(/\s+/).indexOf(needle) === -1) {
      return false;
    }
  }
  return true;
}

/** Seçicinin sol tarafını (üst öğe zinciri) eşleştirir. */
function matchAncestors(node, tokens, index) {
  if (index < 0) {
    return true;
  }
  const combinator = tokens[index].value;
  const compound = tokens[index - 1].spec;
  if (combinator === '>') {
    const parent = node.parentElement;
    if (!parent || !matchCompound(parent, compound)) {
      return false;
    }
    return matchAncestors(parent, tokens, index - 2);
  }
  let ancestor = node.parentElement;
  while (ancestor) {
    if (
      matchCompound(ancestor, compound) &&
      matchAncestors(ancestor, tokens, index - 2)
    ) {
      return true;
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

/** Bir düğüm verilen seçicilerden herhangi birini karşılıyor mu? */
function matches(element, selector) {
  const list = splitSelectorList(selector);
  for (const part of list) {
    const tokens = parseComplex(part);
    const lastIndex = tokens.length - 1;
    if (
      matchCompound(element, tokens[lastIndex].spec) &&
      matchAncestors(element, tokens, lastIndex - 1)
    ) {
      return true;
    }
  }
  return false;
}

/** Metin düğümü (nodeType 3). */
function FakeText(data) {
  this.nodeType = TEXT_NODE;
  this.data = String(data);
  this.parentElement = null;
  this.ownerDocument = null;
}
Object.defineProperty(FakeText.prototype, 'textContent', {
  get() {
    return this.data;
  },
});
FakeText.prototype.remove = function remove() {
  if (this.parentElement) {
    this.parentElement.removeChild(this);
  }
};
FakeText.prototype.cloneNode = function cloneNode() {
  return new FakeText(this.data);
};

/** Element düğümü (nodeType 1). */
function FakeElement(spec) {
  const s = spec || {};
  this.nodeType = ELEMENT_NODE;
  this.tagName = String(s.tag || 'div').toUpperCase();
  this.classes = normalizeClasses(s.cls);
  this.attributes = {};
  this.childNodes = [];
  this.parentElement = null;
  this.ownerDocument = null;

  const attrs = s.attrs || {};
  Object.keys(attrs).forEach((key) => {
    this.attributes[key] = String(attrs[key]);
  });
  if (s.text !== undefined && s.text !== null && s.text !== '') {
    this.appendChild(new FakeText(s.text));
  }
  (s.children || []).forEach((child) => {
    this.appendChild(typeof child === 'string' ? new FakeText(child) : child);
  });
}

Object.defineProperty(FakeElement.prototype, 'className', {
  get() {
    return this.classes.join(' ');
  },
});
Object.defineProperty(FakeElement.prototype, 'classList', {
  get() {
    return this.classes.slice();
  },
});
Object.defineProperty(FakeElement.prototype, 'textContent', {
  get() {
    return this.childNodes.map((child) => child.textContent).join('');
  },
});
Object.defineProperty(FakeElement.prototype, 'children', {
  get() {
    return this.childNodes.filter((child) => child.nodeType === ELEMENT_NODE);
  },
});
Object.defineProperty(FakeElement.prototype, 'isConnected', {
  get() {
    let node = this;
    while (node) {
      if (node.nodeType === DOCUMENT_NODE) {
        return true;
      }
      if (node.parentElement) {
        node = node.parentElement;
        continue;
      }
      if (node.ownerDocument && node.ownerDocument.documentElement === node) {
        return true;
      }
      return false;
    }
    return false;
  },
});

FakeElement.prototype.getAttribute = function getAttribute(name) {
  const value = this.attributes[name];
  return value === undefined ? null : value;
};
FakeElement.prototype.setAttribute = function setAttribute(name, value) {
  this.attributes[name] = String(value);
};
FakeElement.prototype.hasAttribute = function hasAttribute(name) {
  return Object.prototype.hasOwnProperty.call(this.attributes, name);
};
FakeElement.prototype.appendChild = function appendChild(child) {
  if (child.parentElement) {
    child.parentElement.removeChild(child);
  }
  child.parentElement = this;
  if (!child.ownerDocument) {
    child.ownerDocument = this.ownerDocument;
  }
  this.childNodes.push(child);
  return child;
};
FakeElement.prototype.removeChild = function removeChild(child) {
  const index = this.childNodes.indexOf(child);
  if (index >= 0) {
    this.childNodes.splice(index, 1);
    child.parentElement = null;
  }
  return child;
};
FakeElement.prototype.remove = function remove() {
  if (this.parentElement) {
    this.parentElement.removeChild(this);
  }
};
FakeElement.prototype.contains = function contains(node) {
  let current = node;
  while (current) {
    if (current === this) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
};
FakeElement.prototype.matches = function matchesSelector(selector) {
  return matches(this, selector);
};
FakeElement.prototype.querySelectorAll = function querySelectorAll(selector) {
  return collectDescendants(this).filter((node) => matches(node, selector));
};
FakeElement.prototype.querySelector = function querySelector(selector) {
  const found = this.querySelectorAll(selector);
  return found.length ? found[0] : null;
};
FakeElement.prototype.cloneNode = function cloneNode(deep) {
  const clone = new FakeElement({ tag: this.tagName.toLowerCase() });
  clone.classes = this.classes.slice();
  Object.keys(this.attributes).forEach((key) => {
    clone.attributes[key] = this.attributes[key];
  });
  if (deep !== false) {
    this.childNodes.forEach((child) => {
      clone.appendChild(child.cloneNode(true));
    });
  }
  return clone;
};

/** Alt öğeleri belge sırasıyla toplar (yalnızca elementler). */
function collectDescendants(node) {
  const out = [];
  const walk = (current) => {
    (current.childNodes || []).forEach((child) => {
      if (child.nodeType === ELEMENT_NODE) {
        out.push(child);
        walk(child);
      }
    });
  };
  walk(node);
  return out;
}

/**
 * Element kurar.
 * @param {{tag?:string, cls?:string|string[], attrs?:object, text?:string,
 *          children?:Array}} spec
 */
function el(spec) {
  return new FakeElement(spec || {});
}

/**
 * Belge kurar (body içine çocuklar yerleştirilir).
 * @param {{title?:string, location?:object, children?:Array, parent?:string}} spec
 */
function doc(spec) {
  const s = spec || {};
  const documentElement = new FakeElement({ tag: 'html' });
  const body = new FakeElement({ tag: 'body' });
  documentElement.appendChild(body);

  const document = {
    nodeType: DOCUMENT_NODE,
    title: s.title || '',
    location: s.location || { href: '' },
    documentElement: documentElement,
    body: body,
    createElement: function createElement(tag) {
      return new FakeElement({ tag: tag });
    },
    querySelectorAll: function querySelectorAll(selector) {
      const scope = [documentElement].concat(collectDescendants(documentElement));
      return scope.filter((node) => matches(node, selector));
    },
    querySelector: function querySelector(selector) {
      const found = document.querySelectorAll(selector);
      return found.length ? found[0] : null;
    },
  };

  documentElement.ownerDocument = document;
  body.ownerDocument = document;

  const target = s.parent === 'html' ? documentElement : body;
  (s.children || []).forEach((child) => {
    const node = typeof child === 'string' ? new FakeText(child) : child;
    target.appendChild(node);
    node.ownerDocument = document;
  });

  return document;
}

module.exports = {
  el: el,
  doc: doc,
  matches: matches,
  parseSelector: parseSelector,
};
