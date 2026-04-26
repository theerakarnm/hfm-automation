# Thai Font Guide for pdf-lib

Thai text requires custom font embedding because the 14 standard PDF fonts only support the WinAnsi (Latin) character set. This guide covers everything you need to get Thai text working in your PDFs.

## Why standard fonts fail

The standard Helvetica, Times Roman, and Courier fonts use WinAnsi encoding (Windows-1252), which supports about 218 characters — all Latin. Thai characters are in the Unicode range U+0E00–U+0E7F and are completely unsupported.

When you try `page.drawText('สวัสดี', { font: helveticaFont })`, you'll get:

```
Error: WinAnsi cannot encode "ส" (0x0e2a)
```

## Setup

### Install dependencies

```bash
npm install pdf-lib @pdf-lib/fontkit
# or
bun add pdf-lib @pdf-lib/fontkit
```

### Register fontkit before embedding custom fonts

```ts
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const pdfDoc = await PDFDocument.create();
pdfDoc.registerFontkit(fontkit);
```

You must call `registerFontkit` before any `embedFont` call with custom font bytes. If you forget, you'll get an error about fontkit not being registered.

## Choosing a Thai font

### Recommended fonts

| Font | Style | Notes |
|------|-------|-------|
| **Sarabun** | Modern, readable | Official Thai government font. Excellent screen and print quality. Free. |
| **Noto Sans Thai** | Clean, modern | Google font. Excellent Unicode coverage. Free. |
| **Noto Serif Thai** | Traditional, serif | Google font. Good for formal documents. Free. |
| **TH Sarabun New** | Classic | Widely used in Thailand. Comes pre-installed on Thai Windows. |
| **Prompt** | Rounded, friendly | Google font. Good for headings. Free. |

For receipts and invoices, **Sarabun** is the best choice — it's readable at small sizes (8-10pt) and is the standard for Thai government documents.

### Font file requirements

- Format: **TrueType (.ttf)** or **OpenType (.otf)**
- NOT supported: WOFF, WOFF2, EOT — convert these first
- You need both regular and bold variants for styled documents

### Where to get Thai fonts

