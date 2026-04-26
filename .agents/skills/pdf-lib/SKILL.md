---
name: pdf-lib
description: >
  Create and modify PDF documents in JavaScript using pdf-lib. Covers PDF creation,
  modification, form filling, Thai/Unicode font embedding, image embedding, page
  operations, SVG paths, and structured document generation (receipts, invoices, reports).
  Use this skill whenever the user mentions PDF generation, PDF manipulation, pdf-lib,
  receipt PDF, invoice PDF, document export to PDF, form filling, or needs to add text,
  images, or tables to a PDF — even if they don't explicitly say "pdf-lib". Also trigger
  when working with Thai text in PDFs, multi-page table layouts, or any server-side
  PDF rendering in Node/Bun/edge runtimes.
---

# pdf-lib Skill

pdf-lib is a pure JavaScript library for creating and modifying PDF documents. It works in every modern JS runtime — Node, Bun, browser, Deno, React Native — with zero native dependencies. Its key differentiator is the ability to **modify existing PDFs** (not just create new ones).

Read this file for the main workflow and patterns. For detailed API signatures, see `references/api-quick-ref.md`. For Thai font handling specifically, see `references/thai-font-guide.md`.

## Core Mental Model

A PDF in pdf-lib is a `PDFDocument` object. You either create one from scratch or load one from bytes. Pages are accessed individually, and all drawing operations happen on a `PDFPage` object. Fonts, images, and embedded PDF pages are resources attached to the document.

```
PDFDocument (the whole file)
  ├── Pages (ordered list of PDFPage objects)
  ├── Fonts (embedded via embedFont / embedStandardFont)
  ├── Images (embedded via embedPng / embedJpg)
  ├── Form (optional form fields)
  └── Catalog (metadata, viewer preferences)
```

The coordinate system places the **origin at the bottom-left** corner of each page. Y increases upward. This is the opposite of screen coordinates and catches many people off guard.

## Quick Start

### Creating a new PDF

```ts
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const pdfDoc = await PDFDocument.create();
const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
const page = pdfDoc.addPage([595.28, 841.89]); // A4

page.drawText('Hello World', {
  x: 50,
  y: page.getHeight() - 50, // near the top
  size: 12,
  font,
  color: rgb(0, 0, 0),
});

const pdfBytes = await pdfDoc.save();
```

### Loading and modifying an existing PDF

```ts
const existingBytes = await fs.readFile('input.pdf');
const pdfDoc = await PDFDocument.load(existingBytes);

const pages = pdfDoc.getPages();
pages[0].drawText('Added text', {
  x: 50,
  y: pages[0].getHeight() - 50,
  size: 12,
  font: await pdfDoc.embedFont(StandardFonts.Helvetica),
  color: rgb(1, 0, 0),
});

const modifiedBytes = await pdfDoc.save();
```

## Page Operations

```ts
// Add a blank page (default US Letter: 612 x 792)
const page = pdfDoc.addPage();

// Add with specific size (A4)
const a4Page = pdfDoc.addPage([595.28, 841.89]);

// Get all pages
const pages = pdfDoc.getPages();

// Insert at specific position
pdfDoc.insertPage(0, somePage);

// Remove a page
pdfDoc.removePage(2);

// Copy pages from another PDF
const [copiedPage] = await pdfDoc.copyPages(donorDoc, [0]);
pdfDoc.addPage(copiedPage);

// Get page dimensions
const { width, height } = page.getSize();

// Set page size
page.setSize(595.28, 841.89);
```

### Common page sizes (in points, 1 point = 1/72 inch)

| Size | Width | Height |
|------|-------|--------|
| A4 | 595.28 | 841.89 |
| A5 | 419.53 | 595.28 |
| Letter | 612 | 792 |
| Legal | 612 | 1008 |
| Thermal 80mm | 226.77 | varies |

For thermal receipt printers, calculate height dynamically based on content.

## Drawing Operations

All drawing happens on a `PDFPage` object. Each method returns the page for chaining.

### Text

```ts
page.drawText('Hello', {
  x: 50,
  y: height - 50,
  size: 12,
  font: embeddedFont,
  color: rgb(0, 0, 0),
  rotate: degrees(0),       // optional rotation
  opacity: 1,               // 0-1
  maxWidth: 200,            // wrap text
  wordBreaks: [' ', '-'],   // where to break words
  lineHeight: 14,           // for multi-line text
});
```

`drawText` does **not** support HTML or rich formatting. Each call draws a single string with uniform styling. To create a "paragraph" with mixed styling, calculate positions manually and call `drawText` multiple times.

For multi-line text, set `maxWidth` and `lineHeight` together. pdf-lib will break on spaces by default.

### Measuring text

Text measurement is essential for alignment, table layout, and determining if content fits.

