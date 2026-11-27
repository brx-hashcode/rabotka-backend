import { DOCX_LIMITS, isSafeDocx } from '../docx-guard.util';
import { buildZip, minimalDocx } from './zip-fixture';

const small = {
  ...DOCX_LIMITS,
  maxXmlPartBytes: 1000,
  maxXmlTotalBytes: 1500,
  maxTotalBytes: 4000,
};

describe('isSafeDocx', () => {
  it('accepts an ordinary Word file', () => {
    expect(isSafeDocx(minimalDocx())).toBe(true);
  });

  it('refuses a few kilobytes that inflate to megabytes of XML', () => {
    const bomb = buildZip({
      'word/document.xml': 'a'.repeat(10 * 1024 * 1024),
    });
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(isSafeDocx(bomb)).toBe(false);
  });

  it('measures what an entry inflates to, not what it declares', () => {
    const zip = buildZip({ 'word/document.xml': 'a'.repeat(2000) });
    // Lie in both headers: claim 10 bytes.
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, central + 24);
    zip.writeUInt32LE(10, 22);
    expect(isSafeDocx(zip, small)).toBe(false);
  });

  it('bounds one XML part, all XML parts and the whole file', () => {
    expect(isSafeDocx(buildZip({ 'a.xml': 'a'.repeat(900) }), small)).toBe(
      true,
    );
    expect(isSafeDocx(buildZip({ 'a.xml': 'a'.repeat(1001) }), small)).toBe(
      false,
    );
    expect(
      isSafeDocx(
        buildZip({ 'a.xml': 'a'.repeat(900), 'b.rels': 'b'.repeat(900) }),
        small,
      ),
    ).toBe(false);
    // Media may be larger than an XML part, within the total.
    expect(
      isSafeDocx(buildZip({ 'word/media/p.png': 'p'.repeat(3000) }), small),
    ).toBe(true);
    expect(
      isSafeDocx(
        buildZip({ 'm1.png': 'p'.repeat(3000), 'm2.png': 'p'.repeat(1001) }),
        small,
      ),
    ).toBe(false);
    // Stored entries count too.
    expect(
      isSafeDocx(buildZip({ 'a.xml': 'a'.repeat(1001) }, ['a.xml']), small),
    ).toBe(false);
  });

  it('refuses too many entries', () => {
    const files = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`f${i}.png`, 'x']),
    );
    expect(isSafeDocx(buildZip(files), { ...small, maxEntries: 10 })).toBe(
      false,
    );
  });

  it('refuses what is not a readable zip', () => {
    expect(
      isSafeDocx(Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(30).fill(0)])),
    ).toBe(false);
    expect(isSafeDocx(Buffer.alloc(0))).toBe(false);
    const truncated = minimalDocx();
    expect(isSafeDocx(truncated.subarray(0, truncated.length - 30))).toBe(
      false,
    );
  });
});
