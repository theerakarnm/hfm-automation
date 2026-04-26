# pdf-lib API Quick Reference

## PDFDocument

### Static methods

```ts
PDFDocument.create(): Promise<PDFDocument>
PDFDocument.load(bytes: Uint8Array | ArrayBuffer, options?: LoadOptions): Promise<PDFDocument>
```

### LoadOptions

```ts
interface LoadOptions {
  ignoreEncryption?: boolean;    // default: false
  updateMetadata?: boolean;      // default: true
  password?: string;             // for encrypted docs
}
```

### Instance methods — Pages

```ts
pdfDoc.addPage(pageSize?: [number, number]): PDFPage
pdfDoc.insertPage(index: number, page: PDFPage): PDFPage
pdfDoc.removePage(index: number): void
pdfDoc.getPages(): PDFPage[]
pdfDoc.getPageCount(): number
pdfDoc.getPage(index: number): PDFPage
```

### Instance methods — Fonts

```ts
pdfDoc.embedFont(font: StandardFonts | Uint8Array | ArrayBuffer, options?: EmbedFontOptions): Promise<PDFFont>
pdfDoc.registerFontkit(fontkit: unknown): void
```

```ts
interface EmbedFontOptions {
  subset?: boolean;       // default: false
  customName?: string;    // override font name in PDF
}
```

### Instance methods — Images

```ts
pdfDoc.embedPng(png: Uint8Array | ArrayBuffer): Promise<PDFImage>
pdfDoc.embedJpg(jpg: Uint8Array | ArrayBuffer): Promise<PDFImage>
```

### Instance methods — Embedding PDFs

```ts
pdfDoc.embedPdf(pdf: Uint8Array | ArrayBuffer | PDFDocument, indices?: number[]): Promise<EmbeddedPage[]>
pdfDoc.embedPage(page: PDFPage, boundingBox?: { left: number; bottom: number; right: number; top: number }): Promise<EmbeddedPage>
```

### Instance methods — Copying pages

```ts
pdfDoc.copyPages(srcDoc: PDFDocument, indices: number[]): Promise<PDFPage[]>
```

### Instance methods — Forms

```ts
pdfDoc.getForm(): PDFForm
```

### Instance methods — Metadata

```ts
pdfDoc.getTitle(): string | undefined
pdfDoc.setTitle(title: string): void
pdfDoc.getAuthor(): string | undefined
pdfDoc.setAuthor(author: string): void
pdfDoc.getSubject(): string | undefined
pdfDoc.setSubject(subject: string): void
pdfDoc.getKeywords(): string | undefined
pdfDoc.setKeywords(keywords: string[]): void
pdfDoc.getCreator(): string | undefined
pdfDoc.setCreator(creator: string): void
pdfDoc.getProducer(): string | undefined
pdfDoc.setProducer(producer: string): void
pdfDoc.getCreationDate(): Date | undefined
pdfDoc.setCreationDate(date: Date): void
pdfDoc.getModificationDate(): Date | undefined
pdfDoc.setModificationDate(date: Date): void
```

### Instance methods — Attachments

```ts
pdfDoc.attach(bytes: Uint8Array | ArrayBuffer, name: string, options?: AttachmentOptions): Promise<void>
```

```ts
interface AttachmentOptions {
  mimeType?: string;
  description?: string;
  creationDate?: Date;
  modificationDate?: Date;
}
```

### Save

```ts
pdfDoc.save(options?: SaveOptions): Promise<Uint8Array>
```

```ts
interface SaveOptions {
  useObjectStreams?: boolean;   // default: true
  addDefaultPage?: boolean;     // default: true
  objectsPerTick?: number;      // default: 50
}
```

---

## PDFPage

### Getting dimensions

```ts
page.getSize(): { width: number; height: number }
page.getWidth(): number
page.getHeight(): number
page.setSize(width: number, height: number): void
```

### Drawing

```ts
page.drawText(text: string, options: TextOptions): void
page.drawImage(image: PDFImage | EmbeddedPage, options: ImageOptions): void
page.drawRectangle(options: RectangleOptions): void
page.drawLine(options: LineOptions): void
page.drawSvgPath(path: string, options?: SvgPathOptions): void
page.drawPage(page: EmbeddedPage, options?: PageDrawOptions): void
```

### TextOptions

```ts
interface TextOptions {
  x: number;
  y: number;
  size: number;
  font: PDFFont;
  color?: RGB;              // default: rgb(0, 0, 0)
  rotate?: degrees;         // default: degrees(0)
  opacity?: number;         // 0-1, default: 1
  maxWidth?: number;        // wrap text at this width
  wordBreaks?: string[];    // default: [' ']
  lineHeight?: number;      // for multi-line text
}
```

### RectangleOptions