- **Sarabun**: [Google Fonts](https://fonts.google.com/specimen/Sarabun) or [Thai government distribution](https://www.f0nt.com/release/sarabun/)
- **Noto Sans Thai**: [Google Fonts](https://fonts.google.com/noto/specimen/Noto+Sans+Thai)
- **Prompt**: [Google Fonts](https://fonts.google.com/specimen/Prompt)

### Downloading from Google Fonts

```bash
# Download Sarabun font files
curl -L "https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-Regular.ttf" -o Sarabun-Regular.ttf
curl -L "https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-Bold.ttf" -o Sarabun-Bold.ttf
curl -L "https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-Italic.ttf" -o Sarabun-Italic.ttf
curl -L "https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-BoldItalic.ttf" -o Sarabun-BoldItalic.ttf
```

## Complete example

```ts
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync, writeFileSync } from 'fs';

async function createThaiReceipt() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // Load Thai fonts
  const sarabunBytes = readFileSync('./fonts/Sarabun-Regular.ttf');
  const sarabunBoldBytes = readFileSync('./fonts/Sarabun-Bold.ttf');

  const font = await pdfDoc.embedFont(sarabunBytes, { subset: true });
  const boldFont = await pdfDoc.embedFont(sarabunBoldBytes, { subset: true });

  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();

  let y = height - 50;

  // Header
  page.drawText('บัดดี้ กลาส', { x: 50, y, size: 20, font: boldFont });
  y -= 30;
  page.drawText('ใบเสร็จรับเงิน / Receipt', { x: 50, y, size: 14, font: boldFont });
  y -= 30;

  // Customer info
  page.drawText('ชื่อลูกค้า: นายสมชาย ใจดี', { x: 50, y, size: 10, font });
  y -= 15;
  page.drawText('เลขประจำตัวผู้เสียภาษี: 1234567890123', { x: 50, y, size: 10, font });
  y -= 15;
  page.drawText('วันที่: 2026-04-23', { x: 50, y, size: 10, font });
  y -= 25;

  // Line items
  const items = [
    { desc: 'เลนส์สายตา - สายตาขวา (OD) -2.00', qty: 1, price: 1500 },
    { desc: 'เลนส์สายตา - สายตาซ้าย (OS) -1.75', qty: 1, price: 1500 },
    { desc: 'กรอบแว่น Ray-Ban', qty: 1, price: 3500 },
  ];

  for (const item of items) {
    page.drawText(item.desc, { x: 50, y, size: 9, font });
    const priceStr = `${item.price.toFixed(2)}`;
    const pw = font.widthOfTextAtSize(priceStr, 9);
    page.drawText(priceStr, { x: 500 - pw, y, size: 9, font });
    y -= 15;
  }

  // Total
  const total = items.reduce((sum, i) => sum + i.price, 0);
  y -= 10;
  page.drawLine({
    start: { x: 400, y },
    end: { x: 500, y },
    thickness: 0.5,
    color: rgb(0, 0, 0),
  });
  y -= 15;
  const totalStr = total.toFixed(2);
  const tw = boldFont.widthOfTextAtSize(totalStr, 11);
  page.drawText('ยอดรวม', { x: 400, y, size: 11, font: boldFont });
  page.drawText(totalStr, { x: 500 - tw, y, size: 11, font: boldFont });

  // Save
  const pdfBytes = await pdfDoc.save();
  writeFileSync('receipt.pdf', pdfBytes);
}
```

## Common issues and solutions

### Issue: "WinAnsi cannot encode" error

**Cause**: Using a standard font with Thai text.

**Fix**: Embed a custom Thai font with `@pdf-lib/fontkit`.

### Issue: Thai characters show as boxes or blank

**Cause**: The embedded font doesn't have Thai glyphs, or you forgot to call `updateFieldAppearances` for form fields.

**Fix**: 
1. Verify your .ttf file contains Thai glyphs (open it in a font viewer)
2. For form fields: `form.updateFieldAppearances(thaiFont)`

### Issue: Text appears misaligned

**Cause**: Thai text has complex rendering — combining characters, vowel signs above/below, tone marks. The width measurement may not perfectly account for these.

**Fix**: Use generous column widths and left-align Thai text. Right-alignment works but may look slightly off with complex character combinations. Test with realistic data.

### Issue: PDF file is too large

**Cause**: Full font embedding includes thousands of glyphs.

**Fix**: Use font subsetting:
```ts
const font = await pdfDoc.embedFont(fontBytes, { subset: true });
```

**Caveat**: Subset fonts can't reliably measure text for characters not yet drawn. If you need measurement + subsetting, measure first with a non-subsetted font, then create a subsetted one for drawing.

### Issue: Mixing Thai and Latin text

**Solution**: Thai fonts from reputable sources (Sarabun, Noto Sans Thai) include Latin glyphs. You don't need to switch fonts for numbers and basic English text. However, if you want a specific Latin font for numbers/English, you'll need to split the text and position each segment separately.

### Issue: Font not found on server

**Solution**: Bundle font files with your application. Don't rely on system fonts. In a Docker/Bun deployment, system fonts may not be available.

```ts
// Good: bundle with app
const fontBytes = readFileSync('./assets/fonts/Sarabun-Regular.ttf');

// Bad: rely on system path
const fontBytes = readFileSync('/System/Library/Fonts/...'); // won't work in production
```

## Font subsetting and measurement interaction

The interaction between subsetting and measurement is subtle:

1. **Without subsetting**: All glyphs available, `widthOfTextAtSize` works for any character in the font. Larger file size.

2. **With subsetting**: Only glyphs used in `drawText` calls are embedded. `widthOfTextAtSize` works for characters already drawn but may not work for un-drawn characters. Smaller file size.

3. **Practical approach for receipts**: You know the character set in advance (Thai digits, currency symbols, common Thai words). Draw all content first, then the subset will include everything. If you need to measure before drawing (for layout), use a non-subsetted font for measurement only.

```ts
// Measurement font (not subsetted)
const measureFont = await pdfDoc.embedFont(fontBytes);
const textWidth = measureFont.measureFont.widthOfTextAtSize('ยอดรวม', 10);

// Drawing font (subsetted)  
const drawFont = await pdfDoc.embedFont(fontBytes, { subset: true });
page.drawText('ยอดรวม', { x: 50, y: 100, size: 10, font: drawFont });
```

Note: Both fonts will be embedded in the PDF, so this increases file size. For most use cases, simply not subsetting is fine unless you're generating many documents with small subsets of Thai characters.

## Thai number formatting

Thai uses the Baht (฿) currency. Format numbers with 2 decimal places:

```ts
function formatBaht(amount: number): string {
  return amount.toFixed(2);
}

// In PDFs, use the ฿ symbol or "บาท" text
page.drawText(`${formatBaht(1500)} บาท`, { x: 400, y, size: 10, font: thaiFont });
```

For Thai-style money text (one thousand five hundred baht), you'd need a separate number-to-Thai-text conversion function — that's outside pdf-lib's scope but worth noting for complete invoice/receipt requirements.