```ts
const textWidth = font.widthOfTextAtSize('Hello World', 12);
const textHeight = font.heightAtSize(12);
const descent = font.descentAtSize(12); // negative value below baseline
```

When aligning text in columns or tables, use `widthOfTextAtSize` to compute exact positions. This is the only reliable way to right-align or center text:

```ts
const text = '1,234.56';
const textWidth = font.widthOfTextAtSize(text, fontSize);
const rightX = columnRight - textWidth;
page.drawText(text, { x: rightX, y: currentY, size: fontSize, font });
```

### Images

```ts
const pngImage = await pdfDoc.embedPng(pngBytes);
const jpgImage = await pdfDoc.embedJpg(jpgBytes);

page.drawImage(pngImage, {
  x: 50,
  y: height - 200,
  width: 150,
  height: 150,
  opacity: 1,
});

// Scale helpers
const scaled = pngImage.scale(0.5);   // 50% of original
const scaledTo = pngImage.scaleToFit(200, 200); // fit within bounds
```

Only PNG (with or without alpha) and JPEG are supported. No SVG images, WebP, or other formats — convert first.

### Rectangles and Lines

```ts
page.drawRectangle({
  x: 50,
  y: height - 100,
  width: 200,
  height: 50,
  borderColor: rgb(0, 0, 0),
  borderWidth: 1,
  color: rgb(0.9, 0.9, 0.9),  // fill
  opacity: 0.5,
  borderOpacity: 1,
  rotate: degrees(0),
});

page.drawLine({
  start: { x: 50, y: height - 100 },
  end: { x: 250, y: height - 100 },
  thickness: 1,
  color: rgb(0, 0, 0),
  dashArray: [5, 3],  // optional dashed line
  dashPhase: 0,
});
```

### SVG Paths

```ts
page.drawSvgPath('M 10,20 L 100,160 Q 130,200 150,120 C 190,-40 200,200 300,150', {
  x: 50,
  y: height - 50,
  borderColor: rgb(0, 0, 0),
  borderWidth: 1,
  color: rgb(1, 0, 0),  // fill color
  scale: 1,
});
```

## Font Handling

### Standard fonts (Latin only)

14 standard fonts are available without embedding any data. They only support the WinAnsi character set (~218 Latin characters). **No Thai, no CJK, no emoji.**

```ts
import { StandardFonts } from 'pdf-lib';

const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
const monoFont = await pdfDoc.embedFont(StandardFonts.Courier);
```

Available standard fonts: `TimesRoman`, `TimesRomanBold`, `TimesRomanItalic`, `TimesRomanBoldItalic`, `Helvetica`, `HelveticaBold`, `HelveticaItalic`, `HelveticaBoldItalic`, `Courier`, `CourierBold`, `CourierItalic`, `CourierBoldItalic`, `ZapfDingbats`, `Symbol`.

### Custom fonts (Thai, CJK, any Unicode)

For Thai or other non-Latin scripts, you **must** embed a custom font. This requires the `@pdf-lib/fontkit` package.

```ts
import fontkit from '@pdf-lib/fontkit';

pdfDoc.registerFontkit(fontkit);

const fontBytes = await fs.readFile('Sarabun-Regular.ttf');
const thaiFont = await pdfDoc.embedFont(fontBytes);

// Bold variant — load a separate file
const boldBytes = await fs.readFile('Sarabun-Bold.ttf');
const thaiBoldFont = await pdfDoc.embedFont(boldBytes);
```

**Font subsetting** reduces file size by embedding only used characters:

```ts
const thaiFont = await pdfDoc.embedFont(fontBytes, { subset: true });
```

Always use `subset: true` for custom fonts unless you need the full character set (e.g., user-input text that could contain any character).

When using subsetting, you **cannot** measure text for characters that haven't been drawn yet. Measure before subsetting, or don't subset if you need measurement of arbitrary text.

### Font encoding errors

If you try to draw a character that a font can't encode, pdf-lib throws. For example, Thai text with a standard font:

```
Error: WinAnsi cannot encode "ส" (0x0e2a)
```

This means you need to embed a custom font that supports those characters. See `references/thai-font-guide.md` for a complete walkthrough.

## Forms

### Creating form fields

```ts
const form = pdfDoc.getForm();

const textField = form.createTextField('customer.name');
textField.setText('สมชาย ใจดี');
textField.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });

const checkbox = form.createCheckBox('agree.terms');
checkbox.addToPage(page, { x: 50, y: 650 });
checkbox.check();

const radioGroup = form.createRadioGroup('payment.method');
radioGroup.addOptionToPage('cash', page, { x: 50, y: 600 });
radioGroup.addOptionToPage('transfer', page, { x: 50, y: 580 });
radioGroup.select('cash');

const dropdown = form.createDropdown('branch');
dropdown.addOptions(['BUDDY01', 'BUDDY02', 'NTP01']);
dropdown.select('BUDDY01');
dropdown.addToPage(page, { x: 50, y: 550, width: 150, height: 20 });
```

