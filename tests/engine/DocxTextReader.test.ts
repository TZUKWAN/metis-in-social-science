/**
 * DocxTextReader — 零依赖 .docx 文本提取测试（场景重构 P1）。
 * 用最小合法 zip（stored + deflate 各一）验证 central directory 定位、
 * 段落还原与实体解码；并验证损坏输入的错误码。
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractParagraphsFromDocumentXml, readDocxText } from '../../engine/io/DocxTextReader.js';

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntrySpec { name: string; content: Buffer; method: 0 | 8 }

/** 构造最小合法 docx zip（local headers + central directory + EOCD）。 */
function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.method === 8 ? deflateRawSync(entry.content) : entry.content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date
    local.writeUInt32LE(crc32(entry.content), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc32(entry.content), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const fakeFs = (archive: Buffer) => ({
  readFileSync: () => archive,
});

describe('DocxTextReader', () => {
  it('解压 deflate 的 word/document.xml 并还原段落', () => {
    const xml = [
      '<w:p><w:r><w:t>研究目标：制度分析</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>证据边界：仅限档案</w:t></w:r><w:r><w:t>与访谈</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>  </w:t></w:r></w:p>',
    ].join('');
    const archive = buildZip([
      { name: '[Content_Types].xml', content: Buffer.from('<types/>'), method: 0 },
      { name: 'word/document.xml', content: Buffer.from(xml, 'utf8'), method: 8 },
    ]);
    const text = readDocxText('ignored.docx', fakeFs(archive));
    expect(text).toBe('研究目标：制度分析\n\n证据边界：仅限档案与访谈');
  });

  it('解码 XML 实体（含数字字符引用）', () => {
    const paragraphs = extractParagraphsFromDocumentXml('<w:p><w:t>A &amp; B &lt;C&gt; &#35797;</w:t></w:p>');
    expect(paragraphs).toEqual(['A & B <C> 试']);
  });

  it('空 run 段落被跳过', () => {
    const paragraphs = extractParagraphsFromDocumentXml('<w:p></w:p><w:p><w:t>有内容</w:t></w:p>');
    expect(paragraphs).toEqual(['有内容']);
  });

  it('缺少 word/document.xml 抛出 docx_document_missing', () => {
    const archive = buildZip([{ name: 'other.txt', content: Buffer.from('x'), method: 0 }]);
    expect(() => readDocxText('x.docx', fakeFs(archive))).toThrowError('docx_document_missing');
  });

  it('非 zip 输入抛出 docx_zip_invalid', () => {
    expect(() => readDocxText('x.docx', fakeFs(Buffer.from('not a zip')))).toThrowError('docx_zip_invalid');
  });
});
