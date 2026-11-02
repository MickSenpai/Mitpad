const MAX_PREVIEW_CHARS = 300_000;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

function hasBytes(offset: number, size: number, length: number) {
  return Number.isSafeInteger(offset) && offset >= 0 && size >= 0 && offset <= length - size;
}

function findZipEnd(view: DataView, bytes: Uint8Array) {
  const min = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (hasBytes(i, 22, bytes.length) && view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error('El archivo no tiene una estructura ZIP válida.');
}

function decodeXml(xml: string) {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

function nodeText(node: Element) {
  return node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

async function zipEntry(buffer: ArrayBuffer, wanted: string): Promise<Uint8Array | null> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const endRecord = findZipEnd(view, bytes);
  const count = view.getUint16(endRecord + 10, true);
  let cursor = view.getUint32(endRecord + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (!hasBytes(cursor, 46, bytes.length)) throw new Error('El índice del documento está dañado.');
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('No se pudo leer el índice del documento.');
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (!hasBytes(cursor + 46, nameLength + extraLength + commentLength, bytes.length)) throw new Error('El índice del documento está dañado.');
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name === wanted) {
      if (uncompressedSize > MAX_ENTRY_BYTES || compressedSize > bytes.length) throw new Error('El contenido es demasiado grande para previsualizarlo.');
      if (!hasBytes(localOffset, 30, bytes.length)) throw new Error('El documento está dañado.');
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('El documento está dañado.');
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      if (!hasBytes(start, compressedSize, bytes.length)) throw new Error('El documento está dañado.');
      const compressed = bytes.subarray(start, start + compressedSize);
      if (method === 0) return compressed.slice();
      if (method !== 8 || typeof DecompressionStream === 'undefined') throw new Error('Este navegador no permite descomprimir el documento para la vista previa.');
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat));
      const reader = stream.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_ENTRY_BYTES) { await reader.cancel(); throw new Error('El contenido es demasiado grande para previsualizarlo.'); }
          parts.push(value);
        }
      } finally { reader.releaseLock(); }
      const output = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
      return output;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function requireXml(bytes: Uint8Array | null, name: string) {
  if (!bytes) throw new Error(`No se encontró ${name} dentro del documento.`);
  const xml = decodeXml(new TextDecoder().decode(bytes));
  if (xml.querySelector('parsererror')) throw new Error('No se pudo interpretar el contenido del documento.');
  return xml;
}

export async function extractDocumentPreview(file: File): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (file.size > 10 * 1024 * 1024) throw new Error('Para cuidar la memoria del navegador, la vista previa está limitada a 10 MB. Descarga el archivo para abrirlo completo.');
  if (['txt', 'csv', 'json', 'rtf'].includes(extension)) {
    const text = await file.text();
    if (extension === 'rtf') return text.replace(/\\'[\da-f]{2}/gi, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '').slice(0, MAX_PREVIEW_CHARS);
    return text.slice(0, MAX_PREVIEW_CHARS);
  }

  const buffer = await file.arrayBuffer();
  if (extension === 'docx') {
    const xml = requireXml(await zipEntry(buffer, 'word/document.xml'), 'el texto principal');
    const paragraphs = Array.from(xml.getElementsByTagNameNS('*', 'p'));
    const result = paragraphs.map(paragraph => Array.from(paragraph.getElementsByTagNameNS('*', 't')).map(nodeText).join('')).filter(Boolean).join('\n\n');
    return result.slice(0, MAX_PREVIEW_CHARS) || 'El documento no contiene texto extraíble.';
  }
  if (extension === 'pptx') {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const decoder = new TextDecoder();
    const names: { name: string; index: number }[] = [];
    const record = findZipEnd(view, bytes);
    let cursor = view.getUint32(record + 16, true);
    const count = view.getUint16(record + 10, true);
    for (let i = 0; i < count; i++) {
      if (!hasBytes(cursor, 46, bytes.length)) throw new Error('El índice del documento está dañado.');
      if (view.getUint32(cursor, true) !== 0x02014b50) break;
      const nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
      if (!hasBytes(cursor + 46, nameLength + extra + comment, bytes.length)) throw new Error('El índice del documento está dañado.');
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      const match = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      if (match) names.push({ name, index: Number(match[1]) });
      cursor += 46 + nameLength + extra + comment;
    }
    names.sort((a, b) => a.index - b.index);
    const slides: string[] = [];
    for (const slide of names.slice(0, 100)) {
      const xml = requireXml(await zipEntry(buffer, slide.name), slide.name);
      const text = Array.from(xml.getElementsByTagNameNS('*', 't')).map(nodeText).filter(Boolean).join(' ');
      if (text) slides.push(`Diapositiva ${slide.index}\n${text}`);
    }
    return slides.join('\n\n').slice(0, MAX_PREVIEW_CHARS) || 'La presentación no contiene texto extraíble.';
  }
  if (['odt', 'ods', 'odp'].includes(extension)) {
    const xml = requireXml(await zipEntry(buffer, 'content.xml'), 'el contenido del documento');
    const paragraphs = Array.from(xml.getElementsByTagNameNS('*', 'p'));
    return paragraphs.map(nodeText).filter(Boolean).join('\n\n').slice(0, MAX_PREVIEW_CHARS) || 'El documento no contiene texto extraíble.';
  }
  if (extension === 'xlsx') {
    const sheet = requireXml(await zipEntry(buffer, 'xl/worksheets/sheet1.xml'), 'la primera hoja');
    const sharedBytes = await zipEntry(buffer, 'xl/sharedStrings.xml');
    const shared = sharedBytes ? Array.from(requireXml(sharedBytes, 'las cadenas compartidas').getElementsByTagNameNS('*', 'si')).map(item => Array.from(item.getElementsByTagNameNS('*', 't')).map(nodeText).join('')) : [];
    const rows = Array.from(sheet.getElementsByTagNameNS('*', 'row'));
    const output = rows.map(row => Array.from(row.getElementsByTagNameNS('*', 'c')).map(cell => {
      const value = cell.getElementsByTagNameNS('*', 'v')[0]?.textContent ?? '';
      return cell.getAttribute('t') === 's' ? shared[Number(value)] ?? '' : cell.getElementsByTagNameNS('*', 't')[0]?.textContent ?? value;
    }).join('\t')).join('\n');
    return output.slice(0, MAX_PREVIEW_CHARS) || 'La hoja no contiene datos en la primera pestaña.';
  }
  throw new Error('Este formato no tiene vista previa local. Descarga el archivo para abrirlo con su aplicación.');
}