### Filling existing form fields

```ts
const form = pdfDoc.getForm();
form.getTextField('customer_name').setText('สมชาย');
form.getCheckBox('terms').check();
form.getRadioGroup('payment').select('cash');
form.getDropdown('branch').select('BUDDY01');
```

### Flattening forms

Flattening converts form fields into static content so they can't be edited:

```ts
form.flatten();
```

### Custom fonts in form fields

Form fields default to Helvetica (Latin only). For Thai text in form fields, you must update field appearances with a custom font:

```ts
pdfDoc.registerFontkit(fontkit);
const thaiFont = await pdfDoc.embedFont(thaiFontBytes);
form.getTextField('customer_name').setText('สมชาย');
form.updateFieldAppearances(thaiFont);
```

Without `updateFieldAppearances`, the text will be stored but may display incorrectly or throw when saving.

## Receipt / Invoice Pattern

This is the most common structured document pattern. Here's the approach:

### Layout strategy

1. **Define margins and spacing constants** at the top of your function
2. **Track a `currentY` cursor** starting from the top margin, moving downward
3. **Helper functions** for each section (header, customer info, line items, totals)
4. **Page overflow check** before each section — if `currentY < bottomMargin`, add a new page

### Line item table with pagination

```ts
interface LineItem {
  description: string;
  rightEye: string;
  leftEye: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

function drawLineItemsTable(
  page: PDFPage,
  items: LineItem[],
  startY: number,
  font: PDFFont,
  boldFont: PDFFont,
): number {
  let y = startY;
  const leftMargin = 40;
  const rowHeight = 20;
  const columns = {
    description: leftMargin,
    rightEye: leftMargin + 140,
    leftEye: leftMargin + 190,
    qty: leftMargin + 240,
    total: leftMargin + 290,
  };

  // Header row
  page.drawRectangle({
    x: leftMargin, y: y - rowHeight, width: 340, height: rowHeight,
    color: rgb(0.9, 0.9, 0.9),
  });
  page.drawText('รายการ', { x: columns.description, y: y - 15, size: 9, font: boldFont });
  page.drawText('OD', { x: columns.rightEye, y: y - 15, size: 9, font: boldFont });
  page.drawText('OS', { x: columns.leftEye, y: y - 15, size: 9, font: boldFont });
  page.drawText('จำนวน', { x: columns.qty, y: y - 15, size: 9, font: boldFont });
  page.drawText('ยอดรวม', { x: columns.total, y: y - 15, size: 9, font: boldFont });
  y -= rowHeight;

  for (const item of items) {
    page.drawText(item.description, { x: columns.description, y: y - 15, size: 9, font });
    page.drawText(item.rightEye, { x: columns.rightEye, y: y - 15, size: 9, font });
    page.drawText(item.leftEye, { x: columns.leftEye, y: y - 15, size: 9, font });
    page.drawText(String(item.quantity), { x: columns.qty, y: y - 15, size: 9, font });

    const totalStr = item.total.toFixed(2);
    const totalWidth = font.widthOfTextAtSize(totalStr, 9);
    page.drawText(totalStr, {
      x: columns.total + 60 - totalWidth, // right-align
      y: y - 15, size: 9, font,
    });
    y -= rowHeight;
  }

  return y;
}
```

### Totals section

```ts
function drawTotals(
  page: PDFPage,
  subtotal: number,
  discountLabel: string,
  discountAmount: number,
  vatAmount: number,
  grandTotal: number,
  startY: number,
  font: PDFFont,
  boldFont: PDFFont,
): number {
  let y = startY;
  const labelX = 290;
  const valueX = 370;
  const fontSize = 9;

  const rows = [
    ['Subtotal', subtotal.toFixed(2)],
    [discountLabel, `-${discountAmount.toFixed(2)}`],
    ['VAT', vatAmount.toFixed(2)],
  ];

  for (const [label, value] of rows) {
    page.drawText(label, { x: labelX, y, size: fontSize, font });
    const vw = font.widthOfTextAtSize(value, fontSize);
    page.drawText(value, { x: valueX + 60 - vw, y, size: fontSize, font });
    y -= 15;
  }

  // Grand total with emphasis
  page.drawLine({
    start: { x: labelX, y: y + 5 },
    end: { x: valueX + 60, y: y + 5 },
    thickness: 1,
    color: rgb(0, 0, 0),
  });

  const gtStr = grandTotal.toFixed(2);
  page.drawText('Grand Total', { x: labelX, y: y - 10, size: 11, font: boldFont });
  const gtw = boldFont.widthOfTextAtSize(gtStr, 11);
  page.drawText(gtStr, { x: valueX + 60 - gtw, y: y - 10, size: 11, font: boldFont });

  return y - 25;
}
```