```ts
interface RectangleOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  color?: RGB;
  borderColor?: RGB;
  borderWidth?: number;     // default: 1
  opacity?: number;
  borderOpacity?: number;
  rotate?: degrees;
}
```

### LineOptions

```ts
interface LineOptions {
  start: { x: number; y: number };
  end: { x: number; y: number };
  thickness?: number;       // default: 1
  color?: RGB;              // default: rgb(0, 0, 0)
  dashArray?: number[];     // e.g., [5, 3] for dashed
  dashPhase?: number;
}
```

### ImageOptions

```ts
interface ImageOptions {
  x: number;
  y: number;
  width?: number;
  height?: number;
  opacity?: number;
  rotate?: degrees;
}
```

### SvgPathOptions

```ts
interface SvgPathOptions {
  x?: number;
  y?: number;
  scale?: number;
  color?: RGB;              // fill
  borderColor?: RGB;
  borderWidth?: number;
  opacity?: number;
  borderOpacity?: number;
  rotate?: degrees;
}
```

---

## PDFFont

### StandardFonts enum

```ts
enum StandardFonts {
  TimesRoman,
  TimesRomanBold,
  TimesRomanItalic,
  TimesRomanBoldItalic,
  Helvetica,
  HelveticaBold,
  HelveticaItalic,
  HelveticaBoldItalic,
  Courier,
  CourierBold,
  CourierItalic,
  CourierBoldItalic,
  ZapfDingbats,
  Symbol,
}
```

### Measurement methods

```ts
font.widthOfTextAtSize(text: string, size: number): number
font.heightAtSize(size: number, options?: { lineHeight?: number }): number
font.descentAtSize(size: number): number   // negative value
font.ascentAtSize(size: number): number
font.sizeAtHeight(height: number): number
```

---

## PDFImage

```ts
image.scale(factor: number): { width: number; height: number }
image.scaleToFit(maxWidth: number, maxHeight: number): { width: number; height: number }
image.width: number
image.height: number
```

---

## PDFForm

### Getting existing fields

```ts
form.getTextField(name: string): PDFTextField
form.getCheckBox(name: string): PDFCheckBox
form.getRadioGroup(name: string): PDFRadioGroup
form.getDropdown(name: string): PDFDropdown
form.getOptionList(name: string): PDFOptionList
form.getButton(name: string): PDFButton
```

### Creating new fields

```ts
form.createTextField(name: string): PDFTextField
form.createCheckBox(name: string): PDFCheckBox
form.createRadioGroup(name: string): PDFRadioGroup
form.createDropdown(name: string): PDFDropdown
form.createOptionList(name: string): PDFOptionList
form.createButton(name: string): PDFButton
```

### Utilities

```ts
form.getFields(): PDFField[]
form.getField(name: string): PDFField
form.flatten(): void
form.updateFieldAppearances(font?: PDFFont): void
```

### PDFTextField

```ts
textField.setText(text: string): void
textField.getText(): string
textField.setMaxLength(limit: number): void
textField.getMaxLength(): number | undefined
textField.removeMaxLength(): void
textField.addToPage(page: PDFPage, options?: { x: number; y: number; width: number; height: number; borderWidth?: number; borderColor?: RGB; color?: RGB; backgroundColor?: RGB; font?: PDFFont; fontSize?: number; rotate?: degrees }): void
```

### PDFCheckBox

```ts
checkbox.check(): void
checkbox.uncheck(): void
checkbox.isChecked(): boolean
checkbox.addToPage(page: PDFPage, options?: { x: number; y: number; width?: number; height?: number; borderWidth?: number; borderColor?: RGB; color?: RGB; backgroundColor?: RGB; rotate?: degrees }): void
```

### PDFRadioGroup

```ts
radioGroup.select(value: string): void
radioGroup.clear(): void
radioGroup.getSelected(): string | undefined
radioGroup.getOptions(): string[]
radioGroup.addOptionToPage(value: string, page: PDFPage, options?: { x: number; y: number; width?: number; height?: number; borderWidth?: number; borderColor?: RGB; color?: RGB; backgroundColor?: RGB; rotate?: degrees }): void
```

### PDFDropdown

```ts
dropdown.select(value: string): void
dropdown.clear(): void
dropdown.getSelected(): string | undefined
dropdown.getOptions(): string[]
dropdown.addOptions(options: string[]): void
dropdown.addToPage(page: PDFPage, options?: { x: number; y: number; width: number; height: number; borderWidth?: number; borderColor?: RGB; color?: RGB; backgroundColor?: RGB; font?: PDFFont; fontSize?: number; rotate?: degrees }): void
```

---

## Helper functions

```ts
rgb(r: number, g: number, b: number): RGB      // each 0-1
degrees(angle: number): { type: 'degrees'; angle: number }
```
