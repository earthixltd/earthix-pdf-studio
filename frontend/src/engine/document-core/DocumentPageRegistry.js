import { PdfEngineError } from "../engineErrors.js";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function normalizePageDescriptor(index, descriptor = {}) {
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor)
  ) {
    throw new PdfEngineError(`Page ${index + 1} has an invalid descriptor.`, {
      code: "INVALID_PAGE_DESCRIPTOR",
    });
  }
  const width = descriptor.width ?? null;
  const height = descriptor.height ?? null;
  const rotation = descriptor.rotation ?? 0;
  if (width !== null && (!Number.isFinite(width) || width <= 0)) {
    throw new PdfEngineError(`Page ${index + 1} has an invalid width.`, {
      code: "INVALID_PAGE_DIMENSIONS",
    });
  }
  if (height !== null && (!Number.isFinite(height) || height <= 0)) {
    throw new PdfEngineError(`Page ${index + 1} has an invalid height.`, {
      code: "INVALID_PAGE_DIMENSIONS",
    });
  }
  if (!Number.isInteger(rotation) || rotation % 90 !== 0) {
    throw new PdfEngineError(
      `Page ${index + 1} rotation must be a multiple of 90 degrees.`,
      { code: "INVALID_PAGE_ROTATION" },
    );
  }
  const id =
    typeof descriptor.id === "string" && descriptor.id.trim()
      ? descriptor.id.trim()
      : `page:${index}`;
  return {
    ...clone(descriptor),
    id,
    index,
    pageNumber: index + 1,
    width,
    height,
    rotation: ((rotation % 360) + 360) % 360,
  };
}

export class DocumentPageRegistry {
  #pages = [];

  constructor(pageCount = 0, descriptors = []) {
    this.reset(pageCount, descriptors);
  }

  reset(pageCount, descriptors = []) {
    if (!Number.isInteger(pageCount) || pageCount < 0) {
      throw new PdfEngineError("Page count must be a non-negative integer.", {
        code: "INVALID_PAGE_COUNT",
      });
    }
    if (!Array.isArray(descriptors)) {
      throw new PdfEngineError("Page descriptors must be an array.", {
        code: "INVALID_PAGE_DESCRIPTORS",
      });
    }
    const descriptorMap = new Map();
    for (const descriptor of descriptors) {
      if (
        !Number.isInteger(descriptor?.index) ||
        descriptor.index < 0 ||
        descriptor.index >= pageCount
      ) {
        throw new PdfEngineError(
          "A page descriptor references an invalid index.",
          { code: "INVALID_PAGE_DESCRIPTOR" },
        );
      }
      if (descriptorMap.has(descriptor.index)) {
        throw new PdfEngineError(
          `Page index ${descriptor.index} has duplicate descriptors.`,
          { code: "DUPLICATE_PAGE_DESCRIPTOR" },
        );
      }
      descriptorMap.set(descriptor.index, descriptor);
    }
    const nextPages = Array.from({ length: pageCount }, (_, index) =>
      normalizePageDescriptor(index, descriptorMap.get(index)),
    );
    const ids = new Set();
    for (const page of nextPages) {
      if (ids.has(page.id))
        throw new PdfEngineError(`Duplicate page id "${page.id}".`, {
          code: "DUPLICATE_PAGE_ID",
        });
      ids.add(page.id);
    }
    this.#pages = nextPages;
  }

  get count() {
    return this.#pages.length;
  }

  get(index) {
    return clone(this.#pages[index] || null);
  }

  getById(id) {
    return clone(this.#pages.find((page) => page.id === id) || null);
  }

  indexOf(id) {
    return this.#pages.findIndex((page) => page.id === id);
  }

  list() {
    return clone(this.#pages);
  }

  updateInfo(index, info = {}) {
    const page = this.#pages[index];
    if (!page)
      throw new PdfEngineError(`Page ${index + 1} does not exist.`, {
        code: "PAGE_NOT_FOUND",
      });
    if (!info || typeof info !== "object" || Array.isArray(info)) {
      throw new PdfEngineError("Page information must be an object.", {
        code: "INVALID_PAGE_INFO",
      });
    }
    const safeInfo = { ...info };
    delete safeInfo.id;
    delete safeInfo.index;
    delete safeInfo.pageNumber;
    const normalized = normalizePageDescriptor(index, { ...page, ...safeInfo });
    this.#pages[index] = normalized;
    return this.get(index);
  }

  reorder(order) {
    if (!Array.isArray(order) || order.length !== this.#pages.length) {
      throw new PdfEngineError(
        "Page order must include every page exactly once.",
        { code: "INVALID_PAGE_ORDER" },
      );
    }
    const seen = new Set();
    const nextPages = order.map((sourceIndex, targetIndex) => {
      if (
        !Number.isInteger(sourceIndex) ||
        sourceIndex < 0 ||
        sourceIndex >= this.#pages.length ||
        seen.has(sourceIndex)
      ) {
        throw new PdfEngineError(
          "Page order contains an invalid or duplicate source index.",
          { code: "INVALID_PAGE_ORDER" },
        );
      }
      seen.add(sourceIndex);
      return normalizePageDescriptor(targetIndex, this.#pages[sourceIndex]);
    });
    this.#pages = nextPages;
    return this.list();
  }

  snapshot() {
    return this.list();
  }

  restore(pages = []) {
    if (!Array.isArray(pages))
      throw new PdfEngineError("Page snapshots must be an array.", {
        code: "INVALID_PAGE_DESCRIPTORS",
      });
    const sorted = pages.map((page, index) => ({
      ...page,
      index: Number.isInteger(page?.index) ? page.index : index,
    }));
    const byIndex = sorted.sort((left, right) => left.index - right.index);
    this.reset(pages.length, byIndex);
  }
}