### Multi-page continuation

```ts
function drawReceipt(pdfDoc: PDFDocument, data: ReceiptData, thaiFont: PDFFont, thaiBoldFont: PDFFont): Uint8Array {
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const topMargin = 50;
  const bottomMargin = 50;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let currentY = pageHeight - topMargin;

  function ensureSpace(needed: number) {
    if (currentY - needed < bottomMargin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      currentY = pageHeight - topMargin;
    }
  }

  // Draw header
  currentY = drawHeader(page, data, currentY, thaiBoldFont);

  // Draw line items with page breaks
  const itemsPerPage = Math.floor((currentY - bottomMargin) / 20) - 2;
  for (let i = 0; i < data.items.length; i += itemsPerPage) {
    ensureSpace(itemsPerPage * 20 + 20);
    const chunk = data.items.slice(i, i + itemsPerPage);
    currentY = drawLineItemsTable(page, chunk, currentY, thaiFont, thaiBoldFont);
  }

  // Draw totals
  ensureSpace(100);
  currentY = drawTotals(page, ...args);

  return pdfDoc.save();
}
```

## Document Metadata

```ts
pdfDoc.setTitle('ใบเสร็จรับเงิน BUDDY01-00012');
pdfDoc.setAuthor('Buddy Glass');
pdfDoc.setSubject('Receipt');
pdfDoc.setKeywords(['receipt', 'BUDDY01']);
pdfDoc.setCreator('Buddy Glass POS');
pdfDoc.setCreationDate(new Date());
pdfDoc.setModificationDate(new Date());
```

Reading metadata from existing PDFs (pass `{ updateMetadata: false }` to `load` to preserve originals):

```ts
const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
pdfDoc.getTitle();
pdfDoc.getAuthor();
pdfDoc.getCreationDate();
```

## Embedding PDF Pages

You can embed pages from other PDFs as images — useful for letterheads, watermarks, or stitching documents:

```ts
const [embeddedPage] = await pdfDoc.embedPdf(donorBytes);
// or embed specific page: await pdfDoc.embedPdf(donorBytes, [2])
// or from loaded doc: await pdfDoc.embedPage(donorDoc.getPages()[0])

const dims = embeddedPage.scale(0.5);
page.drawPage(embeddedPage, {
  x: 50,
  y: 50,
  width: dims.width,
  height: dims.height,
});
```

To embed with clipping (show only part of a page):

```ts
const clipped = await pdfDoc.embedPage(donorPage, {
  left: 55, bottom: 485, right: 300, top: 575,
});
```

## Attachments

```ts
await pdfDoc.attach(fileBytes, 'filename.pdf', {
  mimeType: 'application/pdf',
  description: 'Description of the attachment',
  creationDate: new Date(),
  modificationDate: new Date(),
});
```

## Common Gotchas

### Coordinate system

The origin (0, 0) is at the **bottom-left**. Y increases upward. When you think "put this at the top", you need `page.getHeight() - offset`. This is the single most common source of bugs.

### Standard fonts don't support Thai

If you see `WinAnsi cannot encode "X"`, you're using a standard font with non-Latin text. Switch to a custom embedded font.

### Font measurement and subsetting

When you use `{ subset: true }`, only characters that appear in `drawText` calls are embedded. This means `widthOfTextAtSize` may fail for characters you haven't drawn yet. If you need to measure arbitrary text (e.g., user input for layout), don't subset, or measure with a non-subsetted font and then create a subsetted one for drawing.

### No text extraction or editing

pdf-lib cannot extract or edit existing text on a page. It can only read/write form field values. To "edit" text, you'd need to overlay a white rectangle and draw new text on top — a fragile approach.

### No encryption support

pdf-lib throws `EncryptedPDFError` when loading encrypted PDFs. You can pass `{ ignoreEncryption: true }` to load anyway, but modifications may fail unpredictably.

### Image format limitations

Only PNG and JPEG are supported. Convert other formats before embedding. For PNGs with transparency, use `embedPng` — it preserves the alpha channel.

### Font file formats

Only TrueType (.ttf) and OpenType (.otf) fonts are supported. No WOFF/WOFF2 — convert first.

### Memory considerations

Large PDFs are fully loaded into memory. For documents with many pages or large images, be mindful of memory usage in server environments.

## Reusable Script

A complete receipt PDF generator script is available at `scripts/generate-receipt-pdf.ts`. It demonstrates the full pattern: Thai font embedding, line item table, totals with VAT, and running number. Use it as a starting point for your receipt/invoice generation.

## When to read reference files

- **`references/api-quick-ref.md`** — Read when you need to look up exact method signatures, parameter types, or return types
- **`references/thai-font-guide.md`** — Read when working with Thai text, choosing fonts, or troubleshooting encoding errors
